// Integração com o Bling (API v3, OAuth 2.0 – authorization code).
// Credenciais do aplicativo: secrets BLING_CLIENT_ID e BLING_CLIENT_SECRET no Cloudflare.
// Tokens: tabela bling_tokens (uma linha). O access token vale ~6 h; o refresh token
// vale ~30 dias e é trocado a cada renovação.

export const BLING = {
  authorizeUrl: 'https://www.bling.com.br/Api/v3/oauth/authorize',
  tokenUrl: 'https://api.bling.com.br/Api/v3/oauth/token',
  apiBase: 'https://api.bling.com.br/Api/v3',
};

export const SCHEMA_BLING = `
CREATE TABLE IF NOT EXISTS bling_tokens (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expira_em      TIMESTAMPTZ NOT NULL,
  conectado_por  TEXT,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bling_oauth_state (
  state      TEXT PRIMARY KEY,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pedidos_bling (
  id                    BIGINT PRIMARY KEY,
  numero                TEXT NOT NULL,
  data                  DATE,
  situacao_id           BIGINT,
  cliente               TEXT,
  documento             TEXT,
  cep                   TEXT,
  cidade                TEXT,
  uf                    TEXT,
  origem_cep            TEXT,
  peso_bruto            NUMERIC(12,3),
  volumes               INTEGER,
  valor_produtos        NUMERIC(14,2),
  valor_total           NUMERIC(14,2),
  frete_bling           NUMERIC(14,2),
  frete_por_conta       INTEGER,
  transportadora_bling  TEXT,
  dados                 JSONB,
  importado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  importado_por         TEXT,
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pedidos_bling_data_idx ON pedidos_bling (data DESC, id DESC);
CREATE INDEX IF NOT EXISTS pedidos_bling_numero_idx ON pedidos_bling (numero);
CREATE TABLE IF NOT EXISTS bling_situacoes (
  id    BIGINT PRIMARY KEY,
  nome  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bling_sync (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ultima_execucao   TIMESTAMPTZ,
  ultimo_completo   TIMESTAMPTZ,
  mensagem          TEXT
);
ALTER TABLE cotacoes ADD COLUMN IF NOT EXISTS bling_pedido_id BIGINT;
CREATE INDEX IF NOT EXISTS cotacoes_bling_pedido_idx ON cotacoes (bling_pedido_id, criado_em DESC);
ALTER TABLE cotacoes ADD COLUMN IF NOT EXISTS transportadora_escolhida TEXT;
ALTER TABLE cotacoes ADD COLUMN IF NOT EXISTS valor_escolhido NUMERIC(14,2);
`;

export class BlingErro extends Error {
  constructor(msg, status = 502, codigo = 'bling') { super(msg); this.status = status; this.codigo = codigo; }
}

export const blingConfigurado = (env) => !!(env.BLING_CLIENT_ID && env.BLING_CLIENT_SECRET);

function basicAuth(env) {
  return 'Basic ' + btoa(`${env.BLING_CLIENT_ID}:${env.BLING_CLIENT_SECRET}`);
}

// Troca o code (ou o refresh token) por tokens novos.
export async function pedirToken(env, params, fetchImpl = fetch) {
  const r = await fetchImpl(BLING.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: basicAuth(env),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  let j = null;
  try { j = await r.json(); } catch { /* resposta sem JSON */ }
  if (!r.ok || !j || !j.access_token) {
    const det = j && (j.error_description || (j.error && (j.error.description || j.error.message)) || j.error);
    throw new BlingErro(`O Bling recusou a autorização${det ? ': ' + det : ''} (HTTP ${r.status}).`, 502, 'token');
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expira_em: new Date(Date.now() + (Number(j.expires_in) || 21600) * 1000),
  };
}

export async function salvarTokens(db, t, usuario) {
  await db.query(
    `INSERT INTO bling_tokens (id, access_token, refresh_token, expira_em, conectado_por, atualizado_em)
     VALUES (1, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       expira_em = EXCLUDED.expira_em, conectado_por = COALESCE(EXCLUDED.conectado_por, bling_tokens.conectado_por),
       atualizado_em = now()`,
    [t.access_token, t.refresh_token, t.expira_em, usuario || null],
  );
}

// Devolve um access token válido, renovando com trava no banco para evitar duas renovações ao mesmo tempo
// (o Bling invalida o refresh token antigo a cada uso).
// forcar = true renova mesmo com o token ainda válido (usado pela tarefa agendada, para o refresh token nunca vencer).
export async function tokenValido(env, db, fetchImpl = fetch, forcar = false) {
  const folga = forcar ? Infinity : 120_000;
  const r = await db.query(`SELECT access_token, expira_em FROM bling_tokens WHERE id = 1`);
  if (!r.rows.length) throw new BlingErro('O Bling ainda não foi conectado.', 409, 'desconectado');
  if (new Date(r.rows[0].expira_em).getTime() - Date.now() > folga) return r.rows[0].access_token;

  await db.query('BEGIN');
  try {
    const l = await db.query(`SELECT access_token, refresh_token, expira_em FROM bling_tokens WHERE id = 1 FOR UPDATE`);
    const atual = l.rows[0];
    if (new Date(atual.expira_em).getTime() - Date.now() > folga) { await db.query('COMMIT'); return atual.access_token; }
    let novo;
    try {
      novo = await pedirToken(env, { grant_type: 'refresh_token', refresh_token: atual.refresh_token }, fetchImpl);
    } catch (e) {
      await db.query('ROLLBACK');
      throw new BlingErro('A conexão com o Bling expirou. Clique em "Conectar ao Bling" para autorizar de novo.', 409, 'desconectado');
    }
    await salvarTokens(db, novo, null);
    await db.query('COMMIT');
    return novo.access_token;
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* já encerrada */ }
    throw e;
  }
}

