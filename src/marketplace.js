// Resultado das vendas em marketplace (Mercado Livre e outros): quanto a Proloplast recebe de fato
// por produto, depois da comissão e do frete cobrados pelo marketplace.
//
// Para cada pedido:
//   líquido = total da venda − taxa do marketplace − custo do frete (− IPI, se marcado: é imposto, não receita)
//   o líquido é dividido entre os itens do pedido pelo valor de cada item;
//   dentro de um kit, os componentes com valor fixo (ex.: lacre a R$ 0,18) ficam com esse valor
//   e o restante é dividido entre os demais componentes pelo peso (sem peso cadastrado: pela quantidade).
// Resultado: R$ recebido por unidade e por kg de cada produto, comparado com o preço de cadastro.

const num = (v) => { const n = +v; return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

export async function lerFixos(db) {
  const r = await db.query(`SELECT valor FROM app_config WHERE chave = 'valores_fixos'`);
  return r.rows.length && Array.isArray(r.rows[0].valor) ? r.rows[0].valor : [];
}

// Lista de componentes com valor fixo: [{ termo, valor }]. O termo é o código do produto no Bling ou parte do nome
// (ex.: "KIT LACRE FRONTEC" pega todas as variações desse lacre). Guarda os produtos encontrados.
export async function salvarFixos(db, lista, usuario) {
  const L = (Array.isArray(lista) ? lista : []).map((x) => ({ termo: String(x.termo ?? x.codigo ?? '').trim(), valor: num(String(x.valor).replace(',', '.')) }))
    .filter((x) => x.termo && x.valor >= 0).slice(0, 50);
  const fixos = [];
  for (const x of L) {
    let prods = (await db.query('SELECT id, codigo, nome FROM produtos_bling WHERE codigo = $1', [x.termo])).rows;
    if (!prods.length) prods = (await db.query(
      `SELECT id, codigo, nome FROM produtos_bling WHERE nome ILIKE '%' || $1 || '%' ORDER BY nome LIMIT 50`,
      [x.termo.replace(/[%_\\]/g, (c) => '\\' + c)])).rows;
    fixos.push({ ...x, produtos: prods.map((p) => ({ id: String(p.id), codigo: p.codigo, nome: p.nome })) });
  }
  await db.query(`INSERT INTO app_config (chave, valor, atualizado_por) VALUES ('valores_fixos', $1, $2)
                  ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = now(), atualizado_por = $2`, [JSON.stringify(fixos), usuario]);
  return fixos;
}

// Sugestões: componentes de kits com "lacre" no nome (com ou sem código).
export async function sugestoesFixos(db) {
  return (await db.query(
    `SELECT DISTINCT p.id, p.codigo, p.nome FROM produtos_bling p JOIN produtos_estrutura e ON e.componente_id = p.id
      WHERE p.nome ILIKE '%lacre%' ORDER BY p.nome LIMIT 10`)).rows.map((p) => ({ id: String(p.id), termo: p.codigo || p.nome, codigo: p.codigo, nome: p.nome }));
}

export async function analisarMarketplace(db, opcoes = {}) {
  const dataOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const de = dataOk(opcoes.de) ? opcoes.de : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const ate = dataOk(opcoes.ate) ? opcoes.ate : new Date().toISOString().slice(0, 10);
  const canal = opcoes.canal || 'Mercado Livre';
  const descontarIpi = opcoes.descontarIpi === true;

  const params = [de, ate];
  let filtroCanal;
  if (canal === 'marketplace') filtroCanal = `p.canal NOT IN ('Venda direta', 'Loja virtual') AND p.canal IS NOT NULL`;
  else { params.push(canal); filtroCanal = `p.canal = $${params.length}`; }

  const pedidos = (await db.query(
    `SELECT p.id, p.numero, p.numero_loja, p.data, p.canal, p.cliente, p.uf, p.situacao_id, s.nome AS situacao, p.nota_fiscal_id,
            COALESCE(p.valor_total, (p.dados->>'total')::numeric) AS total,
            COALESCE((p.dados->'taxas'->>'taxaComissao')::numeric, 0) AS comissao,
            COALESCE(p.custo_frete_marketplace, (p.dados->'taxas'->>'custoFrete')::numeric, 0) AS frete,
            (p.dados->'taxas'->>'valorBase')::numeric AS valor_base,
            COALESCE((p.dados->'tributacao'->>'totalIPI')::numeric, (p.dados->>'totalIPI')::numeric, 0) AS ipi,
            (p.dados->'taxas') IS NOT NULL AS tem_taxas
       FROM pedidos_bling p LEFT JOIN bling_situacoes s ON s.id = p.situacao_id
      WHERE p.data BETWEEN $1::date AND $2::date AND ${filtroCanal}
      ORDER BY p.data DESC, p.id DESC LIMIT 3000`, params)).rows;
  const ids = pedidos.map((p) => p.id);
  const itens = ids.length ? (await db.query(
    `SELECT i.doc_id, i.seq, i.produto_id, i.codigo, i.descricao, i.quantidade, i.valor, i.valor_total,
            pr.nome AS produto_nome, pr.preco AS produto_preco, w.peso_unitario
       FROM pedido_itens i LEFT JOIN produtos_bling pr ON pr.id = i.produto_id LEFT JOIN produtos_peso w ON w.id = i.produto_id
      WHERE i.doc_id = ANY($1::bigint[]) ORDER BY i.doc_id, i.seq`, [ids])).rows : [];
  const prodIds = [...new Set(itens.map((i) => i.produto_id).filter(Boolean))];
  const estrutura = prodIds.length ? (await db.query(
    `SELECT e.produto_id, e.componente_id, e.quantidade, c.codigo, c.nome, c.preco, c.peso_bruto
       FROM produtos_estrutura e LEFT JOIN produtos_bling c ON c.id = e.componente_id
      WHERE e.produto_id = ANY($1::bigint[]) ORDER BY e.produto_id, e.componente_id`, [prodIds])).rows : [];
  const fixos = await lerFixos(db);
  // versão anterior guardava { codigo, produto_id }; a atual guarda { termo, produtos: [{ id }] }
  const fixoDe = (id, codigo) => {
    const f = fixos.find((x) => (x.produtos || []).some((p) => String(p.id) === String(id)) || (x.produto_id && String(x.produto_id) === String(id))
      || (codigo && (x.codigo === codigo || x.termo === codigo)));
    return f ? num(f.valor) : null;
  };

  const porProduto = new Map(), porAnuncio = new Map(), avisos = new Set(), nomesSemPeso = new Set();
  const resumo = { pedidos: 0, precoCheio: 0, desconto: 0, total: 0, comissao: 0, frete: 0, ipi: 0, liquido: 0, base: 0, peso: 0, fixo: 0, pesoVar: 0, semTaxas: 0, semItens: 0, semPeso: 0 };
  const linhasPedidos = [];

  for (const p of pedidos) {
    const its = itens.filter((i) => String(i.doc_id) === String(p.id));
    // vendido = valor base do marketplace (o que o comprador pagou). O total do pedido no Bling pode ser
    // diferente (ex.: pedido 3510: total R$ 129,49 com preço de lista + IPI; base no Mercado Livre R$ 116,00).
    const total = num(p.valor_base) > 0 ? num(p.valor_base) : num(p.total), comissao = num(p.comissao), frete = num(p.frete), ipi = num(p.ipi);
    p.total_bling = num(p.total); p.total = total;
    const liquido = total - comissao - frete;
    const base = liquido - (descontarIpi ? ipi : 0); // valor a dividir entre os produtos
    resumo.pedidos++; resumo.total += total; resumo.comissao += comissao; resumo.frete += frete; resumo.ipi += ipi; resumo.liquido += liquido; resumo.base += base;
    if (!p.tem_taxas) resumo.semTaxas++;
    // preço cheio = preço dos itens × quantidade, como o painel de vendas do marketplace (sem IPI);
    // sem itens importados: total no Bling − IPI. Desconto = preço cheio − valor base (promoção, cupom, preço por quantidade…)
    const somaIt = its.reduce((s, i) => s + (num(i.valor_total) || num(i.valor) * num(i.quantidade)), 0);
    p.preco_cheio = r2(somaIt > 0 ? somaIt : Math.max(p.total_bling - ipi, 0) || total);
    p.desconto = r2(p.preco_cheio - total);
    resumo.precoCheio += p.preco_cheio; resumo.desconto += p.desconto;
    if (!its.length) { resumo.semItens++; linhasPedidos.push({ ...p, liquido: r2(liquido), base: r2(base), componentes: [], aviso: 'pedido sem itens importados' }); continue; }

    const somaItens = its.reduce((s, i) => s + (num(i.valor_total) || num(i.valor) * num(i.quantidade)), 0);
    const comps = [];
    for (const i of its) {
      const vItem = num(i.valor_total) || num(i.valor) * num(i.quantidade);
      const parte = somaItens > 0 ? base * vItem / somaItens : base / its.length;
      const qtd = num(i.quantidade);
      const est = estrutura.filter((e) => String(e.produto_id) === String(i.produto_id));
      // componentes do item: os do kit (quantidade por kit × quantidade vendida) ou o próprio produto
      const L = est.length
        ? est.map((e) => ({ id: String(e.componente_id), codigo: e.codigo, nome: e.nome || `produto ${e.componente_id}`, preco: e.preco, qtd: num(e.quantidade) * qtd, pesoUnit: num(e.peso_bruto) }))
        : [{ id: i.produto_id ? String(i.produto_id) : 'cod:' + i.codigo, codigo: i.codigo, nome: i.produto_nome || i.descricao, preco: i.produto_preco, qtd, pesoUnit: num(i.peso_unitario) }];
      let resto = parte;
      for (const c of L) { const f = fixoDe(c.id, c.codigo); if (f != null) { c.fixo = true; c.valor = f * c.qtd; resto -= c.valor; } }
      const variaveis = L.filter((c) => !c.fixo);
      const pesoVar = variaveis.reduce((s, c) => s + c.pesoUnit * c.qtd, 0);
      const qtdVar = variaveis.reduce((s, c) => s + c.qtd, 0);
      // pelo peso; componentes sem peso cadastrado ficam com zero (e geram aviso). Só sem nenhum peso: pela quantidade.
      const semPeso = variaveis.filter((c) => !(c.pesoUnit > 0));
      if (semPeso.length) { resumo.semPeso++; semPeso.forEach((c) => nomesSemPeso.add(`${c.codigo || ''} ${c.nome || ''}`.trim())); }
      const porPeso = pesoVar > 0;
      for (const c of variaveis) c.valor = porPeso ? resto * c.pesoUnit * c.qtd / pesoVar : (qtdVar > 0 ? resto * c.qtd / qtdVar : 0);
      if (porPeso) for (const c of semPeso) c.semPeso = true;
      for (const c of L) {
        c.peso = c.pesoUnit * c.qtd;
        comps.push({ item: i.codigo, ...c, valor: r2(c.valor), rateio: c.fixo ? 'fixo' : c.semPeso ? 'sem peso' : porPeso ? 'peso' : 'quantidade' });
        const k = c.id, g = porProduto.get(k) || { id: k, codigo: c.codigo, nome: c.nome, preco: c.preco != null ? num(c.preco) : null, fixo: !!c.fixo, qtd: 0, peso: 0, valor: 0, pedidos: new Set() };
        g.qtd += c.qtd; g.peso += c.peso; g.valor += c.valor; g.pedidos.add(p.id); porProduto.set(k, g);
        resumo.peso += c.peso;
        if (c.fixo) resumo.fixo += c.valor; else resumo.pesoVar += c.peso;
      }
      const ka = i.produto_id ? String(i.produto_id) : 'cod:' + i.codigo;
      const a = porAnuncio.get(ka) || { id: ka, codigo: i.codigo, nome: i.produto_nome || i.descricao, kit: est.length > 0, vendas: 0, qtd: 0, total: 0, liquido: 0, peso: 0, fixo: 0, qtdFixo: 0, pesoVar: 0 };
      a.vendas++; a.qtd += qtd; a.total += somaItens > 0 ? total * vItem / somaItens : total / its.length; a.liquido += parte;
      a.peso += L.reduce((s, c) => s + c.pesoUnit * c.qtd, 0);
      // valor fixo (lacre) sai do saldo; o "por kg" do anúncio é só do que é rateado pelo peso (o saco)
      for (const c of L) { if (c.fixo) { a.fixo += c.valor; a.qtdFixo += c.qtd; } else a.pesoVar += c.pesoUnit * c.qtd; }
      porAnuncio.set(ka, a);
    }
    linhasPedidos.push({ ...p, liquido: r2(liquido), base: r2(base), componentes: comps });
  }

  const produtos = [...porProduto.values()].map((g) => ({
    id: g.id, codigo: g.codigo, nome: g.nome, fixo: g.fixo, pedidos: g.pedidos.size, qtd: g.qtd, peso: Math.round(g.peso * 1000) / 1000,
    valor: r2(g.valor), porUnidade: g.qtd > 0 ? Math.round(g.valor / g.qtd * 10000) / 10000 : null,
    porKg: g.peso > 0 ? r4(g.valor / g.peso) : null, preco: g.preco,
    pctPreco: g.preco > 0 && g.qtd > 0 ? Math.round(g.valor / g.qtd / g.preco * 1000) / 10 : null,
  })).sort((a, b) => b.valor - a.valor);
  const anuncios = [...porAnuncio.values()].map((a) => ({ ...a, total: r2(a.total), liquido: r2(a.liquido), peso: Math.round(a.peso * 1000) / 1000,
    fixo: r2(a.fixo), saldo: r2(a.liquido - a.fixo), pesoVar: Math.round(a.pesoVar * 1000) / 1000,
    liquidoPorVenda: a.qtd > 0 ? r2(a.liquido / a.qtd) : null, porKg: a.pesoVar > 0 ? r4((a.liquido - a.fixo) / a.pesoVar) : null,
    pctRecebido: a.total > 0 ? Math.round(a.liquido / a.total * 1000) / 10 : null })).sort((a, b) => b.liquido - a.liquido);

  if (nomesSemPeso.size) avisos.add(`Sem peso cadastrado no Bling (ficam fora do rateio pelo peso; configure como valor fixo ou cadastre o peso): ${[...nomesSemPeso].slice(0, 8).join('; ')}${nomesSemPeso.size > 8 ? '…' : ''}.`);
  if (resumo.semTaxas) avisos.add(`${resumo.semTaxas} pedido(s) sem as taxas do marketplace no Bling: considerados sem comissão e sem frete.`);
  if (!fixos.length) avisos.add('Nenhum componente com valor fixo configurado (ex.: lacre a R$ 0,18): tudo é rateado pelo peso.');
  for (const k of ['total', 'comissao', 'frete', 'ipi', 'liquido', 'base']) resumo[k] = r2(resumo[k]);
  resumo.precoCheio = r2(resumo.precoCheio); resumo.desconto = r2(resumo.desconto);
  resumo.peso = Math.round(resumo.peso * 1000) / 1000;
  // por kg sem o valor fixo (lacres): (mercadoria − valor fixo) ÷ peso dos itens rateados pelo peso
  resumo.fixo = r2(resumo.fixo); resumo.pesoVar = Math.round(resumo.pesoVar * 1000) / 1000;
  resumo.porKg = resumo.pesoVar > 0 ? r4((resumo.base - resumo.fixo) / resumo.pesoVar) : null;
  resumo.pctRetido = resumo.total > 0 ? Math.round((resumo.comissao + resumo.frete) / resumo.total * 1000) / 10 : null;

  return { periodo: { de, ate }, canal, descontarIpi, resumo, produtos, anuncios, pedidos: linhasPedidos, fixos, avisos: [...avisos] };
}
