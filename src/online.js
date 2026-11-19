// Cotação online nas transportadoras: junta os conectores de src/apis/, guarda a configuração
// (integrações ativas, empresa remetente) e registra todas as consultas em api_consultas.
import { so, slug, lerJSONSecret, tipoDoErro, CEP_ORIGEM_PADRAO, normalizarPedido, validarPedido, comTempoLimite } from './apis/comum.js';
import { lerCredenciais, CAMPOS } from './credenciais.js';
import * as braspress from './apis/braspress.js';
import * as ssw from './apis/ssw.js';
import * as saomiguel from './apis/saomiguel.js';

// Para incluir uma transportadora nova: criar src/apis/<nome>.js e acrescentar aqui.
export const CONECTORES = [braspress, ssw, saomiguel];
const TEMPO_LIMITE_MS = 15000;

export const SCHEMA_ONLINE = `
CREATE TABLE IF NOT EXISTS app_config (chave TEXT PRIMARY KEY, valor JSONB, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(), atualizado_por TEXT);
CREATE TABLE IF NOT EXISTS cnpj_cadastro (
  cnpj TEXT PRIMARY KEY, razao_social TEXT, fantasia TEXT, cidade TEXT, uf TEXT, cep TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_consultas (
  id               BIGSERIAL PRIMARY KEY,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario          TEXT,
  integracao       TEXT NOT NULL,
  transportadora   TEXT,
  chave            TEXT NOT NULL,
  cnpj_remetente   TEXT,
  cep_destino      TEXT,
  peso             NUMERIC(12,3),
  volumes          INTEGER,
  valor_mercadoria NUMERIC(14,2),
  requisicao       JSONB,
  resposta         JSONB,
  id_cotacao       TEXT,
  total            NUMERIC(14,2),
  prazo            INTEGER,
  erro             TEXT,
  ms               INTEGER,
  teste            BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS api_consultas_chave_idx ON api_consultas (integracao, chave, criado_em DESC);
CREATE INDEX IF NOT EXISTS api_consultas_data_idx ON api_consultas (integracao, criado_em DESC);
`;

// Consultas e cadastros da versão anterior (só Braspress) passam para as tabelas novas, uma vez.
export const MIGRAR_ONLINE = `
DO $$ BEGIN
  IF to_regclass('braspress_contas') IS NOT NULL THEN
    INSERT INTO cnpj_cadastro (cnpj, razao_social, fantasia, cidade, uf, cep)
      SELECT cnpj, razao_social, fantasia, cidade, uf, cep FROM braspress_contas ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('braspress_cotacoes') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_consultas WHERE integracao = 'braspress') THEN
    INSERT INTO api_consultas (criado_em, usuario, integracao, transportadora, chave, cnpj_remetente, cep_destino, peso, volumes,
                               valor_mercadoria, requisicao, resposta, id_cotacao, total, prazo, erro)
      SELECT criado_em, usuario, 'braspress', 'Braspress', 'v1:' || chave, cnpj_remetente, cep_destino, peso, volumes,
             valor_mercadoria, requisicao, resposta, id_braspress, total, prazo, erro FROM braspress_cotacoes;
  END IF;
END $$;
`;

// Integrações configuradas: credenciais cadastradas na tela (banco, criptografadas) + secrets antigos do
// Cloudflare. Quando a mesma entrada existe nos dois, vale a da tela.
const SECRET_DO_TIPO = { ssw: 'SSW_TRANSPORTADORAS', braspress: 'BRASPRESS_CONTAS', saomiguel: 'SAOMIGUEL_CONTAS' };
export async function todasIntegracoes(env, db) {
  const cred = db ? await lerCredenciais(env, db) : {};
  const L = [];
  for (const c of CONECTORES) {
    const nome = SECRET_DO_TIPO[c.tipo], def = CAMPOS[c.tipo];
    const doBanco = (cred[c.tipo] && cred[c.tipo].lista) || [];
    let doSecret = [];
    try { doSecret = lerJSONSecret(env, nome); } catch (e) { L.push({ id: c.tipo, tipo: c.tipo, transportadora: c.tipo, erroConfig: e.message }); continue; }
    const k = (x) => String(x[def.chave] || '').replace(/[.\/-]/g, '').trim().toLowerCase();
    const juntos = [...doBanco, ...doSecret.filter((x) => !doBanco.some((y) => k(y) === k(x)))];
    try {
      L.push(...c.integracoes({ [nome]: JSON.stringify(juntos) }).map((i) => ({ ...i,
        origem: c.tipo !== 'ssw' ? (doBanco.length ? (doSecret.length ? 'tela e Cloudflare' : 'tela') : 'Cloudflare')
          : (doBanco.some((x) => i.id === 'ssw-' + slug(x.id || x.transportadora)) ? 'tela' : 'Cloudflare') })));
    } catch (e) { L.push({ id: c.tipo, tipo: c.tipo, transportadora: c.tipo, erroConfig: e.message }); }
    if (cred[c.tipo] && cred[c.tipo].erro) L.push({ id: c.tipo + '-credenciais', tipo: c.tipo, transportadora: def.nome, erroConfig: cred[c.tipo].erro });
  }
  return L;
}
const conector = (tipo) => CONECTORES.find((c) => c.tipo === tipo);

