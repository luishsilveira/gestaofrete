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
ALTER TABLE cotacoes ADD COLUMN IF NOT EXISTS bling_pedido_id BIGINT;
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
export async function tokenValido(env, db, fetchImpl = fetch) {
  const r = await db.query(`SELECT access_token, expira_em FROM bling_tokens WHERE id = 1`);
  if (!r.rows.length) throw new BlingErro('O Bling ainda não foi conectado.', 409, 'desconectado');
  if (new Date(r.rows[0].expira_em).getTime() - Date.now() > 120_000) return r.rows[0].access_token;

  await db.query('BEGIN');
  try {
    const l = await db.query(`SELECT access_token, refresh_token, expira_em FROM bling_tokens WHERE id = 1 FOR UPDATE`);
    const atual = l.rows[0];
    if (new Date(atual.expira_em).getTime() - Date.now() > 120_000) { await db.query('COMMIT'); return atual.access_token; }
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

// Busca o pedido de venda pelo número (o que aparece na tela do Bling) e devolve só o que a calculadora usa.
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

  const det = await blingGet(token, `/pedidos/vendas/${achado.id}`, fetchImpl);
  const p = (det && det.data) || {};
  const tr = p.transporte || {};
  const et = tr.etiqueta || {};

  let cep = soDigitos(et.cep), cidade = et.municipio || '', uf = et.uf || '', origemCep = 'etiqueta de transporte';
  if (cep.length !== 8 && p.contato && p.contato.id) {
    const c = await blingGet(token, `/contatos/${p.contato.id}`, fetchImpl);
    const end = (c && c.data && c.data.endereco) || {};
    const g = end.entrega && soDigitos(end.entrega.cep).length === 8 ? end.entrega : end.geral || {};
    cep = soDigitos(g.cep); cidade = g.municipio || ''; uf = g.uf || ''; origemCep = 'cadastro do cliente';
  }

  const totalProdutos = num(p.totalProdutos);
  return {
    id: p.id || achado.id,
    numero: String(p.numero || n),
    data: p.data || null,
    cliente: (p.contato && p.contato.nome) || '',
    cep: cep.length === 8 ? cep : null,
    cidade, uf, origemCep,
    pesoBruto: num(tr.pesoBruto),
    volumes: num(tr.quantidadeVolumes),
    valorProdutos: totalProdutos,
    valorTotal: num(p.total),
    freteAtual: num(tr.frete),
    situacao: (p.situacao && (p.situacao.valor ?? p.situacao.id)) ?? null,
  };
}
