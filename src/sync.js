// Importação de documentos do Bling: pedidos de venda, propostas comerciais, notas fiscais de saída e produtos.
// Cada documento é guardado com colunas fixas (para filtrar e comparar) e a resposta completa do Bling (coluna `dados`).
// Os itens ficam em tabelas próprias; os kits (produtos com composição) têm os componentes em produtos_estrutura.

import { BlingErro, blingGet, tokenValido, soDigitos, num } from './bling.js';

export const SCHEMA_DOCS = `
ALTER TABLE pedidos_bling ADD COLUMN IF NOT EXISTS canal TEXT;
ALTER TABLE pedidos_bling ADD COLUMN IF NOT EXISTS numero_loja TEXT;
ALTER TABLE pedidos_bling ADD COLUMN IF NOT EXISTS loja_id BIGINT;
ALTER TABLE pedidos_bling ADD COLUMN IF NOT EXISTS nota_fiscal_id BIGINT;
ALTER TABLE pedidos_bling ADD COLUMN IF NOT EXISTS custo_frete_marketplace NUMERIC(14,2);
ALTER TABLE pedidos_bling ADD COLUMN IF NOT EXISTS assinatura TEXT;
CREATE INDEX IF NOT EXISTS pedidos_bling_nf_idx ON pedidos_bling (nota_fiscal_id);

CREATE TABLE IF NOT EXISTS propostas_bling (
  id BIGINT PRIMARY KEY, numero TEXT, data DATE, situacao TEXT, contato_id BIGINT, cliente TEXT, documento TEXT,
  cep TEXT, cidade TEXT, uf TEXT, origem_cep TEXT, valor_produtos NUMERIC(14,2), valor_total NUMERIC(14,2), frete NUMERIC(14,2),
  assinatura TEXT, dados JSONB, importado_em TIMESTAMPTZ NOT NULL DEFAULT now(), importado_por TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS propostas_bling_data_idx ON propostas_bling (data DESC, id DESC);

CREATE TABLE IF NOT EXISTS notas_bling (
  id BIGINT PRIMARY KEY, numero TEXT, serie TEXT, data_emissao TIMESTAMPTZ, situacao INTEGER, chave TEXT,
  cliente TEXT, documento TEXT, cep TEXT, cidade TEXT, uf TEXT, valor_nota NUMERIC(14,2), valor_frete NUMERIC(14,2),
  frete_por_conta INTEGER, transportadora TEXT, transportadora_doc TEXT, volumes INTEGER,
  peso_bruto NUMERIC(12,3), peso_liquido NUMERIC(12,3),
  assinatura TEXT, dados JSONB, importado_em TIMESTAMPTZ NOT NULL DEFAULT now(), importado_por TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notas_bling_data_idx ON notas_bling (data_emissao DESC, id DESC);

CREATE TABLE IF NOT EXISTS produtos_bling (
  id BIGINT PRIMARY KEY, codigo TEXT, nome TEXT, tipo TEXT, formato TEXT, situacao TEXT, unidade TEXT,
  preco NUMERIC(14,4), peso_liquido NUMERIC(12,4), peso_bruto NUMERIC(12,4),
  largura NUMERIC(12,3), altura NUMERIC(12,3), profundidade NUMERIC(12,3), unidade_medida TEXT, volumes INTEGER,
  assinatura TEXT, dados JSONB, importado_em TIMESTAMPTZ NOT NULL DEFAULT now(), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS produtos_bling_codigo_idx ON produtos_bling (codigo);
CREATE TABLE IF NOT EXISTS produtos_estrutura (
  produto_id BIGINT NOT NULL, componente_id BIGINT NOT NULL, quantidade NUMERIC(14,4) NOT NULL,
  PRIMARY KEY (produto_id, componente_id)
);

CREATE TABLE IF NOT EXISTS pedido_itens (
  doc_id BIGINT NOT NULL, seq INTEGER NOT NULL, produto_id BIGINT, codigo TEXT, descricao TEXT, unidade TEXT,
  quantidade NUMERIC(14,4), valor NUMERIC(14,4), desconto NUMERIC(14,4), valor_total NUMERIC(14,2), PRIMARY KEY (doc_id, seq)
);
CREATE TABLE IF NOT EXISTS proposta_itens (LIKE pedido_itens INCLUDING ALL);
CREATE TABLE IF NOT EXISTS nota_itens (LIKE pedido_itens INCLUDING ALL);

CREATE TABLE IF NOT EXISTS bling_sync_trava (id INT PRIMARY KEY, ate TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS bling_sync_recurso (
  recurso TEXT PRIMARY KEY, ultima_execucao TIMESTAMPTZ, ultimo_completo TIMESTAMPTZ, mensagem TEXT
);

ALTER TABLE cotacoes ADD COLUMN IF NOT EXISTS bling_proposta_id BIGINT;

-- Peso unitário do produto: o peso bruto cadastrado; se for zero (kit sem peso próprio), a soma dos componentes.
CREATE OR REPLACE VIEW produtos_peso AS
SELECT p.id, p.codigo,
  CASE WHEN COALESCE(p.peso_bruto, 0) > 0 THEN p.peso_bruto
       ELSE (SELECT SUM(e.quantidade * COALESCE(c.peso_bruto, 0)) FROM produtos_estrutura e
               JOIN produtos_bling c ON c.id = e.componente_id WHERE e.produto_id = p.id) END AS peso_unitario,
  CASE WHEN COALESCE(p.peso_bruto, 0) > 0 THEN 'produto' ELSE 'componentes' END AS origem_peso
FROM produtos_bling p;
`;