async function lerConfig(db, chave, padrao = null) {
  const r = await db.query('SELECT valor FROM app_config WHERE chave = $1', [chave]);
  return r.rows.length ? r.rows[0].valor : padrao;
}
async function gravarConfig(db, chave, valor, usuario) {
  await db.query(`INSERT INTO app_config (chave, valor, atualizado_por) VALUES ($1, $2, $3)
                  ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = now(), atualizado_por = $3`, [chave, JSON.stringify(valor), usuario]);
}

// Cadastro do CNPJ (nome, cidade, CEP) em serviços públicos, um após o outro.
async function consultarCnpj(cnpj, fetchImpl) {
  const fontes = [
    [`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, (j) => ({ razao_social: j.razao_social, fantasia: j.nome_fantasia, cidade: j.municipio, uf: j.uf, cep: j.cep })],
    [`https://publica.cnpj.ws/cnpj/${cnpj}`, (j) => { const e = j.estabelecimento || {};
      return { razao_social: j.razao_social, fantasia: e.nome_fantasia, cidade: e.cidade && e.cidade.nome, uf: e.estado && e.estado.sigla, cep: e.cep }; }],
    [`https://receitaws.com.br/v1/cnpj/${cnpj}`, (j) => (j.status === 'ERROR' ? {} : { razao_social: j.nome, fantasia: j.fantasia, cidade: j.municipio, uf: j.uf, cep: j.cep })],
  ];
  for (const [url, ler] of fontes) {
    try {
      const resp = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'gestaofrete-proloplast/1.0' } });
      if (!resp.ok) continue;
      const x = ler(await resp.json());
      if (so(x.cep).length === 8) return { cnpj, razao_social: x.razao_social || null, fantasia: x.fantasia || null, cidade: x.cidade || null, uf: x.uf || null, cep: so(x.cep) };
    } catch { /* tenta a próxima fonte */ }
  }
  return null;
}

// CNPJs da empresa (os que aparecem nas credenciais das integrações), com o cadastro de cada um.
export async function remetentes(env, db, fetchImpl = fetch) {
  const cnpjs = [...new Set((await todasIntegracoes(env, db)).flatMap((i) => i.cnpjs || []))];
  if (!cnpjs.length) return [];
  const r = await db.query('SELECT * FROM cnpj_cadastro WHERE cnpj = ANY($1::text[])', [cnpjs]);
  const cad = Object.fromEntries(r.rows.map((x) => [x.cnpj, x]));
  for (const c of cnpjs) {
    if (cad[c] && cad[c].cep) continue;
    const linha = await consultarCnpj(c, fetchImpl);
    if (!linha) continue;
    await db.query(`INSERT INTO cnpj_cadastro (cnpj, razao_social, fantasia, cidade, uf, cep) VALUES ($1,$2,$3,$4,$5,$6)
                    ON CONFLICT (cnpj) DO UPDATE SET razao_social=$2, fantasia=$3, cidade=$4, uf=$5, cep=$6, atualizado_em=now()`,
    [linha.cnpj, linha.razao_social, linha.fantasia, linha.cidade, linha.uf, linha.cep]);
    cad[c] = linha;
  }
  return cnpjs.map((c) => ({ cnpj: c, nome: (cad[c] && (cad[c].fantasia || cad[c].razao_social)) || null,
    razao_social: (cad[c] && cad[c].razao_social) || null, cidade: (cad[c] && cad[c].cidade) || null, uf: (cad[c] && cad[c].uf) || null,
    cep: (cad[c] && cad[c].cep) || null }));
}

