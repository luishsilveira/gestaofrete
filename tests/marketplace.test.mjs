// Resultado no marketplace: rateio do líquido do pedido entre os componentes do kit (PostgreSQL local).
import worker from '../src/index.js';
import { psql } from './pgpsql.mjs';
import { cadastrarAdmins } from './usuarios.mjs';
let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') }, BLING_CLIENT_ID: 'c', BLING_CLIENT_SECRET: 's', };
const api = async (path, method = 'GET', body, email = 'luis@x', e = env) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': email } }), e, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
await cadastrarAdmins(api, 'luis@x');
await api('/api/eu'); await api('/api/cotacoes'); // cria o esquema
const hoje = new Date().toISOString().slice(0, 10);
psql(`
INSERT INTO produtos_bling (id, codigo, nome, formato, preco, peso_bruto) VALUES
 (501,'D110160','Tubo Saco 51x110x160','S',1.18,0.292),(502,'LACRE','KIT LACRE FRONTEC','S',0.18,0.002),(503,'D16-50','Tubo Saco 50 un COM LACRES','E',95.88,0),
 (504,'AVULSO','Produto sem peso','S',10,0);
INSERT INTO produtos_estrutura (produto_id, componente_id, quantidade) VALUES (503,501,50),(503,502,50);
INSERT INTO pedidos_bling (id, numero, numero_loja, data, canal, cliente, valor_total, custo_frete_marketplace, dados) VALUES
 (102,'3552','2000009999','${hoje}','Mercado Livre','Fabio',94,19.75,'{"total":94,"taxas":{"taxaComissao":11.28,"custoFrete":19.75,"valorBase":94},"tributacao":{"totalIPI":3.12}}'),
 (103,'3553',null,'${hoje}','Mercado Livre','Ana',120,10,'{"total":120,"taxas":{"taxaComissao":14.4,"custoFrete":10}}'),
 (105,'3510','2000019491003970','${hoje}','Mercado Livre','Mayara',129.49,22.85,'{"total":129.49,"taxas":{"taxaComissao":13.92,"custoFrete":22.85,"valorBase":116},"tributacao":{"totalIPI":4.08}}'),
 (104,'5001',null,'${hoje}','Venda direta','Cliente A',1000,null,'{}');
INSERT INTO pedido_itens (doc_id, seq, produto_id, codigo, descricao, quantidade, valor, valor_total) VALUES
 (102,1,503,'D16-50','Kit',1,95.88,95.88),(103,1,503,'D16-50','Kit',1,95.88,95.88),(103,2,504,'AVULSO','Avulso',2,12,24),(104,1,501,'D110160','Tubo',1000,1.18,1180),(105,1,503,'D16-50','Kit',1,125.41,125.41);
`);
let r = await api('/api/marketplace?ipi=1'); // descontar IPI é opcional (desmarcado por padrão)
const p102 = r.j.pedidos.find((p) => p.numero === '3552');
const p3510 = r.j.pedidos.find((p) => p.numero === '3510');
t('3510: vendido = valor base 116; líquido 79,23 como no Bling', p3510.total === 116 && p3510.liquido === 79.23 && p3510.total_bling === 129.49);
t('só pedidos do Mercado Livre', r.j.resumo.pedidos === 3 && !r.j.pedidos.some((p) => p.numero === '5001'));
t('pedido 3552: mercadoria = 94 − 11,28 − 19,75 − 3,12 = 59,85', p102.base === 59.85 && p102.liquido === 62.97);
t('sem valor fixo: tudo pelo peso', p102.componentes.every((c) => c.rateio === 'peso') && r.j.avisos.some((a) => /valor fixo/.test(a)));
r = await api('/api/marketplace/fixos');
t('sugere o lacre', r.j.sugestoes.some((s) => s.termo === 'LACRE'));
psql(`INSERT INTO produtos_bling (id, codigo, nome, formato, preco, peso_bruto) VALUES (506, null, 'KIT LACRE FRONTEC BRANCO', 'S', 0.18, 0);`);
r = await api('/api/marketplace/fixos', 'POST', { fixos: [{ termo: 'kit lacre frontec', valor: '0,18' }, { termo: 'NAOEXISTE', valor: 1 }] });
t('fixo por parte do nome pega as variações (com e sem código)', r.j.fixos[0].produtos.map((p) => p.id).sort().join() === '502,506' && r.j.fixos[1].produtos.length === 0);
r = await api('/api/marketplace?ipi=1');
const c102 = r.j.pedidos.find((p) => p.numero === '3552').componentes;
const lacre = c102.find((c) => c.codigo === 'LACRE'), tubo = c102.find((c) => c.codigo === 'D110160');
t('lacre: 50 × R$ 0,18 = R$ 9,00', lacre.valor === 9 && lacre.rateio === 'fixo');
t('tubo: R$ 50,85 por 14,6 kg', tubo.valor === 50.85 && Math.abs(tubo.peso - 14.6) < 1e-9);
const p103 = r.j.pedidos.find((p) => p.numero === '3553');
// 3553: base 95,60 dividida pelo valor dos itens (95,88 e 24) → kit 76,47; avulso 19,13
const av = p103.componentes.find((c) => c.codigo === 'AVULSO');
t('pedido com 2 itens: rateio pelo valor; sem peso → pela quantidade', Math.abs(av.valor - 95.6 * 24 / 119.88) < 0.01 && av.rateio === 'quantidade');
const prodTubo = r.j.produtos.find((p) => p.codigo === 'D110160');
t('por produto: tubo em 2 pedidos, 100 un, R$/kg e % do preço', prodTubo.pedidos === 3 && prodTubo.qtd === 150);
t('por anúncio: kit com 2 vendas', r.j.anuncios.find((a) => a.codigo === 'D16-50').vendas === 3);
{ // por kg do anúncio sem o valor fixo dos lacres
  const an = r.j.anuncios.find((a) => a.codigo === 'D16-50');
  const comps = r.j.pedidos.flatMap((p) => p.componentes.filter((c) => c.item === 'D16-50'));
  const lac = comps.filter((c) => c.rateio === 'fixo'), sac = comps.filter((c) => c.rateio !== 'fixo');
  const vLac = lac.reduce((s, c) => s + c.valor, 0), qLac = lac.reduce((s, c) => s + c.qtd, 0);
  const vSac = sac.reduce((s, c) => s + c.valor, 0), pSac = sac.reduce((s, c) => s + c.peso, 0);
  t('anúncio: coluna dos lacres (qtd × R$ 0,18)', qLac > 0 && an.qtdFixo === qLac && Math.abs(an.fixo - qLac * 0.18) < 0.01 && Math.abs(an.fixo - vLac) < 0.01);
  t('anúncio: saldo = recebido − lacres', Math.abs(an.saldo - (an.liquido - an.fixo)) < 0.01 && Math.abs(an.saldo - vSac) < 0.05);
  t('anúncio: por kg = saldo ÷ peso dos sacos', Math.abs(an.pesoVar - pSac) < 0.001 && Math.abs(an.porKg - an.saldo / an.pesoVar) < 0.001);
  t('anúncio: por kg do anúncio = por kg do tubo', Math.abs(an.porKg - vSac / pSac) < 0.001);
  const todos = r.j.pedidos.flatMap((p) => p.componentes), fx = todos.filter((c) => c.rateio === 'fixo');
  const vFx = fx.reduce((s, c) => s + c.valor, 0), pVar = todos.filter((c) => c.rateio !== 'fixo').reduce((s, c) => s + c.peso, 0);
  t('resumo: recebido por kg sem os lacres', Math.abs(r.j.resumo.fixo - vFx) < 0.01 && Math.abs(r.j.resumo.pesoVar - pVar) < 0.001
    && Math.abs(r.j.resumo.porKg - (r.j.resumo.base - r.j.resumo.fixo) / r.j.resumo.pesoVar) < 0.001);
}
r = await api('/api/marketplace?ipi=0');
t('sem descontar IPI', r.j.pedidos.find((p) => p.numero === '3552').base === 62.97);
r = await api('/api/marketplace?canal=marketplace&de=2000-01-01&ate=lixo');
t('todos marketplaces e datas inválidas', r.status === 200 && r.j.resumo.pedidos === 3);
psql(`UPDATE produtos_bling SET peso_bruto = 0 WHERE id = 502; UPDATE app_config SET valor = '[]' WHERE chave = 'valores_fixos';`);
r = await api('/api/marketplace?ipi=1');
const c3510 = r.j.pedidos.find((p) => p.numero === '3510').componentes;
t('lacre sem peso e sem valor fixo: fica com zero, tubo com tudo, aviso', c3510.find((c) => c.codigo === 'LACRE').valor === 0 && c3510.find((c) => c.codigo === 'LACRE').rateio === 'sem peso'
  && c3510.find((c) => c.codigo === 'D110160').valor === 75.15 && r.j.avisos.some((a) => /Sem peso cadastrado.*LACRE/.test(a)));
// ---- restrição de acesso: perfil sem o menu do marketplace
psql(`INSERT INTO usuarios (email, perfil_id) SELECT 'vendas@x', id FROM perfis WHERE nome = 'Comercial';`);
t('perfil Comercial: 403 no marketplace e /api/eu sem a permissão', (await api('/api/marketplace', 'GET', null, 'vendas@x')).status === 403
  && !(await api('/api/eu', 'GET', null, 'vendas@x')).j.permissoes.includes('menu.mkt') && (await api('/api/eu')).j.permissoes.includes('menu.mkt'));
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