// ---------------------------------------------------------------- canais de venda
// CNPJ do intermediador informado no pedido → nome do marketplace.
const MARKETPLACES = {
  '03007331000141': 'Mercado Livre',
  '35635824000112': 'Shopee',
  '15436940000103': 'Amazon',
  '47960950000121': 'Magazine Luiza',
};
export function canalDoPedido(p) {
  const cnpj = soDigitos(p.intermediador && p.intermediador.cnpj);
  if (MARKETPLACES[cnpj]) return MARKETPLACES[cnpj];
  if (cnpj || (p.intermediador && p.intermediador.nomeUsuario)) return 'Marketplace';
  if ((p.loja && Number(p.loja.id) > 0) || (p.numeroLoja && String(p.numeroLoja).trim())) return 'Loja virtual';
  return 'Venda direta';
}

// ---------------------------------------------------------------- normalização
const sitTexto = (s) => (s == null ? null : typeof s === 'object' ? String(s.valor ?? s.nome ?? s.id ?? '') : String(s));

function enderecoDe(origens) {
  for (const [end, nome] of origens) {
    if (end && soDigitos(end.cep).length === 8) {
      return { cep: soDigitos(end.cep), cidade: end.municipio || end.cidade || '', uf: end.uf || '', origemCep: nome };
    }
  }
  return { cep: null, cidade: '', uf: '', origemCep: '' };
}

function itensDe(lista) {
  return (lista || []).map((i, k) => ({
    seq: k + 1,
    produto_id: num(i.produto && i.produto.id),
    codigo: i.codigo || (i.produto && i.produto.codigo) || null,
    descricao: i.descricao || (i.produto && i.produto.nome) || null,
    unidade: i.unidade || null,
    quantidade: num(i.quantidade),
    valor: num(i.valor),
    desconto: num(i.desconto),
    valor_total: num(i.valorTotal) ?? (num(i.quantidade) != null && num(i.valor) != null ? +(i.quantidade * i.valor).toFixed(2) : null),
  }));
}

export function normalizarPedido(p) {
  const tr = p.transporte || {};
  const end = enderecoDe([
    [tr.etiqueta, 'etiqueta de transporte'],
    [p._contato && p._contato.endereco && p._contato.endereco.entrega, 'cadastro do cliente (entrega)'],
    [p._contato && p._contato.endereco && p._contato.endereco.geral, 'cadastro do cliente'],
  ]);
  const sit = p.situacao || {};
  return {
    id: p.id,
    numero: String(p.numero ?? ''),
    data: p.data || null,
    situacaoId: num(sit.id),
    cliente: (p.contato && p.contato.nome) || '',
    documento: (p.contato && p.contato.numeroDocumento) || (p._contato && p._contato.numeroDocumento) || null,
    ...end,
    pesoBruto: num(tr.pesoBruto),
    volumes: num(tr.quantidadeVolumes),
    valorProdutos: num(p.totalProdutos),
    valorTotal: num(p.total),
    freteAtual: num(tr.frete),
    fretePorConta: num(tr.fretePorConta),
    transportadora: (tr.contato && tr.contato.nome) || null,
    canal: canalDoPedido(p),
    numeroLoja: p.numeroLoja ? String(p.numeroLoja) : null,
    lojaId: num(p.loja && p.loja.id),
    notaFiscalId: num(p.notaFiscal && p.notaFiscal.id) || null,
    custoFreteMarketplace: num(p.taxas && p.taxas.custoFrete),
    itens: itensDe(p.itens),
  };
}

export function normalizarProposta(p) {
  const end = enderecoDe([
    [p._contato && p._contato.endereco && p._contato.endereco.entrega, 'cadastro do cliente (entrega)'],
    [p._contato && p._contato.endereco && p._contato.endereco.geral, 'cadastro do cliente'],
  ]);
  return {
    id: p.id,
    numero: String(p.numero ?? ''),
    data: p.data || null,
    situacao: sitTexto(p.situacao),
    contatoId: num(p.contato && p.contato.id),
    cliente: (p.contato && p.contato.nome) || '',
    documento: (p.contato && p.contato.numeroDocumento) || (p._contato && p._contato.numeroDocumento) || null,
    ...end,
    valorProdutos: num(p.totalProdutos),
    valorTotal: num(p.total),
    frete: num((p.transporte && p.transporte.frete) ?? p.frete),
    itens: itensDe(p.itens),
  };
}