// Empresa remetente em uso: a configurada em Configurações; senão a de Nova Santa Rita; senão a primeira.
export async function remetenteAtual(env, db, fetchImpl = fetch) {
  const L = await remetentes(env, db, fetchImpl);
  const cfg = (await lerConfig(db, 'remetente')) || {};
  const r = L.find((x) => x.cnpj === so(cfg.cnpj)) || L.find((x) => /NOVA SANTA RITA/i.test(x.cidade || '')) || L[0] || { cnpj: so(cfg.cnpj) || null };
  const cep = so(cfg.cep) || so(env.CEP_ORIGEM) || r.cep || CEP_ORIGEM_PADRAO;
  return { ...r, cep, cepPresumido: !so(cfg.cep) && !so(env.CEP_ORIGEM) && !r.cep, configurado: !!cfg.cnpj };
}

export async function configuracao(env, db, fetchImpl = fetch) {
  return { remetente: await remetenteAtual(env, db, fetchImpl), remetentes: await remetentes(env, db, fetchImpl),
    cfg: (await lerConfig(db, 'remetente')) || {} };
}
export async function salvarConfiguracao(db, c, usuario) {
  await gravarConfig(db, 'remetente', { cnpj: so(c.cnpj) || null, cep: so(c.cep) || null }, usuario);
}

async function estadoIntegracoes(db) { return (await lerConfig(db, 'integracoes')) || {}; }
export async function ativarIntegracao(env, db, id, ativa, usuario) {
  if (!(await todasIntegracoes(env, db)).some((i) => i.id === id)) throw Object.assign(new Error('Integração não encontrada.'), { status: 404 });
  const e = await estadoIntegracoes(db);
  e[id] = { ...(e[id] || {}), ativa: !!ativa };
  await gravarConfig(db, 'integracoes', e, usuario);
}

