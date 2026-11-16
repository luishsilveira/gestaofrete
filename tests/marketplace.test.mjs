// Resultado no marketplace: rateio do líquido do pedido entre os componentes do kit (PostgreSQL local).
import worker from '../src/index.js';
import { psql } from './pgpsql.mjs';
let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') }, BLING_CLIENT_ID: 'c', BLING_CLIENT_SECRET: 's' };
const api = async (path, method = 'GET', body) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': 'luis@x' } }), env, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
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
 (104,'5001',null,'${hoje}','Venda direta','Cliente A',1000,null,'{}');
INSERT INTO pedido_itens (doc_id, seq, produto_id, codigo, descricao, quantidade, valor, valor_total) VALUES
 (102,1,503,'D16-50','Kit',1,95.88,95.88),(103,1,503,'D16-50','Kit',1,95.88,95.88),(103,2,504,'AVULSO','Avulso',2,12,24),(104,1,501,'D110160','Tubo',1000,1.18,1180);
`);
let r = await api('/api/marketplace');
const p102 = r.j.pedidos.find((p) => p.numero === '3552');
t('só pedidos do Mercado Livre', r.j.resumo.pedidos === 2 && !r.j.pedidos.some((p) => p.numero === '5001'));
t('pedido 3552: mercadoria = 94 − 11,28 − 19,75 − 3,12 = 59,85', p102.base === 59.85 && p102.liquido === 62.97);
t('sem valor fixo: tudo pelo peso', p102.componentes.every((c) => c.rateio === 'peso') && r.j.avisos.some((a) => /valor fixo/.test(a)));
r = await api('/api/marketplace/fixos');
t('sugere o lacre', r.j.sugestoes.some((s) => s.codigo === 'LACRE'));
r = await api('/api/marketplace/fixos', 'POST', { fixos: [{ codigo: 'LACRE', valor: '0,18' }, { codigo: 'NAOEXISTE', valor: 1 }] });
t('fixos salvos e resolvidos', r.j.fixos[0].produto_id === '502' && r.j.fixos[1].produto_id === null);
r = await api('/api/marketplace');
const c102 = r.j.pedidos.find((p) => p.numero === '3552').componentes;
const lacre = c102.find((c) => c.codigo === 'LACRE'), tubo = c102.find((c) => c.codigo === 'D110160');
t('lacre: 50 × R$ 0,18 = R$ 9,00', lacre.valor === 9 && lacre.rateio === 'fixo');
t('tubo: R$ 50,85 por 14,6 kg', tubo.valor === 50.85 && Math.abs(tubo.peso - 14.6) < 1e-9);
const p103 = r.j.pedidos.find((p) => p.numero === '3553');
// 3553: base 95,60 dividida pelo valor dos itens (95,88 e 24) → kit 76,47; avulso 19,13
const av = p103.componentes.find((c) => c.codigo === 'AVULSO');
t('pedido com 2 itens: rateio pelo valor; sem peso → pela quantidade', Math.abs(av.valor - 95.6 * 24 / 119.88) < 0.01 && av.rateio === 'quantidade');
const prodTubo = r.j.produtos.find((p) => p.codigo === 'D110160');
t('por produto: tubo em 2 pedidos, 100 un, R$/kg e % do preço', prodTubo.pedidos === 2 && prodTubo.qtd === 100 && prodTubo.porKg === 4.05 && prodTubo.pctPreco === 100.3);
t('por anúncio: kit com 2 vendas', r.j.anuncios.find((a) => a.codigo === 'D16-50').vendas === 2);
r = await api('/api/marketplace?ipi=0');
t('sem descontar IPI', r.j.pedidos.find((p) => p.numero === '3552').base === 62.97);
r = await api('/api/marketplace?canal=marketplace&de=2000-01-01&ate=lixo');
t('todos marketplaces e datas inválidas', r.status === 200 && r.j.resumo.pedidos === 2);
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
