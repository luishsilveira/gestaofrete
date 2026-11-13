// Gestão de Frete – Proloplast
// Servidor (Cloudflare Worker): API do histórico de cotações.
// O site estático (pasta public/) é servido pelo Cloudflare; só /api/* passa por aqui.
// Banco: PostgreSQL no Aiven, acessado pelo Hyperdrive (binding HYPERDRIVE).
// Usuário: e-mail do login do Cloudflare Access (cabeçalho cf-access-authenticated-user-email).

import { Client } from 'pg';
import { BLING, SCHEMA_BLING, BlingErro, blingConfigurado, pedirToken, salvarTokens, tokenValido } from './bling.js';
import { SCHEMA_BRASPRESS, BraspressErro, contasBraspress, infoContas, cotarBraspress } from './braspress.js';
import { SCHEMA_DOCS, buscarPedido, buscarProposta, completarProdutos, gravarPedidos, gravarPropostas, sincronizarTudo } from './sync.js';

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

// Valores cotados fora do sistema (site, e-mail ou telefone da transportadora, CT-e) para conferir divergências.
const SCHEMA_MANUAL = `
CREATE TABLE IF NOT EXISTS cotacao_valores_manuais (
  id               BIGSERIAL PRIMARY KEY,
  cotacao_id       BIGINT NOT NULL REFERENCES cotacoes(id) ON DELETE CASCADE,
  transportadora   TEXT NOT NULL,
  valor_calculado  NUMERIC(14,2),
  valor_manual     NUMERIC(14,2) NOT NULL,
  prazo_manual     TEXT,
  referencia       TEXT,
  motivo           TEXT,
  observacao       TEXT,
  usuario          TEXT NOT NULL,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cvm_cotacao_idx ON cotacao_valores_manuais (cotacao_id);
`;
export const MOTIVOS = ['Não identificado', 'Tabela desatualizada / reajuste', 'Taxa não prevista (TDE, TDA, agendamento…)',
  'Praça ou cidade diferente', 'ICMS', 'Peso ou cubagem diferente', 'Valor da NF diferente', 'Desconto ou negociação', 'Outro'];

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
      await client.query(SCHEMA_DOCS);
      await client.query(SCHEMA_MANUAL);
      await client.query(SCHEMA_BRASPRESS);
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
  const manuais = (Array.isArray(c.valores_manuais) ? c.valores_manuais : []).filter((m) => numero(m.valor_manual) > 0).slice(0, 20);
  const linha = await comBanco(env, ctx, async (db) => {
    const r = await db.query(
      `INSERT INTO cotacoes (usuario, cliente, pedido, observacao, cep, cidade, uf,
         peso_real, peso_taxado, valor_nf, volumes, m3, com_icms, regra_tonelada,
         melhor_transportadora, melhor_valor, melhor_prazo, resultados, sem_cotacao, versao_app,
         bling_pedido_id, transportadora_escolhida, valor_escolhido, bling_proposta_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
        numero(c.bling_proposta_id),
      ],
    );
    for (const m of manuais) await inserirManual(db, r.rows[0].id, m, c.resultados, usuario);
    return r;
  });
  return json({ ok: true, ...linha.rows[0], valores_manuais: manuais.length }, 201);
}

async function inserirManual(db, cotacaoId, m, resultados, usuario) {
  const transp = texto(m.transportadora, 80);
  if (!transp || !(numero(m.valor_manual) > 0)) throw Object.assign(new Error('Informe a transportadora e o valor.'), { status: 400 });
  // valor calculado pelo sistema para a mesma transportadora (nulo se o sistema não cotou)
  const calc = (resultados || []).find((x) => x.transportadora === transp);
  return (await db.query(
    `INSERT INTO cotacao_valores_manuais (cotacao_id, transportadora, valor_calculado, valor_manual, prazo_manual, referencia, motivo, observacao, usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [cotacaoId, transp, calc ? numero(calc.total) : null, numero(m.valor_manual), texto(m.prazo_manual, 30),
     texto(m.referencia, 80), texto(m.motivo, 80), texto(m.observacao, 500), usuario])).rows[0];
}

async function adicionarManual(id, request, env, ctx, usuario) {
  let m; try { m = await request.json(); } catch { return json({ erro: 'Corpo da requisição inválido.' }, 400); }
  try {
    const r = await comBanco(env, ctx, async (db) => {
      const c = await db.query('SELECT resultados FROM cotacoes WHERE id = $1', [id]);
      if (!c.rows.length) return null;
      return inserirManual(db, id, m, c.rows[0].resultados, usuario);
    });
    return r ? json(r, 201) : json({ erro: 'Cotação não encontrada.' }, 404);
  } catch (e) { if (e.status === 400) return json({ erro: e.message }, 400); throw e; }
}

async function alterarManual(id, request, env, ctx) {
  if (request.method === 'DELETE') {
    await comBanco(env, ctx, (db) => db.query('DELETE FROM cotacao_valores_manuais WHERE id = $1', [id]));
    return json({ ok: true });
  }
  let m; try { m = await request.json(); } catch { return json({ erro: 'Corpo da requisição inválido.' }, 400); }
  const r = await comBanco(env, ctx, (db) => db.query(
    `UPDATE cotacao_valores_manuais SET motivo = $2, observacao = $3, referencia = COALESCE($4, referencia) WHERE id = $1 RETURNING *`,
    [id, texto(m.motivo, 80), texto(m.observacao, 500), texto(m.referencia, 80)]));
  return r.rows.length ? json(r.rows[0]) : json({ erro: 'Valor não encontrado.' }, 404);
}

// Divergências: cada valor manual com o contexto da cotação, e resumos por transportadora, UF, faixa de peso e motivo.
async function divergencias(url, env, ctx) {
  const params = [], cond = ['m.valor_calculado IS NOT NULL'];
  const de = url.searchParams.get('de'), ate = url.searchParams.get('ate'), tr = url.searchParams.get('transportadora');
  if (de) { params.push(de); cond.push(`c.criado_em >= $${params.length}::date`); }
  if (ate) { params.push(ate); cond.push(`c.criado_em < $${params.length}::date + 1`); }
  if (tr) { params.push(tr); cond.push(`m.transportadora = $${params.length}`); }
  const base = `
    SELECT m.*, c.criado_em AS cotado_em, c.cliente, c.pedido, c.cep, c.cidade, c.uf, c.peso_real, c.peso_taxado, c.valor_nf,
           c.volumes, c.com_icms, c.regra_tonelada, c.versao_app,
           (SELECT r->>'praca' FROM jsonb_array_elements(c.resultados) r WHERE r->>'transportadora' = m.transportadora LIMIT 1) AS praca,
           m.valor_manual - m.valor_calculado AS diferenca,
           ROUND((m.valor_manual - m.valor_calculado) / NULLIF(m.valor_calculado, 0) * 100, 2) AS diferenca_pct,
           CASE WHEN c.peso_real <= 50 THEN 'até 50 kg' WHEN c.peso_real <= 100 THEN '51 a 100 kg' WHEN c.peso_real <= 200 THEN '101 a 200 kg'
                WHEN c.peso_real <= 500 THEN '201 a 500 kg' ELSE 'acima de 500 kg' END AS faixa_peso
      FROM cotacao_valores_manuais m JOIN cotacoes c ON c.id = m.cotacao_id
     WHERE ${cond.join(' AND ')}`;
  const resumo = (grupo) => `
    SELECT ${grupo} AS grupo, COUNT(*) AS n, ROUND(AVG(diferenca), 2) AS media_dif, ROUND(AVG(diferenca_pct), 2) AS media_pct,
           ROUND(AVG(ABS(diferenca_pct)), 2) AS media_abs_pct, MIN(diferenca_pct) AS min_pct, MAX(diferenca_pct) AS max_pct,
           COUNT(*) FILTER (WHERE diferenca > 0.01) AS acima, COUNT(*) FILTER (WHERE diferenca < -0.01) AS abaixo
      FROM (${base}) d GROUP BY 1 ORDER BY 2 DESC, 1`;
  const r = await comBanco(env, ctx, (db) => Promise.all([
    db.query(base + ' ORDER BY m.criado_em DESC LIMIT 2000', params),
    db.query(resumo('transportadora'), params),
    db.query(resumo(`transportadora || ' · ' || uf`), params),
    db.query(resumo(`transportadora || ' · ' || faixa_peso`), params),
    db.query(resumo(`COALESCE(motivo, 'Sem motivo informado')`), params),
    db.query(`SELECT m.*, c.criado_em AS cotado_em, c.cidade, c.uf, c.peso_real, c.valor_nf FROM cotacao_valores_manuais m
                JOIN cotacoes c ON c.id = m.cotacao_id WHERE m.valor_calculado IS NULL ORDER BY m.criado_em DESC LIMIT 500`),
  ]));
  return json({ linhas: r[0].rows, por_transportadora: r[1].rows, por_uf: r[2].rows, por_peso: r[3].rows, por_motivo: r[4].rows,
    sem_calculo: r[5].rows, motivos: MOTIVOS });
}

async function listarCotacoes(url, env, ctx) {
  const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite') || '100', 10) || 100, 1), 500);
  const busca = (url.searchParams.get('busca') || '').trim();
  const params = [limite], cond = [];
  if (busca) {
    params.push(`%${busca}%`);
    cond.push(`(cidade ILIKE $2 OR cliente ILIKE $2 OR pedido ILIKE $2 OR usuario ILIKE $2
              OR melhor_transportadora ILIKE $2 OR cep ILIKE $2)`);
  }
  if (url.searchParams.get('manual') === '1') cond.push('EXISTS (SELECT 1 FROM cotacao_valores_manuais m WHERE m.cotacao_id = cotacoes.id)');
  const filtro = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await comBanco(env, ctx, (db) =>
    db.query(
      `SELECT id, criado_em, usuario, cliente, pedido, cep, cidade, uf, peso_real, peso_taxado,
              valor_nf, volumes, com_icms, melhor_transportadora, melhor_valor, melhor_prazo,
              transportadora_escolhida, valor_escolhido, bling_pedido_id,
              (SELECT json_agg(json_build_object('transportadora', m.transportadora, 'valor_manual', m.valor_manual,
                        'valor_calculado', m.valor_calculado) ORDER BY m.id)
                 FROM cotacao_valores_manuais m WHERE m.cotacao_id = cotacoes.id) AS manuais
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
  const [r, s] = await comBanco(env, ctx, (db) => Promise.all([
    db.query('SELECT expira_em, conectado_por, atualizado_em FROM bling_tokens WHERE id = 1'),
    db.query('SELECT recurso, ultima_execucao, ultimo_completo, mensagem FROM bling_sync_recurso ORDER BY recurso'),
  ]));
  const ult = s.rows.reduce((a, x) => (!a || new Date(x.ultima_execucao) > new Date(a) ? x.ultima_execucao : a), null);
  return json({ configurado: true, conectado: r.rows.length > 0, ...(r.rows[0] || {}),
    sync: s.rows.length ? { ultima_execucao: ult, mensagem: s.rows.map((x) => x.mensagem).join(' · '), recursos: s.rows } : null });
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

// Busca pelo número: pedido de venda e, se não houver, proposta comercial.
async function blingPedido(url, env, ctx, usuario) {
  if (!blingConfigurado(env)) return json({ erro: 'Integração com o Bling não configurada.', codigo: 'nao_configurado' }, 400);
  const numero = url.searchParams.get('numero');
  const doc = await comBanco(env, ctx, async (db) => {
    const token = await tokenValido(env, db);
    let tipo = 'pedido', p;
    try {
      p = await buscarPedido(token, numero);
    } catch (e) {
      if (e.codigo !== 'nao_encontrado') throw e;
      p = await buscarProposta(db, token, numero);
      if (!p) throw new BlingErro(`Nº ${String(numero).replace(/\D/g, '')} não encontrado no Bling, nem como pedido de venda nem como proposta comercial.`, 404, 'nao_encontrado');
      tipo = 'proposta';
    }
    const { _bruto, ...n } = p;
    if (tipo === 'pedido') await gravarPedidos(db, [{ n, bruto: _bruto }], usuario);
    else await gravarPropostas(db, [{ n, bruto: _bruto }], usuario);
    const tabela = tipo === 'pedido' ? 'pedido_itens' : 'proposta_itens';
    // produtos dos itens que ainda não foram importados (para o peso pelos itens)
    try { await completarProdutos(db, token, (n.itens || []).map((i) => i.produto_id)); } catch { /* peso pelos itens é opcional */ }
    const w = (await db.query(PESO_DOC(tabela, '$1'), [n.id])).rows[0] || {};
    return { ...n, tipo, pesoItens: +w.peso_calculado || null, itensSemPeso: +w.itens_sem_peso || 0 };
  });
  return json(doc);
}

async function blingSincronizar(env, ctx) {
  if (!blingConfigurado(env)) return json({ erro: 'Integração com o Bling não configurada.' }, 400);
  const r = await comBanco(env, ctx, (db) => sincronizarTudo(env, db));
  return json(r);
}

async function blingPedidos(url, env, ctx) {
  const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite') || '200', 10) || 200, 1), 500);
  const busca = (url.searchParams.get('busca') || '').trim();
  const filtro = url.searchParams.get('filtro') || '';
  const cond = [], params = [limite];
  if (busca) { params.push(`%${busca}%`); cond.push(`(p.numero ILIKE $${params.length} OR p.cliente ILIKE $${params.length} OR p.cidade ILIKE $${params.length} OR p.cep ILIKE $${params.length} OR p.documento ILIKE $${params.length})`); }
  if (filtro === 'sem_cotacao') cond.push('c.id IS NULL');
  if (filtro === 'sem_frete') cond.push('COALESCE(p.frete_bling, 0) = 0');
  if (filtro === 'acima') cond.push('p.frete_bling > 0 AND c.id IS NOT NULL AND p.frete_bling > COALESCE(c.valor_escolhido, c.melhor_valor) + 0.01');
  const canal = url.searchParams.get('canal') || '';
  if (canal === 'direta') cond.push(`COALESCE(p.canal, 'Venda direta') = 'Venda direta'`);
  else if (canal === 'marketplace') cond.push(`COALESCE(p.canal, 'Venda direta') <> 'Venda direta'`);
  else if (canal) { params.push(canal); cond.push(`p.canal = $${params.length}`); }
  const r = await comBanco(env, ctx, (db) => db.query(
    `SELECT p.id, p.numero, p.data, p.situacao_id, s.nome AS situacao, p.cliente, p.documento, p.cep, p.cidade, p.uf, p.origem_cep,
            p.peso_bruto, p.volumes, p.valor_produtos, p.valor_total, p.frete_bling, p.frete_por_conta, p.transportadora_bling,
            p.importado_em, p.importado_por, p.atualizado_em, p.canal, p.numero_loja, p.custo_frete_marketplace, p.nota_fiscal_id,
            pw.peso_calculado, pw.itens_sem_peso, pw.n_itens,
            c.id AS cotacao_id, c.criado_em AS cotado_em, c.melhor_transportadora, c.melhor_valor, c.melhor_prazo,
            c.transportadora_escolhida, c.valor_escolhido, c.usuario AS cotado_por
       FROM pedidos_bling p
       LEFT JOIN bling_situacoes s ON s.id = p.situacao_id
       LEFT JOIN LATERAL (SELECT * FROM cotacoes WHERE bling_pedido_id = p.id ORDER BY criado_em DESC LIMIT 1) c ON true
       LEFT JOIN LATERAL (${PESO_DOC('pedido_itens', 'p.id')}) pw ON true
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY p.data DESC NULLS LAST, p.id DESC
      LIMIT $1`, params));
  return json({ pedidos: r.rows });
}

// Peso calculado de um documento pelos itens (peso do produto ou soma dos componentes do kit).
const PESO_DOC = (tabela, docId) => `
  SELECT ROUND(SUM(i.quantidade * COALESCE(pp.peso_unitario, 0)), 3) AS peso_calculado,
         COUNT(*) FILTER (WHERE COALESCE(pp.peso_unitario, 0) = 0) AS itens_sem_peso, COUNT(*) AS n_itens
    FROM ${tabela} i
    LEFT JOIN produtos_bling pr ON pr.id = i.produto_id OR (i.produto_id IS NULL AND pr.codigo = i.codigo)
    LEFT JOIN produtos_peso pp ON pp.id = pr.id
   WHERE i.doc_id = ${docId}`;

const parametrosLista = (url, colunasBusca) => {
  const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite') || '300', 10) || 300, 1), 500);
  const busca = (url.searchParams.get('busca') || '').trim();
  const params = [limite], cond = [];
  if (busca) { params.push(`%${busca}%`); cond.push('(' + colunasBusca.map((c) => `${c} ILIKE $2`).join(' OR ') + ')'); }
  return { params, cond, filtro: url.searchParams.get('filtro') || '' };
};

async function blingPropostas(url, env, ctx) {
  const { params, cond, filtro } = parametrosLista(url, ['p.numero', 'p.cliente', 'p.cidade', 'p.cep', 'p.documento']);
  if (filtro === 'sem_cotacao') cond.push('c.id IS NULL');
  const r = await comBanco(env, ctx, (db) => db.query(
    `SELECT p.id, p.numero, p.data, p.situacao, p.cliente, p.documento, p.cep, p.cidade, p.uf, p.origem_cep,
            p.valor_produtos, p.valor_total, p.frete, p.atualizado_em, pw.peso_calculado, pw.itens_sem_peso, pw.n_itens,
            c.id AS cotacao_id, c.melhor_transportadora, c.melhor_valor, c.transportadora_escolhida, c.valor_escolhido
       FROM propostas_bling p
       LEFT JOIN LATERAL (SELECT * FROM cotacoes WHERE bling_proposta_id = p.id ORDER BY criado_em DESC LIMIT 1) c ON true
       LEFT JOIN LATERAL (${PESO_DOC('proposta_itens', 'p.id')}) pw ON true
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY p.data DESC NULLS LAST, p.id DESC LIMIT $1`, params));
  return json({ propostas: r.rows });
}

async function blingNotas(url, env, ctx) {
  const { params, cond, filtro } = parametrosLista(url, ['n.numero', 'n.cliente', 'n.cidade', 'n.cep', 'n.documento', 'n.transportadora', 'n.chave']);
  if (filtro === 'sem_pedido') cond.push('pd.id IS NULL');
  if (filtro === 'autorizadas') cond.push('n.situacao IN (5, 6, 7)');
  const r = await comBanco(env, ctx, (db) => db.query(
    `SELECT n.id, n.numero, n.serie, n.data_emissao, n.situacao, n.chave, n.cliente, n.documento, n.cep, n.cidade, n.uf,
            n.valor_nota, n.valor_frete, n.frete_por_conta, n.transportadora, n.volumes, n.peso_bruto, n.peso_liquido,
            pd.id AS pedido_id, pd.numero AS pedido_numero, pd.canal, pw.peso_calculado, pw.itens_sem_peso, pw.n_itens
       FROM notas_bling n
       LEFT JOIN pedidos_bling pd ON pd.nota_fiscal_id = n.id
       LEFT JOIN LATERAL (${PESO_DOC('nota_itens', 'n.id')}) pw ON true
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY n.data_emissao DESC NULLS LAST, n.id DESC LIMIT $1`, params));
  return json({ notas: r.rows });
}

async function blingProdutos(url, env, ctx) {
  const { params, cond, filtro } = parametrosLista(url, ['p.codigo', 'p.nome']);
  if (filtro === 'sem_peso') cond.push('COALESCE(pp.peso_unitario, 0) = 0');
  if (filtro === 'kits') cond.push('EXISTS (SELECT 1 FROM produtos_estrutura e WHERE e.produto_id = p.id)');
  const r = await comBanco(env, ctx, (db) => db.query(
    `SELECT p.id, p.codigo, p.nome, p.tipo, p.formato, p.situacao, p.unidade, p.preco, p.peso_liquido, p.peso_bruto,
            p.largura, p.altura, p.profundidade, p.unidade_medida, pp.peso_unitario, pp.origem_peso,
            (SELECT COUNT(*) FROM produtos_estrutura e WHERE e.produto_id = p.id) AS n_componentes
       FROM produtos_bling p LEFT JOIN produtos_peso pp ON pp.id = p.id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY p.nome LIMIT $1`, params));
  return json({ produtos: r.rows });
}

// Itens de um documento com o peso de cada um e os componentes dos kits (base da análise de custo por item).
async function blingItens(url, env, ctx) {
  const tabelas = { pedido: 'pedido_itens', proposta: 'proposta_itens', nota: 'nota_itens', produto: null };
  const tipo = url.searchParams.get('tipo'), id = parseInt(url.searchParams.get('id') || '', 10);
  if (!(tipo in tabelas) || !id) return json({ erro: 'Parâmetros inválidos.' }, 400);
  const r = await comBanco(env, ctx, (db) => db.query(
    tipo === 'produto'
      ? `SELECT 1 AS seq, p.id AS produto_id, p.codigo, p.nome AS descricao, p.unidade, 1 AS quantidade, p.preco AS valor,
                p.preco AS valor_total, p.id AS pid, p.nome, p.peso_bruto, pp.peso_unitario, pp.origem_peso
           FROM produtos_bling p LEFT JOIN produtos_peso pp ON pp.id = p.id WHERE p.id = $1`
      : `SELECT i.seq, i.produto_id, i.codigo, i.descricao, i.unidade, i.quantidade, i.valor, i.valor_total,
                pr.id AS pid, pr.nome, pr.peso_bruto, pp.peso_unitario, pp.origem_peso
           FROM ${tabelas[tipo]} i
           LEFT JOIN produtos_bling pr ON pr.id = i.produto_id OR (i.produto_id IS NULL AND pr.codigo = i.codigo)
           LEFT JOIN produtos_peso pp ON pp.id = pr.id
          WHERE i.doc_id = $1 ORDER BY i.seq`, [id]).then(async (itens) => {
      const pids = [...new Set(itens.rows.map((x) => x.pid).filter(Boolean))];
      const comp = pids.length ? (await db.query(
        `SELECT e.produto_id, e.componente_id, e.quantidade, c.codigo, c.nome, c.unidade, c.preco, c.peso_bruto
           FROM produtos_estrutura e LEFT JOIN produtos_bling c ON c.id = e.componente_id
          WHERE e.produto_id = ANY($1::bigint[]) ORDER BY e.produto_id, c.nome`, [pids])).rows : [];
      return itens.rows.map((i) => ({ ...i, componentes: comp.filter((c) => String(c.produto_id) === String(i.pid)) }));
    }));
  return json({ itens: r });
}

async function obterCotacao(id, env, ctx) {
  const [r, m] = await comBanco(env, ctx, (db) => Promise.all([
    db.query('SELECT * FROM cotacoes WHERE id = $1', [id]),
    db.query('SELECT * FROM cotacao_valores_manuais WHERE cotacao_id = $1 ORDER BY id', [id])]));
  if (!r.rows.length) return json({ erro: 'Cotação não encontrada.' }, 404);
  return json({ ...r.rows[0], valores_manuais: m.rows, motivos: MOTIVOS });
}

// Tarefa agendada (wrangler.jsonc → triggers.crons, a cada 5 min): importa os pedidos do Bling
// (o que também renova o token) e mantém o banco ativo.
async function tarefaAgendada(env, ctx) {
  await comBanco(env, ctx, async (db) => {
    await db.query('SELECT 1');
    if (!blingConfigurado(env)) return;
    const conectado = (await db.query('SELECT 1 FROM bling_tokens WHERE id = 1')).rows.length > 0;
    if (!conectado) return;
    try {
      const r = await sincronizarTudo(env, db);
      console.log('Bling: sincronização –', r.mensagem, `(${r.chamadas} chamadas)`);
    } catch (e) {
      console.error('Bling: falha na sincronização –', e.message);
    }
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tarefaAgendada(env, ctx));
  },

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
      if (url.pathname === '/api/bling/pedido') return await blingPedido(url, env, ctx, usuario);
      if (url.pathname === '/api/bling/pedidos' && request.method === 'GET') return await blingPedidos(url, env, ctx);
      if (url.pathname === '/api/bling/sincronizar' && request.method === 'POST') return await blingSincronizar(env, ctx);
      if (url.pathname === '/api/bling/propostas') return await blingPropostas(url, env, ctx);
      if (url.pathname === '/api/bling/notas') return await blingNotas(url, env, ctx);
      if (url.pathname === '/api/bling/produtos') return await blingProdutos(url, env, ctx);
      if (url.pathname === '/api/bling/itens') return await blingItens(url, env, ctx);
      const m = url.pathname.match(/^\/api\/cotacoes\/(\d+)$/);
      if (m && request.method === 'GET') return await obterCotacao(m[1], env, ctx);
      const mm = url.pathname.match(/^\/api\/cotacoes\/(\d+)\/manual$/);
      if (mm && request.method === 'POST') return await adicionarManual(mm[1], request, env, ctx, usuario);
      const mv = url.pathname.match(/^\/api\/manuais\/(\d+)$/);
      if (mv && (request.method === 'DELETE' || request.method === 'PATCH')) return await alterarManual(mv[1], request, env, ctx);
      if (url.pathname === '/api/divergencias' && request.method === 'GET') return await divergencias(url, env, ctx);
      if (url.pathname === '/api/braspress/status') {
        if (!contasBraspress(env).length) return json({ configurado: false });
        const contas = await comBanco(env, ctx, (db) => infoContas(env, db));
        return json({ configurado: true, contas: contas.map(({ usuario, senha, ...c }) => c) });
      }
      if (url.pathname === '/api/braspress/cotar' && request.method === 'POST') {
        let d; try { d = await request.json(); } catch { return json({ erro: 'Corpo da requisição inválido.' }, 400); }
        return json(await comBanco(env, ctx, (db) => cotarBraspress(env, db, d, usuario)));
      }
      if (url.pathname === '/api/motivos') return json({ motivos: MOTIVOS });
      return json({ erro: 'Rota não encontrada.' }, 404);
    } catch (e) {
      if (e instanceof BlingErro) return json({ erro: e.message, codigo: e.codigo }, e.status);
      if (e instanceof BraspressErro) return json({ erro: e.message }, e.status === 401 ? 502 : e.status);
      console.error('Erro na API', url.pathname, e);
      return json({ erro: 'Erro ao acessar o banco de dados.', detalhe: String(e && e.message || e) }, 500);
    }
  },
};
