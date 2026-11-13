// Cotação online da Braspress (API https://api.braspress.com, POST /v1/cotacao/calcular/json, Basic auth).
// Credenciais: secret BRASPRESS_CONTAS no Cloudflare, JSON com uma conta por CNPJ:
//   [{"cnpj":"12995553000100","usuario":"12995553000100_PRD","senha":"...","cepOrigem":"92480000"}, ...]
// "cepOrigem" é opcional: sem ele, o CEP vem do cadastro do CNPJ (BrasilAPI), guardado em braspress_contas.
// Conta padrão: secret/variável BRASPRESS_CNPJ_PADRAO, ou a conta de Nova Santa Rita, ou a primeira.

export const BRASPRESS_URL = 'https://api.braspress.com/v1/cotacao/calcular/json';
// CPF de uso genérico, não cadastrado na Braspress: a cotação passa a usar só o CEP de destino.
export const DESTINATARIO_GENERICO = '00000000191';

export const SCHEMA_BRASPRESS = `
CREATE TABLE IF NOT EXISTS braspress_contas (
  cnpj          TEXT PRIMARY KEY,
  razao_social  TEXT,
  fantasia      TEXT,
  cidade        TEXT,
  uf            TEXT,
  cep           TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS braspress_cotacoes (
  id               BIGSERIAL PRIMARY KEY,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario          TEXT,
  chave            TEXT NOT NULL,
  cnpj_remetente   TEXT,
  cep_destino      TEXT,
  peso             NUMERIC(12,3),
  volumes          INTEGER,
  valor_mercadoria NUMERIC(14,2),
  requisicao       JSONB,
  resposta         JSONB,
  id_braspress     TEXT,
  total            NUMERIC(14,2),
  prazo            INTEGER,
  erro             TEXT
);
CREATE INDEX IF NOT EXISTS braspress_cotacoes_chave_idx ON braspress_cotacoes (chave, criado_em DESC);
`;

const so = (s) => String(s ?? '').replace(/\D/g, '');

export function contasBraspress(env) {
  if (!env.BRASPRESS_CONTAS) return [];
  let L;
  try { L = JSON.parse(env.BRASPRESS_CONTAS); } catch { throw new Error('O secret BRASPRESS_CONTAS não é um JSON válido.'); }
  if (!Array.isArray(L)) L = [L];
  return L.map((c) => ({ cnpj: so(c.cnpj), usuario: String(c.usuario || ''), senha: String(c.senha || ''), cepOrigem: so(c.cepOrigem) || null, nome: c.nome || null }))
    .filter((c) => c.cnpj.length === 14 && c.usuario && c.senha);
}

// Dados cadastrais de cada CNPJ (nome e CEP de origem), consultados uma vez na BrasilAPI.
export async function infoContas(env, db, fetchImpl = fetch) {
  const contas = contasBraspress(env);
  if (!contas.length) return [];
  const r = await db.query('SELECT * FROM braspress_contas WHERE cnpj = ANY($1::text[])', [contas.map((c) => c.cnpj)]);
  const cad = Object.fromEntries(r.rows.map((x) => [x.cnpj, x]));
  for (const c of contas) {
    if (cad[c.cnpj] && cad[c.cnpj].cep) continue;
    try {
      const resp = await fetchImpl(`https://brasilapi.com.br/api/cnpj/v1/${c.cnpj}`, { headers: { accept: 'application/json' } });
      if (!resp.ok) continue;
      const j = await resp.json();
      const linha = { cnpj: c.cnpj, razao_social: j.razao_social || null, fantasia: j.nome_fantasia || null,
        cidade: j.municipio || null, uf: j.uf || null, cep: so(j.cep) || null };
      await db.query(
        `INSERT INTO braspress_contas (cnpj, razao_social, fantasia, cidade, uf, cep) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cnpj) DO UPDATE SET razao_social=$2, fantasia=$3, cidade=$4, uf=$5, cep=$6, atualizado_em=now()`,
        [linha.cnpj, linha.razao_social, linha.fantasia, linha.cidade, linha.uf, linha.cep]);
      cad[c.cnpj] = linha;
    } catch { /* sem cadastro: segue sem nome/CEP */ }
  }
  const lista = contas.map((c) => {
    const k = cad[c.cnpj] || {};
    return { ...c, razao_social: c.nome || k.fantasia || k.razao_social || null, cidade: k.cidade || null, uf: k.uf || null,
      cepOrigem: c.cepOrigem || k.cep || null };
  });
  const padrao = so(env.BRASPRESS_CNPJ_PADRAO)
    || (lista.find((c) => /NOVA SANTA RITA/i.test(c.cidade || '')) || lista[0]).cnpj;
  return lista.map((c) => ({ ...c, padrao: c.cnpj === padrao }));
}

const arred = (v, n = 3) => Math.round((+v || 0) * 10 ** n) / 10 ** n;