async function blingGet(token, caminho, fetchImpl = fetch) {
  const r = await fetchImpl(BLING.apiBase + caminho, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  let j = null;
  try { j = await r.json(); } catch { /* sem JSON */ }
  if (r.status === 401) throw new BlingErro('O Bling recusou o acesso. Conecte de novo ao Bling.', 409, 'desconectado');
  if (r.status === 404) return null;
  if (r.status === 429) throw new BlingErro('O Bling limitou as consultas por alguns segundos. Tente de novo.', 429, 'limite');
  if (!r.ok) {
    const det = j && j.error && (j.error.description || j.error.message);
    throw new BlingErro(`Erro ao consultar o Bling${det ? ': ' + det : ''} (HTTP ${r.status}).`);
  }
  return j;
}

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const num = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);

// Lê o pedido completo; se a etiqueta de transporte não tiver CEP, completa com o endereço do cliente.
export async function obterPedido(token, id, fetchImpl = fetch) {
  const det = await blingGet(token, `/pedidos/vendas/${id}`, fetchImpl);
  const p = det && det.data;
  if (!p) return null;
  const et = (p.transporte && p.transporte.etiqueta) || {};
  if (soDigitos(et.cep).length !== 8 && p.contato && p.contato.id) {
    const c = await blingGet(token, `/contatos/${p.contato.id}`, fetchImpl);
    if (c && c.data) p._contato = { endereco: c.data.endereco || null, numeroDocumento: c.data.numeroDocumento || null };
  }
  return p;
}

// Extrai do pedido do Bling só o que a calculadora e a tela de pedidos usam.
export function normalizarPedido(p) {
  const tr = p.transporte || {};
  const et = tr.etiqueta || {};
  let cep = soDigitos(et.cep), cidade = et.municipio || '', uf = et.uf || '', origemCep = 'etiqueta de transporte';
  if (cep.length !== 8 && p._contato && p._contato.endereco) {
    const end = p._contato.endereco;
    const g = end.entrega && soDigitos(end.entrega.cep).length === 8 ? end.entrega : end.geral || {};
    cep = soDigitos(g.cep); cidade = g.municipio || ''; uf = g.uf || ''; origemCep = 'cadastro do cliente';
  }
  const sit = p.situacao || {};
  return {
    id: p.id,
    numero: String(p.numero ?? ''),
    data: p.data || null,
    situacaoId: num(sit.id),
    cliente: (p.contato && p.contato.nome) || '',
    documento: (p.contato && p.contato.numeroDocumento) || (p._contato && p._contato.numeroDocumento) || null,
    cep: cep.length === 8 ? cep : null,
    cidade, uf, origemCep,
    pesoBruto: num(tr.pesoBruto),
    volumes: num(tr.quantidadeVolumes),
    valorProdutos: num(p.totalProdutos),
    valorTotal: num(p.total),
    freteAtual: num(tr.frete),
    fretePorConta: num(tr.fretePorConta),
    transportadora: (tr.contato && tr.contato.nome) || null,
  };
}