export function normalizarNota(n) {
  const tr = n.transporte || {};
  const c = n.contato || {};
  const end = enderecoDe([[c.endereco, 'destinatário da nota']]);
  const vol = tr.volume || {};
  const transp = tr.transportador || tr.transportadora || {};
  return {
    id: n.id,
    numero: String(n.numero ?? ''),
    serie: n.serie != null ? String(n.serie) : null,
    dataEmissao: n.dataEmissao || n.dataOperacao || null,
    situacao: num(n.situacao && typeof n.situacao === 'object' ? n.situacao.id : n.situacao),
    chave: n.chaveAcesso || n.chave || null,
    cliente: c.nome || '',
    documento: c.numeroDocumento || null,
    ...end,
    valorNota: num(n.valorNota ?? n.valorTotal ?? n.total),
    valorFrete: num(n.valorFrete ?? tr.frete),
    fretePorConta: num(tr.fretePorConta),
    transportadora: transp.nome || null,
    transportadoraDoc: transp.numeroDocumento || null,
    volumes: num(tr.quantidadeVolumes ?? vol.quantidade ?? (Array.isArray(tr.volumes) ? tr.volumes.length : null)),
    pesoBruto: num(tr.pesoBruto ?? vol.pesoBruto),
    pesoLiquido: num(tr.pesoLiquido ?? vol.pesoLiquido),
    itens: itensDe(n.itens),
  };
}

export function normalizarProduto(p) {
  const d = p.dimensoes || {};
  const comp = (p.estrutura && p.estrutura.componentes) || [];
  return {
    id: p.id,
    codigo: p.codigo || null,
    nome: p.nome || null,
    tipo: p.tipo || null,
    formato: p.formato || null,
    situacao: p.situacao || null,
    unidade: p.unidade || null,
    preco: num(p.preco),
    pesoLiquido: num(p.pesoLiquido),
    pesoBruto: num(p.pesoBruto),
    largura: num(d.largura),
    altura: num(d.altura),
    profundidade: num(d.profundidade),
    unidadeMedida: d.unidadeMedida != null ? String(d.unidadeMedida) : null,
    volumes: num(p.volumes),
    componentes: comp
      .map((c) => ({ componente_id: num(c.produto && c.produto.id), quantidade: num(c.quantidade) }))
      .filter((c) => c.componente_id && c.quantidade != null),
  };
}

