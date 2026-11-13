// Gestão de Frete – Proloplast
// Servidor (Cloudflare Worker): API do histórico de cotações.
// O site estático (pasta public/) é servido pelo Cloudflare; só /api/* passa por aqui.
// Banco: PostgreSQL no Aiven, acessado pelo Hyperdrive (binding HYPERDRIVE).
// Usuário: e-mail do login do Cloudflare Access (cabeçalho cf-access-authenticated-user-email).

import { Client } from 'pg';

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
         melhor_transportadora, melhor_valor, melhor_prazo, resultados, sem_cotacao, versao_app)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
              valor_nf, volumes, com_icms, melhor_transportadora, melhor_valor, melhor_prazo
         FROM cotacoes ${filtro}
        ORDER BY criado_em DESC
        LIMIT $1`,
      params,
    ),
  );
  return json({ cotacoes: r.rows });
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
      const m = url.pathname.match(/^\/api\/cotacoes\/(\d+)$/);
      if (m && request.method === 'GET') return await obterCotacao(m[1], env, ctx);
      return json({ erro: 'Rota não encontrada.' }, 404);
    } catch (e) {
      console.error('Erro na API', url.pathname, e);
      return json({ erro: 'Erro ao acessar o banco de dados.', detalhe: String(e && e.message || e) }, 500);
    }
  },
};