// Busca o pedido de venda pelo número (o que aparece na tela do Bling).
export async function buscarPedido(token, numero, fetchImpl = fetch) {
  const n = soDigitos(numero);
  if (!n) throw new BlingErro('Informe o número do pedido.', 400, 'entrada');
  const lista = await blingGet(token, `/pedidos/vendas?numero=${encodeURIComponent(n)}&limite=100`, fetchImpl);
  const dados = (lista && lista.data) || [];
  const achado = dados.find((p) => String(p.numero) === n);
  if (!achado) {
    const nums = dados.map((p) => +p.numero).filter((x) => !isNaN(x));
    const faixa = nums.length ? ` A busca devolveu ${nums.length} pedido(s), do nº ${Math.min(...nums)} ao ${Math.max(...nums)}.` : ' A busca não devolveu nenhum pedido.';
    throw new BlingErro(`Pedido ${n} não encontrado no Bling.${faixa}`, 404, 'nao_encontrado');
  }
  const p = await obterPedido(token, achado.id, fetchImpl);
  if (!p) throw new BlingErro(`Pedido ${n} não encontrado no Bling.`, 404, 'nao_encontrado');
  return { ...normalizarPedido(p), _bruto: p };
}

// Grava (ou atualiza) pedidos na tabela pedidos_bling, num único comando.
export async function gravarPedidos(db, lista, importadoPor) {
  if (!lista.length) return;
  const linhas = lista.map(({ n, bruto }) => ({
    id: n.id, numero: n.numero, data: n.data, situacao_id: n.situacaoId, cliente: n.cliente, documento: n.documento,
    cep: n.cep, cidade: n.cidade, uf: n.uf, origem_cep: n.origemCep, peso_bruto: n.pesoBruto, volumes: n.volumes,
    valor_produtos: n.valorProdutos, valor_total: n.valorTotal, frete_bling: n.freteAtual, frete_por_conta: n.fretePorConta,
    transportadora_bling: n.transportadora, dados: bruto,
  }));
  await db.query(
    `INSERT INTO pedidos_bling (id, numero, data, situacao_id, cliente, documento, cep, cidade, uf, origem_cep, peso_bruto,
       volumes, valor_produtos, valor_total, frete_bling, frete_por_conta, transportadora_bling, dados, importado_por, atualizado_em)
     SELECT x.id, x.numero, x.data, x.situacao_id, x.cliente, x.documento, x.cep, x.cidade, x.uf, x.origem_cep, x.peso_bruto,
       x.volumes, x.valor_produtos, x.valor_total, x.frete_bling, x.frete_por_conta, x.transportadora_bling, x.dados, $2, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(id BIGINT, numero TEXT, data DATE, situacao_id BIGINT, cliente TEXT, documento TEXT,
         cep TEXT, cidade TEXT, uf TEXT, origem_cep TEXT, peso_bruto NUMERIC, volumes INTEGER, valor_produtos NUMERIC,
         valor_total NUMERIC, frete_bling NUMERIC, frete_por_conta INTEGER, transportadora_bling TEXT, dados JSONB)
     ON CONFLICT (id) DO UPDATE SET numero = EXCLUDED.numero, data = EXCLUDED.data, situacao_id = EXCLUDED.situacao_id,
       cliente = EXCLUDED.cliente, documento = EXCLUDED.documento, cep = EXCLUDED.cep, cidade = EXCLUDED.cidade, uf = EXCLUDED.uf,
       origem_cep = EXCLUDED.origem_cep, peso_bruto = EXCLUDED.peso_bruto, volumes = EXCLUDED.volumes,
       valor_produtos = EXCLUDED.valor_produtos, valor_total = EXCLUDED.valor_total, frete_bling = EXCLUDED.frete_bling,
       frete_por_conta = EXCLUDED.frete_por_conta, transportadora_bling = EXCLUDED.transportadora_bling, dados = EXCLUDED.dados,
       atualizado_em = now()`,
    [JSON.stringify(linhas), importadoPor],
  );
}

const dataISO = (d) => d.toISOString().slice(0, 10);