// Monta o corpo da requisição a partir dos dados da calculadora.
export function montarRequisicao(conta, d) {
  const volumes = Math.max(1, parseInt(d.volumes, 10) || 1);
  let cub = (Array.isArray(d.cubagem) ? d.cubagem : [])
    .map((x) => ({ altura: arred(x.altura), largura: arred(x.largura), comprimento: arred(x.comprimento), volumes: Math.max(1, parseInt(x.volumes, 10) || 1) }))
    .filter((x) => x.altura > 0 && x.largura > 0 && x.comprimento > 0);
  if (!cub.length && +d.m3 > 0) { // só o volume total: um cubo equivalente por volume
    const lado = arred(Math.cbrt(+d.m3 / volumes));
    cub = [{ altura: lado, largura: lado, comprimento: lado, volumes }];
  }
  const doc = so(d.cnpjDestinatario);
  return {
    cnpjRemetente: +conta.cnpj,
    cnpjDestinatario: +(doc.length === 11 || doc.length === 14 ? doc : DESTINATARIO_GENERICO),
    modal: d.modal === 'A' ? 'A' : 'R',
    tipoFrete: ['1', '2', '3'].includes(String(d.tipoFrete)) ? String(d.tipoFrete) : '1',
    cepOrigem: +so(conta.cepOrigem),
    cepDestino: +so(d.cepDestino),
    vlrMercadoria: arred(d.vlrMercadoria, 2),
    peso: arred(d.peso),
    volumes,
    cubagem: cub,
  };
}

export class BraspressErro extends Error {
  constructor(msg, status = 502) { super(msg); this.status = status; }
}

// Cota na Braspress. Resultados iguais no mesmo dia vêm do banco (a cotação vale até 23:59 do dia).
export async function cotarBraspress(env, db, d, usuario, fetchImpl = fetch) {
  const contas = await infoContas(env, db, fetchImpl);
  if (!contas.length) throw new BraspressErro('Cotação online da Braspress não configurada (secret BRASPRESS_CONTAS).', 400);
  const conta = contas.find((c) => c.cnpj === so(d.cnpjRemetente)) || contas.find((c) => c.padrao);
  if (!conta.cepOrigem) throw new BraspressErro(`Sem CEP de origem para o CNPJ ${conta.cnpj}. Inclua "cepOrigem" no secret BRASPRESS_CONTAS.`, 400);
  if (so(d.cepDestino).length !== 8) throw new BraspressErro('Informe o CEP de destino.', 400);
  if (!(+d.peso > 0) || !(+d.vlrMercadoria > 0)) throw new BraspressErro('Informe o peso e o valor da NF.', 400);
  const req = montarRequisicao(conta, d);
  if (!req.cubagem.length) throw new BraspressErro('Informe as dimensões ou o volume (m³).', 400);
  const chave = JSON.stringify(req);

  const cache = await db.query(
    `SELECT id_braspress, total, prazo FROM braspress_cotacoes
      WHERE chave = $1 AND erro IS NULL AND criado_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
      ORDER BY criado_em DESC LIMIT 1`, [chave]);
  const base = { cnpjRemetente: conta.cnpj, remetente: conta.razao_social, cepOrigem: conta.cepOrigem, destinatarioGenerico: req.cnpjDestinatario === +DESTINATARIO_GENERICO };
  if (cache.rows.length) {
    const c = cache.rows[0];
    return { ...base, id: c.id_braspress, totalFrete: +c.total, prazo: c.prazo, doCache: true };
  }

  let resp, j = null, erro = null;
  try {
    resp = await fetchImpl(BRASPRESS_URL, {
      method: 'POST',
      headers: { authorization: 'Basic ' + btoa(`${conta.usuario}:${conta.senha}`), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(req),
    });
    try { j = await resp.json(); } catch { /* sem JSON */ }
    if (resp.status === 401 || resp.status === 403) erro = 'A Braspress recusou o usuário e a senha deste CNPJ.';
    else if (!resp.ok || !j || j.totalFrete == null) {
      const lista = j && Array.isArray(j.errorList) ? j.errorList.map((e) => e.message || e).join('; ') : '';
      erro = `Braspress: ${(j && j.message) || 'erro'}${lista ? ' – ' + lista : ''} (HTTP ${resp.status}).`;
    }
  } catch (e) {
    erro = 'Não foi possível acessar a API da Braspress: ' + (e.message || e);
  }
  await db.query(
    `INSERT INTO braspress_cotacoes (usuario, chave, cnpj_remetente, cep_destino, peso, volumes, valor_mercadoria, requisicao, resposta, id_braspress, total, prazo, erro)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [usuario, chave, conta.cnpj, String(req.cepDestino).padStart(8, '0'), req.peso, req.volumes, req.vlrMercadoria,
     JSON.stringify(req), j ? JSON.stringify(j) : null, erro ? null : String(j.id ?? ''), erro ? null : +j.totalFrete,
     erro ? null : (parseInt(j.prazo, 10) || null), erro]);
  if (erro) throw new BraspressErro(erro, resp && resp.status === 401 ? 401 : 502);
  return { ...base, id: j.id != null ? String(j.id) : null, totalFrete: +j.totalFrete, prazo: parseInt(j.prazo, 10) || null };
}