// ---------------------------------------------------------------- gravação
async function upsert(db, tabela, colunas, linhas, importadoPor) {
  if (!linhas.length) return;
  const nomes = Object.keys(colunas);
  const temImportado = importadoPor !== undefined;
  const insertCols = [...nomes, ...(temImportado ? ['importado_por'] : []), 'atualizado_em'];
  const selectCols = [...nomes.map((c) => `x.${c}`), ...(temImportado ? ['$2'] : []), 'now()'];
  const update = [...nomes.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`), 'atualizado_em = now()'];
  await db.query(
    `INSERT INTO ${tabela} (${insertCols.join(', ')})
     SELECT ${selectCols.join(', ')}
       FROM jsonb_to_recordset($1::jsonb) AS x(${nomes.map((c) => `${c} ${colunas[c]}`).join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${update.join(', ')}`,
    temImportado ? [JSON.stringify(linhas), importadoPor] : [JSON.stringify(linhas)],
  );
}

async function gravarItens(db, tabela, docs) {
  if (!docs.length) return;
  const ids = docs.map((d) => d.id);
  const linhas = docs.flatMap((d) => d.itens.map((i) => ({ doc_id: d.id, ...i })));
  await db.query(`DELETE FROM ${tabela} WHERE doc_id = ANY($1::bigint[])`, [ids]);
  if (!linhas.length) return;
  await db.query(
    `INSERT INTO ${tabela} (doc_id, seq, produto_id, codigo, descricao, unidade, quantidade, valor, desconto, valor_total)
     SELECT doc_id, seq, produto_id, codigo, descricao, unidade, quantidade, valor, desconto, valor_total
       FROM jsonb_to_recordset($1::jsonb) AS x(doc_id BIGINT, seq INTEGER, produto_id BIGINT, codigo TEXT, descricao TEXT,
         unidade TEXT, quantidade NUMERIC, valor NUMERIC, desconto NUMERIC, valor_total NUMERIC)`,
    [JSON.stringify(linhas)],
  );
}

const semXml = (b) => { if (b && typeof b === 'object') { delete b.xml; } return b; };

export async function gravarPedidos(db, lista, importadoPor) {
  await upsert(db, 'pedidos_bling', {
    id: 'BIGINT', numero: 'TEXT', data: 'DATE', situacao_id: 'BIGINT', cliente: 'TEXT', documento: 'TEXT', cep: 'TEXT',
    cidade: 'TEXT', uf: 'TEXT', origem_cep: 'TEXT', peso_bruto: 'NUMERIC', volumes: 'INTEGER', valor_produtos: 'NUMERIC',
    valor_total: 'NUMERIC', frete_bling: 'NUMERIC', frete_por_conta: 'INTEGER', transportadora_bling: 'TEXT', canal: 'TEXT',
    numero_loja: 'TEXT', loja_id: 'BIGINT', nota_fiscal_id: 'BIGINT', custo_frete_marketplace: 'NUMERIC', assinatura: 'TEXT', dados: 'JSONB',
  }, lista.map(({ n, bruto, assinatura }) => ({
    id: n.id, numero: n.numero, data: n.data, situacao_id: n.situacaoId, cliente: n.cliente, documento: n.documento, cep: n.cep,
    cidade: n.cidade, uf: n.uf, origem_cep: n.origemCep, peso_bruto: n.pesoBruto, volumes: n.volumes, valor_produtos: n.valorProdutos,
    valor_total: n.valorTotal, frete_bling: n.freteAtual, frete_por_conta: n.fretePorConta, transportadora_bling: n.transportadora,
    canal: n.canal, numero_loja: n.numeroLoja, loja_id: n.lojaId, nota_fiscal_id: n.notaFiscalId,
    custo_frete_marketplace: n.custoFreteMarketplace, assinatura: assinatura ?? null, dados: semXml(bruto),
  })), importadoPor);
  await gravarItens(db, 'pedido_itens', lista.map((x) => x.n));
}

export async function gravarPropostas(db, lista, importadoPor) {
  await upsert(db, 'propostas_bling', {
    id: 'BIGINT', numero: 'TEXT', data: 'DATE', situacao: 'TEXT', contato_id: 'BIGINT', cliente: 'TEXT', documento: 'TEXT',
    cep: 'TEXT', cidade: 'TEXT', uf: 'TEXT', origem_cep: 'TEXT', valor_produtos: 'NUMERIC', valor_total: 'NUMERIC',
    frete: 'NUMERIC', assinatura: 'TEXT', dados: 'JSONB',
  }, lista.map(({ n, bruto, assinatura }) => ({
    id: n.id, numero: n.numero, data: n.data, situacao: n.situacao, contato_id: n.contatoId, cliente: n.cliente,
    documento: n.documento, cep: n.cep, cidade: n.cidade, uf: n.uf, origem_cep: n.origemCep, valor_produtos: n.valorProdutos,
    valor_total: n.valorTotal, frete: n.frete, assinatura: assinatura ?? null, dados: semXml(bruto),
  })), importadoPor);
  await gravarItens(db, 'proposta_itens', lista.map((x) => x.n));
}

export async function gravarNotas(db, lista, importadoPor) {
  await upsert(db, 'notas_bling', {
    id: 'BIGINT', numero: 'TEXT', serie: 'TEXT', data_emissao: 'TIMESTAMPTZ', situacao: 'INTEGER', chave: 'TEXT',
    cliente: 'TEXT', documento: 'TEXT', cep: 'TEXT', cidade: 'TEXT', uf: 'TEXT', valor_nota: 'NUMERIC', valor_frete: 'NUMERIC',
    frete_por_conta: 'INTEGER', transportadora: 'TEXT', transportadora_doc: 'TEXT', volumes: 'INTEGER', peso_bruto: 'NUMERIC',
    peso_liquido: 'NUMERIC', assinatura: 'TEXT', dados: 'JSONB',
  }, lista.map(({ n, bruto, assinatura }) => ({
    id: n.id, numero: n.numero, serie: n.serie, data_emissao: n.dataEmissao, situacao: n.situacao, chave: n.chave,
    cliente: n.cliente, documento: n.documento, cep: n.cep, cidade: n.cidade, uf: n.uf, valor_nota: n.valorNota,
    valor_frete: n.valorFrete, frete_por_conta: n.fretePorConta, transportadora: n.transportadora,
    transportadora_doc: n.transportadoraDoc, volumes: n.volumes, peso_bruto: n.pesoBruto, peso_liquido: n.pesoLiquido,
    assinatura: assinatura ?? null, dados: semXml(bruto),
  })), importadoPor);
  await gravarItens(db, 'nota_itens', lista.map((x) => x.n));
}

export async function gravarProdutos(db, lista) {
  await upsert(db, 'produtos_bling', {
    id: 'BIGINT', codigo: 'TEXT', nome: 'TEXT', tipo: 'TEXT', formato: 'TEXT', situacao: 'TEXT', unidade: 'TEXT',
    preco: 'NUMERIC', peso_liquido: 'NUMERIC', peso_bruto: 'NUMERIC', largura: 'NUMERIC', altura: 'NUMERIC',
    profundidade: 'NUMERIC', unidade_medida: 'TEXT', volumes: 'INTEGER', assinatura: 'TEXT', dados: 'JSONB',
  }, lista.map(({ n, bruto, assinatura }) => ({
    id: n.id, codigo: n.codigo, nome: n.nome, tipo: n.tipo, formato: n.formato, situacao: n.situacao, unidade: n.unidade,
    preco: n.preco, peso_liquido: n.pesoLiquido, peso_bruto: n.pesoBruto, largura: n.largura, altura: n.altura,
    profundidade: n.profundidade, unidade_medida: n.unidadeMedida, volumes: n.volumes, assinatura: assinatura ?? null, dados: bruto,
  })));
  if (!lista.length) return;
  const ids = lista.map((x) => x.n.id);
  const comp = lista.flatMap((x) => x.n.componentes.map((c) => ({ produto_id: x.n.id, ...c })));
  await db.query('DELETE FROM produtos_estrutura WHERE produto_id = ANY($1::bigint[])', [ids]);
  if (comp.length) {
    await db.query(
      `INSERT INTO produtos_estrutura (produto_id, componente_id, quantidade)
       SELECT produto_id, componente_id, SUM(quantidade) FROM jsonb_to_recordset($1::jsonb)
         AS x(produto_id BIGINT, componente_id BIGINT, quantidade NUMERIC) GROUP BY produto_id, componente_id`,
      [JSON.stringify(comp)],
    );
  }
}

// ---------------------------------------------------------------- leitura de um documento
async function completarContato(bruto, get, precisa) {
  if (!precisa || !bruto.contato || !bruto.contato.id) return false;
  try {
    const c = await get(`/contatos/${bruto.contato.id}`);
    if (c && c.data) bruto._contato = { endereco: c.data.endereco || null, numeroDocumento: c.data.numeroDocumento || null };
    return false;
  } catch (e) {
    if (e.codigo !== 'permissao') throw e;
    return true; // sem permissão de Contatos: segue sem endereço
  }
}
const pedidoSemCep = (b) => soDigitos(b.transporte && b.transporte.etiqueta && b.transporte.etiqueta.cep).length !== 8;

// Busca o pedido de venda pelo número (o que aparece na tela do Bling).
export async function buscarPedido(token, numero, fetchImpl = fetch) {
  const n = soDigitos(numero);
  if (!n) throw new BlingErro('Informe o número do pedido.', 400, 'entrada');
  const get = (c) => blingGet(token, c, fetchImpl);
  const lista = await get(`/pedidos/vendas?numero=${encodeURIComponent(n)}&limite=100`);
  const dados = (lista && lista.data) || [];
  const achado = dados.find((p) => String(p.numero) === n);
  if (!achado) {
    const nums = dados.map((p) => +p.numero).filter((x) => !isNaN(x));
    const faixa = nums.length ? ` A busca devolveu ${nums.length} pedido(s), do nº ${Math.min(...nums)} ao ${Math.max(...nums)}.` : ' A busca não devolveu nenhum pedido.';
    throw new BlingErro(`Pedido ${n} não encontrado no Bling.${faixa}`, 404, 'nao_encontrado');
  }
  const det = await get(`/pedidos/vendas/${achado.id}`);
  const p = det && det.data;
  if (!p) throw new BlingErro(`Pedido ${n} não encontrado no Bling.`, 404, 'nao_encontrado');
  await completarContato(p, get, pedidoSemCep(p));
  return { ...normalizarPedido(p), _bruto: p };
}

// Busca um documento pelo número: primeiro no banco (já importado), depois no Bling
// (filtro por número, se o Bling aceitar, e senão as páginas mais recentes da lista).
async function buscarDocNumero(db, token, numero, fetchImpl, cfg) {
  const n = soDigitos(numero).replace(/^0+(?=\d)/, '');
  const get = (c) => blingGet(token, c, fetchImpl);
  const igual = (x) => soDigitos(x).replace(/^0+(?=\d)/, '') === n;
  let id = ((await db.query(`SELECT id FROM ${cfg.tabela} WHERE ltrim(numero, '0') = $1 ORDER BY id DESC LIMIT 1`, [n])).rows[0] || {}).id;
  if (!id) {
    const tentativas = [`${cfg.lista}?${cfg.extra}numero=${n}&limite=100`];
    for (let pg = 1; pg <= 5; pg++) tentativas.push(`${cfg.lista}?${cfg.extra}pagina=${pg}&limite=100`);
    for (const url of tentativas) {
      let lista;
      try { lista = await get(url); } catch (e) { if (e.codigo === 'parametro') continue; throw e; }
      const dados = (lista && lista.data) || [];
      const achado = dados.find((p) => igual(p.numero) && (!cfg.filtrar || cfg.filtrar(p)));
      if (achado) { id = achado.id; break; }
      if (url.includes('pagina=') && dados.length < 100) break; // acabou a lista
    }
  }
  if (!id) return null;
  const det = await get(cfg.detalhe(id));
  const p = det && det.data;
  if (!p) return null;
  if (cfg.contato) await completarContato(p, get, true);
  return { ...cfg.normalizar(p), _bruto: p };
}
export const buscarProposta = (db, token, numero, fetchImpl = fetch) => buscarDocNumero(db, token, numero, fetchImpl,
  { tabela: 'propostas_bling', lista: '/propostas-comerciais', extra: '', detalhe: (id) => `/propostas-comerciais/${id}`, contato: true, normalizar: normalizarProposta });
// Só notas de saída (venda).
export const buscarNota = (db, token, numero, fetchImpl = fetch) => buscarDocNumero(db, token, numero, fetchImpl,
  { tabela: 'notas_bling', lista: '/nfe', extra: 'tipo=1&', detalhe: (id) => `/nfe/${id}`, contato: false, normalizar: normalizarNota,
    filtrar: (p) => p.tipo == null || +p.tipo === 1 });

// Importa na hora os produtos (e componentes de kits) que faltam para calcular o peso de um documento.
export async function completarProdutos(db, token, ids, fetchImpl = fetch, max = 15) {
  const get = (c) => blingGet(token, c, fetchImpl);
  let lidos = 0;
  for (let rodada = 0; rodada < 2 && lidos < max; rodada++) {
    const alvo = rodada === 0 ? ids.filter(Boolean) : (await db.query(
      `SELECT DISTINCT e.componente_id AS id FROM produtos_estrutura e WHERE e.produto_id = ANY($1::bigint[])`, [ids])).rows.map((r) => r.id);
    if (!alvo.length) continue;
    const ja = new Set((await db.query('SELECT id FROM produtos_bling WHERE id = ANY($1::bigint[])', [alvo])).rows.map((r) => String(r.id)));
    const gravar = [];
    for (const id of alvo.filter((x) => !ja.has(String(x)))) {
      if (lidos >= max) break;
      const det = await get(`/produtos/${id}`); lidos++;
      if (det && det.data) gravar.push({ n: normalizarProduto(det.data), bruto: det.data, assinatura: RECURSOS.find((r) => r.nome === 'produtos').assinatura(det.data) });
    }
    if (gravar.length) await gravarProdutos(db, gravar, 'busca manual');
  }
  return lidos;
}

// ---------------------------------------------------------------- importação automática
const dataISO = (d) => d.toISOString().slice(0, 10);

// Configuração de cada tipo de documento.
// filtros(d, primeira): variações de filtro tentadas em ordem; se o Bling recusar uma (HTTP 400), tenta a próxima.
// null = não listar (só buscar os que faltam).
export const RECURSOS = [
  {
    nome: 'pedidos', rotulo: 'pedidos', lista: '/pedidos/vendas', detalhe: (id) => `/pedidos/vendas/${id}`,
    diasIniciais: 30, diasRelidos: 1, releituraMin: 30, maxPaginas: 3,
    filtros: (d) => [`dataAlteracaoInicial=${d}`, `dataInicial=${d}`],
    assinatura: (p) => `${p.situacao && p.situacao.id}|${num(p.total)}`,
    precisaContato: pedidoSemCep, normalizar: normalizarPedido, gravar: gravarPedidos, contaSituacao: true,
  },
  {
    nome: 'propostas', rotulo: 'propostas', lista: '/propostas-comerciais', detalhe: (id) => `/propostas-comerciais/${id}`,
    diasIniciais: 30, diasRelidos: 7, releituraMin: 60, maxPaginas: 3,
    filtros: (d) => [`dataInicial=${d}`, ''],
    assinatura: (p) => `${sitTexto(p.situacao)}|${num(p.total)}`,
    precisaContato: () => true, normalizar: normalizarProposta, gravar: gravarPropostas,
  },
  {
    nome: 'notas', rotulo: 'notas fiscais', lista: '/nfe', detalhe: (id) => `/nfe/${id}`,
    diasIniciais: 30, diasRelidos: 7, releituraMin: null, maxPaginas: 3,
    filtros: (d) => [`tipo=1&dataEmissaoInicial=${d} 00:00:00`, `tipo=1&dataEmissaoInicial=${d}`, 'tipo=1'],
    filtrarLista: (n) => n.tipo == null || Number(n.tipo) === 1,
    assinatura: (n) => `${n.situacao && typeof n.situacao === 'object' ? n.situacao.id : n.situacao}`,
    precisaContato: () => false, normalizar: normalizarNota, gravar: gravarNotas,
  },
  {
    nome: 'produtos', rotulo: 'produtos', lista: '/produtos', detalhe: (id) => `/produtos/${id}`,
    diasIniciais: null, diasRelidos: 1, releituraMin: null, maxPaginas: 5,
    filtros: (d, primeira) => (primeira ? [''] : [`dataAlteracaoInicial=${d}`, `dataAlteracaoInicial=${d} 00:00:00`, null]),
    assinatura: (p) => `${num(p.preco)}|${p.situacao}|${p.formato}`,
    precisaContato: () => false, normalizar: normalizarProduto, gravar: gravarProdutos,
    // produtos usados em itens (ou como componentes) que ainda não estão no banco
    faltantes: async (db) => (await db.query(
      `SELECT DISTINCT x.id FROM (
         SELECT produto_id AS id FROM pedido_itens UNION SELECT produto_id FROM proposta_itens
         UNION SELECT componente_id FROM produtos_estrutura) x
       WHERE x.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM produtos_bling p WHERE p.id = x.id) LIMIT 50`)).rows.map((r) => r.id),
  },
];
const TABELA = { pedidos: 'pedidos_bling', propostas: 'propostas_bling', notas: 'notas_bling', produtos: 'produtos_bling' };

async function sincronizarRecurso(R, s) {
  const { db, get } = s;
  const st = (await db.query('SELECT ultimo_completo FROM bling_sync_recurso WHERE recurso = $1', [R.nome])).rows[0];
  const primeira = !(st && st.ultimo_completo);
  const inicioCiclo = new Date();
  const desde = primeira
    ? new Date(Date.now() - (R.diasIniciais || 3650) * 864e5)
    : new Date(new Date(st.ultimo_completo).getTime() - R.diasRelidos * 864e5);

  // 1) lista
  const lista = [];
  let listaCompleta = true;
  const variantes = R.filtros(dataISO(desde), primeira);
  let filtro;
  for (let i = 0; i < variantes.length; i++) {
    filtro = variantes[i];
    if (filtro === null) break;
    try {
      const r = await get(`${R.lista}?pagina=1&limite=100${filtro ? '&' + filtro : ''}`);
      lista.push(...((r && r.data) || []));
      break;
    } catch (e) {
      if (e.codigo !== 'parametro' || i === variantes.length - 1) throw e;
    }
  }
  if (filtro !== null && lista.length === 100) {
    for (let pagina = 2; pagina <= R.maxPaginas; pagina++) {
      if (s.chamadas >= s.limite) { listaCompleta = false; break; }
      const r = await get(`${R.lista}?pagina=${pagina}&limite=100${filtro ? '&' + filtro : ''}`);
      const d = (r && r.data) || [];
      lista.push(...d);
      if (d.length < 100) break;
      if (pagina === R.maxPaginas) listaCompleta = false;
    }
  }
  const listaFiltrada = R.filtrarLista ? lista.filter(R.filtrarLista) : lista;

  // 2) fila: faltantes, novos, alterados e (se configurado) os não lidos há algum tempo
  const salvos = new Map();
  const ids = listaFiltrada.map((p) => p.id);
  if (ids.length) {
    const r = await db.query(`SELECT id, assinatura, atualizado_em FROM ${TABELA[R.nome]} WHERE id = ANY($1::bigint[])`, [ids]);
    r.rows.forEach((x) => salvos.set(String(x.id), x));
  }
  const fila = [];
  if (R.faltantes) (await R.faltantes(db)).forEach((id) => fila.push({ id, k: -1, ass: null }));
  for (const p of listaFiltrada) {
    const ass = R.assinatura(p);
    const sv = salvos.get(String(p.id));
    let k = 9;
    if (!sv) k = 0;
    else if (sv.assinatura !== ass) k = 1;
    else if (R.releituraMin && Date.now() - new Date(sv.atualizado_em).getTime() > R.releituraMin * 60e3) k = 2;
    if (k < 9 && !fila.some((f) => String(f.id) === String(p.id))) fila.push({ id: p.id, k, ass, data: p.data || p.dataEmissao || '' });
  }
  fila.sort((a, b) => a.k - b.k || String(b.data || '').localeCompare(String(a.data || '')));

  // 3) detalhes
  const gravar = [];
  let pendentes = 0;
  for (const f of fila) {
    if (s.chamadas + 2 > s.limite) { pendentes++; continue; }
    const det = await get(R.detalhe(f.id));
    const bruto = det && det.data;
    if (!bruto) continue;
    if (!s.semContatos && R.precisaContato(bruto)) s.semContatos = await completarContato(bruto, get, true);
    gravar.push({ n: R.normalizar(bruto), bruto, assinatura: f.ass ?? R.assinatura(bruto) });
  }
  await R.gravar(db, gravar, 'importação automática');

  // 4) nomes das situações de pedido
  if (R.contaSituacao) {
    const sits = [...new Set(gravar.map((x) => x.n.situacaoId).filter((x) => x != null))];
    if (sits.length) {
      const conhecidas = new Set((await db.query('SELECT id FROM bling_situacoes WHERE id = ANY($1::bigint[])', [sits])).rows.map((x) => String(x.id)));
      for (const id of sits.filter((x) => !conhecidas.has(String(x)))) {
        if (s.chamadas + 1 > s.limite) break;
        try {
          const r = await get(`/situacoes/${id}`);
          const nome = r && r.data && r.data.nome;
          if (nome) await db.query('INSERT INTO bling_situacoes (id, nome) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome', [id, nome]);
        } catch { /* nome da situação é opcional */ }
      }
    }
  }

  // 5) estado
  const completo = pendentes === 0 && listaCompleta;
  const msg = `${gravar.length} ${R.rotulo} lido(s)${pendentes ? `, ${pendentes} pendente(s)` : ''}`;
  await db.query(
    `INSERT INTO bling_sync_recurso (recurso, ultima_execucao, ultimo_completo, mensagem) VALUES ($1, now(), $2, $3)
     ON CONFLICT (recurso) DO UPDATE SET ultima_execucao = now(),
       ultimo_completo = COALESCE($2, bling_sync_recurso.ultimo_completo), mensagem = $3`,
    [R.nome, completo ? inicioCiclo : null, msg],
  );
  return { recurso: R.nome, lidos: gravar.length, pendentes, completo, mensagem: msg };
}

// Roda todos os recursos em sequência, dividindo um limite de chamadas ao Bling por execução
// (plano gratuito do Cloudflare: 50 subrequisições). Um recurso com erro não impede os demais.
export async function sincronizarTudo(env, db, fetchImpl = fetch, opcoes = {}) {
  const token = await tokenValido(env, db, fetchImpl);
  const s = { db, chamadas: 0, limite: opcoes.limiteChamadas || 40, semContatos: false };
  s.get = async (caminho) => { s.chamadas++; return blingGet(token, caminho, fetchImpl); };
  const recursos = opcoes.recursos ? RECURSOS.filter((r) => opcoes.recursos.includes(r.nome)) : RECURSOS;
  const resultados = [];
  // Só uma sincronização por vez (a automática e o botão "Sincronizar agora" podem coincidir).
  const trava = await db.query(
    `INSERT INTO bling_sync_trava (id, ate) VALUES (1, now() + interval '4 minutes')
     ON CONFLICT (id) DO UPDATE SET ate = EXCLUDED.ate WHERE bling_sync_trava.ate < now() RETURNING id`);
  if (!trava.rows.length) return { resultados, chamadas: 0, semContatos: false, emAndamento: true, mensagem: 'Já existe uma sincronização em andamento; aguarde alguns instantes.' };
  try {
  const total = s.limite; let parado = null;
  for (const [i, R] of recursos.entries()) {
    // Divide as chamadas entre os recursos que faltam; o que um não usar passa para o seguinte.
    const resta = total - s.chamadas;
    s.limite = s.chamadas + Math.max(Math.ceil(resta / (recursos.length - i)), Math.min(8, resta)); // mínimo para listar e ler alguns
    if (parado || s.chamadas >= total) { resultados.push({ recurso: R.nome, adiado: true, mensagem: `${R.rotulo}: aguardando a próxima execução${parado ? ' (limite de consultas do Bling)' : ''}` }); continue; }
    try {
      resultados.push(await sincronizarRecurso(R, s));
    } catch (e) {
      if (e.codigo === 'desconectado') throw e;
      if (e.codigo === 'limite') parado = e;
      const msg = `${R.rotulo}: ${e.message}`;
      await db.query(
        `INSERT INTO bling_sync_recurso (recurso, ultima_execucao, mensagem) VALUES ($1, now(), $2)
         ON CONFLICT (recurso) DO UPDATE SET ultima_execucao = now(), mensagem = $2`, [R.nome, msg]);
      resultados.push({ recurso: R.nome, erro: e.message, codigo: e.codigo, mensagem: msg });
    }
  }
  s.limite = total;
  } finally {
    await db.query(`UPDATE bling_sync_trava SET ate = now() WHERE id = 1`);
  }
  const mensagem = resultados.map((r) => r.mensagem).join(' · ') + '.'
    + (s.semContatos ? ' Aviso: sem permissão de Contatos no Bling; documentos sem CEP ficaram sem endereço.' : '');
  return { resultados, chamadas: s.chamadas, semContatos: s.semContatos, mensagem };
}
