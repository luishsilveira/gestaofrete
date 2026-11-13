// Gestão de Frete – Proloplast
// Servidor (Cloudflare Worker): API do histórico de cotações.
// O site estático (pasta public/) é servido pelo Cloudflare; só /api/* passa por aqui.
// Banco: PostgreSQL no Aiven, acessado pelo Hyperdrive (binding HYPERDRIVE).
// Usuário: e-mail do login do Cloudflare Access (cabeçalho cf-access-authenticated-user-email).

import { Client } from 'pg';
import { BLING, SCHEMA_BLING, BlingErro, blingConfigurado, pedirToken, salvarTokens, tokenValido, buscarPedido } from './bling.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cotacoes (
  id                    BIGSERIAL PRIMARY KEY,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario               TEXT NOT NULL,
  cliente               TEXT,
  pedido                TEXT,
  observacao            TEXT,
  cep                   TEXT,
  cidade                TEXT,
  uf                    CHAR(2),
  peso_real             NUMERIC(12,3),
  peso_taxado           NUMERIC(12,3),
  valor_nf              NUMERIC(14,2),
  volumes               INTEGER,
  m3                    NUMERIC(12,4),
  com_icms              BOOLEAN,
  regra_tonelada        TEXT,
  melhor_transportadora TEXT,
  melhor_valor          NUMERIC(14,2),
  melhor_prazo          TEXT,
  resultados            JSONB NOT NULL,
  sem_cotacao           JSONB,
  versao_app            TEXT
);
CREATE INDEX IF NOT EXISTS cotacoes_criado_em_idx ON cotacoes (criado_em DESC);
`;

let esquemaPronto = false;

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const texto = (v, max = 200) => (v == null || v === '' ? null : String(v).slice(0, max));
const numero = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);

async function comBanco(env, ctx, fn) {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    if (!esquemaPronto) {
      await client.query(SCHEMA);
      await client.query(SCHEMA_BLING);
      esquemaPronto = true;
    }
    return await fn(client);
  } finally {
    ctx.waitUntil(client.end());
  }
}

async function salvarCotacao(request, env, ctx, usuario) {
  let c;
  try {
    c = await request.json();
  } catch {
    return json({ erro: 'Corpo da requisição inválido.' }, 400);
  }
  if (!Array.isArray(c.resultados) || c.resultados.length === 0) {
    return json({ erro: 'A cotação não tem resultados para salvar.' }, 400);
  }
  if (JSON.stringify(c).length > 200_000) {
    return json({ erro: 'Cotação grande demais.' }, 413);
  }
  const melhor = c.resultados[0];
  const linha = await comBanco(env, ctx, (db) =>
    db.query(
      `INSERT INTO cotacoes (usuario, cliente, pedido, observacao, cep, cidade, uf,
         peso_real, peso_taxado, valor_nf, volumes, m3, com_icms, regra_tonelada,
         melhor_transportadora, melhor_valor, melhor_prazo, resultados, sem_cotacao, versao_app,
         bling_pedido_id, transportadora_escolhida, valor_escolhido)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id, criado_em`,
      [
        usuario,
        texto(c.cliente, 120),
        texto(c.pedido, 40),
        texto(c.observacao, 500),
        texto(c.cep, 9),
        texto(c.cidade, 80),
        texto(c.uf, 2),
        numero(c.peso_real),
        numero(c.peso_taxado),
        numero(c.valor_nf),
        numero(c.volumes),
        numero(c.m3),
        !!c.com_icms,
        texto(c.regra_tonelada, 10),
        texto(melhor.transportadora, 80),
        numero(melhor.total),
        texto(melhor.prazo, 30),
        JSON.stringify(c.resultados),
        JSON.stringify(c.sem_cotacao || []),
        texto(c.versao_app, 20),
        numero(c.bling_pedido_id),
        texto(c.transportadora_escolhida, 80),
        numero(c.valor_escolhido),
      ],
    ),
  );
  return json({ ok: true, ...linha.rows[0] }, 201);
}

async function listarCotacoes(url, env, ctx) {
  const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite') || '100', 10) || 100, 1), 500);
  const busca = (url.searchParams.get('busca') || '').trim();
  const params = [limite];
  let filtro = '';
  if (busca) {
    params.push(`%${busca}%`);
    filtro = `WHERE cidade ILIKE $2 OR cliente ILIKE $2 OR pedido ILIKE $2 OR usuario ILIKE $2
              OR melhor_transportadora ILIKE $2 OR cep ILIKE $2`;
  }
  const r = await comBanco(env, ctx, (db) =>
    db.query(
      `SELECT id, criado_em, usuario, cliente, pedido, cep, cidade, uf, peso_real, peso_taxado,
              valor_nf, volumes, com_icms, melhor_transportadora, melhor_valor, melhor_prazo,
              transportadora_escolhida, valor_escolhido, bling_pedido_id
         FROM cotacoes ${filtro}
        ORDER BY criado_em DESC
        LIMIT $1`,
      params,
    ),
  );
  return json({ cotacoes: r.rows });
}

// ---------- Bling ----------
async function blingStatus(env, ctx) {
  if (!blingConfigurado(env)) return json({ configurado: false, conectado: false });
  const r = await comBanco(env, ctx, (db) => db.query('SELECT expira_em, conectado_por, atualizado_em FROM bling_tokens WHERE id = 1'));
  return json({ configurado: true, conectado: r.rows.length > 0, ...(r.rows[0] || {}) });
}

async function blingConectar(env, ctx) {
  if (!blingConfigurado(env)) return json({ erro: 'Faltam os secrets BLING_CLIENT_ID e BLING_CLIENT_SECRET no Cloudflare.' }, 400);
  const state = crypto.randomUUID();
  await comBanco(env, ctx, async (db) => {
    await db.query(`DELETE FROM bling_oauth_state WHERE criado_em < now() - interval '1 hour'`);
    await db.query('INSERT INTO bling_oauth_state (state) VALUES ($1)', [state]);
  });
  const u = new URL(BLING.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.BLING_CLIENT_ID);
  u.searchParams.set('state', state);
  return Response.redirect(u.toString(), 302);
}

async function blingCallback(url, env, ctx, usuario) {
  const volta = (q) => Response.redirect(`${url.origin}/?${q}`, 302);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state) return volta('bling=erro&msg=' + encodeURIComponent('O Bling não devolveu a autorização.'));
  try {
    await comBanco(env, ctx, async (db) => {
      const s = await db.query(`DELETE FROM bling_oauth_state WHERE state = $1 AND criado_em > now() - interval '1 hour' RETURNING state`, [state]);
      if (!s.rows.length) throw new BlingErro('Pedido de autorização expirado ou inválido. Tente conectar de novo.', 400);
      const t = await pedirToken(env, { grant_type: 'authorization_code', code });
      await salvarTokens(db, t, usuario);
    });
    return volta('bling=ok');
  } catch (e) {
    console.error('Bling callback', e);
    return volta('bling=erro&msg=' + encodeURIComponent(e.message || 'Falha ao conectar.'));
  }
}

async function blingPedido(url, env, ctx) {
  if (!blingConfigurado(env)) return json({ erro: 'Integração com o Bling não configurada.', codigo: 'nao_configurado' }, 400);
  const pedido = await comBanco(env, ctx, async (db) => {
    const token = await tokenValido(env, db);
    return buscarPedido(token, url.searchParams.get('numero'));
  });
  return json(pedido);
}

async function obterCotacao(id, env, ctx) {
  const r = await comBanco(env, ctx, (db) => db.query('SELECT * FROM cotacoes WHERE id = $1', [id]));
  if (!r.rows.length) return json({ erro: 'Cotação não encontrada.' }, 404);
  return json(r.rows[0]);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const usuario = request.headers.get('cf-access-authenticated-user-email') || 'não identificado';
    try {
      if (url.pathname === '/api/eu' && request.method === 'GET') return json({ usuario });
      if (url.pathname === '/api/cotacoes' && request.method === 'POST') return await salvarCotacao(request, env, ctx, usuario);
      if (url.pathname === '/api/cotacoes' && request.method === 'GET') return await listarCotacoes(url, env, ctx);
      if (url.pathname === '/api/bling/status') return await blingStatus(env, ctx);
      if (url.pathname === '/api/bling/conectar') return await blingConectar(env, ctx);
      if (url.pathname === '/api/bling/callback') return await blingCallback(url, env, ctx, usuario);
      if (url.pathname === '/api/bling/pedido') return await blingPedido(url, env, ctx);
      const m = url.pathname.match(/^\/api\/cotacoes\/(\d+)$/);
      if (m && request.method === 'GET') return await obterCotacao(m[1], env, ctx);
      return json({ erro: 'Rota não encontrada.' }, 404);
    } catch (e) {
      if (e instanceof BlingErro) return json({ erro: e.message, codigo: e.codigo }, e.status);
      console.error('Erro na API', url.pathname, e);
      return json({ erro: 'Erro ao acessar o banco de dados.', detalhe: String(e && e.message || e) }, 500);
    }
  },
};