// Importação automática (tarefa agendada a cada 5 min, ou botão "Sincronizar agora").
// Traz os pedidos alterados desde o último ciclo completo; na primeira vez, os últimos 30 dias.
// Respeita um limite de chamadas por execução (plano gratuito do Cloudflare: 50 por execução)
// e continua de onde parou na execução seguinte.
export async function sincronizarPedidos(env, db, fetchImpl = fetch, opcoes = {}) {
  const limiteChamadas = opcoes.limiteChamadas || 40;
  const dias = opcoes.diasIniciais || 30;
  let chamadas = 0;
  const get = async (caminho) => { chamadas++; return blingGet(token, caminho, fetchImpl); };
  const token = await tokenValido(env, db, fetchImpl);

  const st = (await db.query('SELECT ultimo_completo FROM bling_sync WHERE id = 1')).rows[0];
  const inicioCiclo = new Date();
  const desde = st && st.ultimo_completo
    ? new Date(new Date(st.ultimo_completo).getTime() - 24 * 3600e3)
    : new Date(Date.now() - dias * 24 * 3600e3);

  // 1) lista de pedidos alterados desde a data (até 3 páginas de 100)
  let filtro = `dataAlteracaoInicial=${dataISO(desde)}`;
  const lista = [];
  for (let pagina = 1; pagina <= 3; pagina++) {
    let r;
    try { r = await get(`/pedidos/vendas?pagina=${pagina}&limite=100&${filtro}`); }
    catch (e) {
      // se o Bling não aceitar o filtro por data de alteração, usa a data do pedido
      if (pagina === 1 && filtro.startsWith('dataAlteracao') && e.status !== 409) {
        filtro = `dataInicial=${dataISO(desde)}`;
        r = await get(`/pedidos/vendas?pagina=1&limite=100&${filtro}`);
      } else throw e;
    }
    const d = (r && r.data) || [];
    lista.push(...d);
    if (d.length < 100) break;
  }
  const listaCompleta = lista.length < 300;

  // 2) decide quais pedidos ler em detalhe: novos, alterados e os que não são lidos há 30 min
  const ids = lista.map((p) => p.id);
  const salvos = new Map();
  if (ids.length) {
    const r = await db.query(
      `SELECT id, situacao_id, valor_total, atualizado_em FROM pedidos_bling WHERE id = ANY($1::bigint[])`, [ids]);
    r.rows.forEach((x) => salvos.set(String(x.id), x));
  }
  const prio = (p) => {
    const s = salvos.get(String(p.id));
    if (!s) return 0;
    if (num(s.situacao_id) !== num(p.situacao && p.situacao.id) || num(s.valor_total) !== num(p.total)) return 1;
    if (Date.now() - new Date(s.atualizado_em).getTime() > 30 * 60e3) return 2;
    return 9;
  };
  const fila = lista.map((p) => ({ p, k: prio(p) })).filter((x) => x.k < 9)
    .sort((a, b) => a.k - b.k || String(b.p.data || '').localeCompare(String(a.p.data || '')));

  // 3) lê os detalhes dentro do limite de chamadas
  const gravar = [];
  let pendentes = 0;
  for (const { p } of fila) {
    if (chamadas + 2 > limiteChamadas) { pendentes++; continue; }
    const det = await get(`/pedidos/vendas/${p.id}`);
    const bruto = det && det.data;
    if (!bruto) continue;
    const et = (bruto.transporte && bruto.transporte.etiqueta) || {};
    if (soDigitos(et.cep).length !== 8 && bruto.contato && bruto.contato.id) {
      const c = await get(`/contatos/${bruto.contato.id}`);
      if (c && c.data) bruto._contato = { endereco: c.data.endereco || null, numeroDocumento: c.data.numeroDocumento || null };
    }
    gravar.push({ n: normalizarPedido(bruto), bruto });
  }
  await gravarPedidos(db, gravar, 'importação automática');

  // 4) nomes das situações ainda desconhecidas
  const sits = [...new Set(gravar.map((x) => x.n.situacaoId).filter((x) => x != null))];
  if (sits.length) {
    const conhecidas = new Set((await db.query('SELECT id FROM bling_situacoes WHERE id = ANY($1::bigint[])', [sits])).rows.map((x) => String(x.id)));
    for (const s of sits.filter((s) => !conhecidas.has(String(s)))) {
      if (chamadas + 1 > limiteChamadas) break;
      try {
        const r = await get(`/situacoes/${s}`);
        const nome = r && r.data && r.data.nome;
        if (nome) await db.query('INSERT INTO bling_situacoes (id, nome) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome', [s, nome]);
      } catch { /* nome da situação é opcional */ }
    }
  }

  // 5) registra o ciclo; só avança a data quando não sobrou nada pendente
  const completo = pendentes === 0 && listaCompleta;
  const msg = `${gravar.length} pedido(s) lido(s) do Bling${pendentes ? `, ${pendentes} pendente(s) para a próxima execução` : ''}.`;
  await db.query(
    `INSERT INTO bling_sync (id, ultima_execucao, ultimo_completo, mensagem) VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET ultima_execucao = now(),
       ultimo_completo = COALESCE($1, bling_sync.ultimo_completo), mensagem = $2`,
    [completo ? inicioCiclo : null, msg],
  );
  return { lidos: gravar.length, pendentes, listados: lista.length, chamadas, completo, mensagem: msg };
}