async function registrar(db, integ, req, chave, usuario, r, ms, teste) {
  await db.query(
    `INSERT INTO api_consultas (usuario, integracao, transportadora, chave, cnpj_remetente, cep_destino, peso, volumes, valor_mercadoria,
                                requisicao, resposta, id_cotacao, total, prazo, erro, ms, teste)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [usuario, integ.id, integ.transportadora, chave, req.cnpjRemetente, req.cepDestino, req.peso, req.volumes, req.valorNF,
     r.requisicao ? JSON.stringify(r.requisicao) : null,
     r.resposta == null ? null : JSON.stringify(typeof r.resposta === 'string' ? { texto: r.resposta } : r.resposta),
     r.erro ? null : r.id, r.erro ? null : r.total, r.erro ? null : r.prazo, r.erro || null, ms, !!teste]);
}

async function cotarUma(env, db, integ, req, usuario, { fetchImpl = fetch, semCache = false, teste = false } = {}) {
  const chave = JSON.stringify(req);
  const base = { integracao: integ.id, transportadora: integ.transportadora, tabela: integ.tabela || null };
  if (!semCache) {
    const c = await db.query(
      `SELECT id_cotacao, total, prazo FROM api_consultas
        WHERE integracao = $1 AND chave = $2 AND erro IS NULL AND NOT teste
          AND criado_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
        ORDER BY criado_em DESC LIMIT 1`, [integ.id, chave]);
    if (c.rows.length) { const x = c.rows[0]; return { ...base, ok: true, total: +x.total, prazo: x.prazo, id: x.id_cotacao, doCache: true }; }
  }
  // limite de consultas por minuto da transportadora (São Miguel: 20/min, acima disso bloqueia 30 min): cai para a tabela
  const lim = conector(integ.tipo).limitePorMinuto;
  if (lim) {
    const n = +(await db.query(`SELECT COUNT(*) AS n FROM api_consultas WHERE integracao = $1 AND criado_em > now() - interval '60 seconds'`, [integ.id])).rows[0].n;
    if (n >= lim) return { ...base, ok: false, erro: `${integ.transportadora}: limite de ${lim} consultas por minuto atingido; tente de novo em 1 minuto (valor da tabela).`, tipoErro: 'falha', ms: 0 };
  }
  const ini = Date.now();
  let r;
  try {
    r = await comTempoLimite(conector(integ.tipo).cotar(integ, req, fetchImpl), TEMPO_LIMITE_MS, `${integ.transportadora}: sem resposta em ${TEMPO_LIMITE_MS / 1000} s.`);
  } catch (e) {
    r = { erro: e.message || String(e), tipoErro: tipoDoErro(e), mensagem: e.mensagem || null, requisicao: e.requisicao, resposta: e.resposta };
  }
  const ms = Date.now() - ini;
  await registrar(db, integ, req, chave, usuario, r, ms, teste);
  return r.erro ? { ...base, ok: false, erro: r.erro, tipoErro: r.tipoErro, mensagem: r.mensagem, ms } : { ...base, ok: true, total: r.total, prazo: r.prazo, id: r.id, obs: r.obs || null, ms };
}

// Cota em todas as integrações ativas, em paralelo.
export async function cotarOnline(env, db, d, usuario, fetchImpl = fetch) {
  const estado = await estadoIntegracoes(db);
  // d.integracao: cota só nessa integração (a tela faz uma chamada por transportadora para mostrar o progresso)
  const ativas = (await todasIntegracoes(env, db)).filter((i) => !i.erroConfig && (estado[i.id] || {}).ativa !== false && (!d.integracao || i.id === d.integracao));
  if (!ativas.length) return { remetente: null, resultados: [] };
  const rem = await remetenteAtual(env, db, fetchImpl);
  const req = normalizarPedido(d, rem);
  const invalido = validarPedido(req);
  if (invalido) throw Object.assign(new Error(invalido), { status: 400 });
  const resultados = await Promise.all(ativas.map((i) => cotarUma(env, db, i, req, usuario, { fetchImpl })));
  return { remetente: { cnpj: rem.cnpj, nome: rem.nome, cep: rem.cep, cepPresumido: rem.cepPresumido },
    destinatarioGenerico: !req.cnpjDestinatario, resultados };
}

// Teste de conexão com dados fixos (São Paulo/SP, 50 kg, NF R$ 1.000, 1 volume), sem usar o cache.
export async function testarIntegracao(env, db, id, usuario, fetchImpl = fetch) {
  const integ = (await todasIntegracoes(env, db)).find((i) => i.id === id);
  if (!integ) throw Object.assign(new Error('Integração não encontrada.'), { status: 404 });
  if (integ.erroConfig) return { integracao: id, ok: false, erro: integ.erroConfig };
  const rem = await remetenteAtual(env, db, fetchImpl);
  const req = normalizarPedido({ cepDestino: '01310100', peso: 50, vlrMercadoria: 1000, volumes: 1, cubagem: [{ comprimento: 0.55, largura: 0.4, altura: 0.16, volumes: 1 }] }, rem);
  return cotarUma(env, db, integ, req, usuario, { fetchImpl, semCache: true, teste: true });
}

// Situação de cada integração: configurada, ativa, uso e falhas nos últimos 30 dias.
export async function statusIntegracoes(env, db, fetchImpl = fetch) {
  const estado = await estadoIntegracoes(db);
  const integ = await todasIntegracoes(env, db);
  const st = (await db.query(
    `SELECT integracao, COUNT(*) FILTER (WHERE NOT teste) AS n, COUNT(*) FILTER (WHERE erro IS NULL AND NOT teste) AS ok,
            ROUND(AVG(ms) FILTER (WHERE erro IS NULL)) AS ms_medio, MAX(criado_em) AS ultima
       FROM api_consultas WHERE criado_em > now() - interval '30 days' GROUP BY integracao`)).rows;
  const ult = (await db.query(
    `SELECT DISTINCT ON (integracao) integracao, criado_em, erro, teste FROM api_consultas ORDER BY integracao, criado_em DESC`)).rows;
  const conhecidas = [
    ...integ.map((i) => ({ id: i.id, tipo: i.tipo, transportadora: i.transportadora, tabela: i.tabela || null, origem: i.origem || null, configurada: !i.erroConfig, erroConfig: i.erroConfig || null })),
    // conectores sem nenhuma credencial cadastrada aparecem como "não configurada"
    ...CONECTORES.filter((c) => !integ.some((i) => i.tipo === c.tipo)).map((c) => ({ id: c.tipo, tipo: c.tipo, transportadora: null, configurada: false })),
  ];
  return {
    remetente: await remetenteAtual(env, db, fetchImpl),
    integracoes: conhecidas.map((i) => {
      const s = st.find((x) => x.integracao === i.id) || {}, u = ult.find((x) => x.integracao === i.id);
      return { ...i, ativa: i.configurada && (estado[i.id] || {}).ativa !== false,
        consultas30: +s.n || 0, sucesso30: +s.ok || 0, msMedio: s.ms_medio != null ? +s.ms_medio : null,
        ultima: u ? { em: u.criado_em, ok: !u.erro, erro: u.erro, teste: u.teste } : null };
    }),
  };
}
