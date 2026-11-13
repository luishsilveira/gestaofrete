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

// O Bling aceita 3 requisições por segundo por aplicativo. Espaçamos as chamadas e,
// se mesmo assim vier HTTP 429, esperamos e tentamos de novo.
const ritmo = { intervalo: 400, ultima: 0, esperasLimite: [1200, 2500, 5000] };
export const definirRitmoBling = (o) => Object.assign(ritmo, o);
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function aguardarVez() {
  const agora = Date.now(), vez = Math.max(agora, ritmo.ultima + ritmo.intervalo);
  ritmo.ultima = vez;
  if (vez > agora) await dormir(vez - agora);
}

export async function blingGet(token, caminho, fetchImpl = fetch) {
  let r;
  for (let tentativa = 0; ; tentativa++) {
    await aguardarVez();
    r = await fetchImpl(BLING.apiBase + caminho, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (r.status !== 429 || tentativa >= ritmo.esperasLimite.length) break;
    await dormir(ritmo.esperasLimite[tentativa]);
  }
  let j = null;
  try { j = await r.json(); } catch { /* sem JSON */ }
  if (r.status === 401) throw new BlingErro('O Bling recusou o acesso. Conecte de novo ao Bling.', 409, 'desconectado');
  if (r.status === 404) return null;
  if (r.status === 403) {
    const recurso = caminho.split('?')[0].replace(/\/\d+$/, '').replace(/^\//, '');
    throw new BlingErro(`O aplicativo do Bling não tem permissão para consultar "${recurso}". Inclua esse escopo no aplicativo do Bling e conecte de novo.`, 403, 'permissao');
  }
  if (r.status === 429) throw new BlingErro('O Bling limitou as consultas por alguns segundos; o restante fica para a próxima execução.', 429, 'limite');
  if (!r.ok) {
    const det = j && j.error && (j.error.description || j.error.message);
    const param = r.status === 400 || r.status === 422;
    throw new BlingErro(`Erro ao consultar o Bling${det ? ': ' + det : ''} (HTTP ${r.status}).`, param ? 400 : 502, param ? 'parametro' : 'bling');
  }
  return j;
}

export const soDigitos = (s) => String(s || '').replace(/\D/g, '');
export const num = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
