// Teste de ponta a ponta da importação do Bling e da API, contra um PostgreSQL local (via psql).
// Requer: PostgreSQL local na porta 5499 (socket /tmp/pgt), banco "gf" vazio, e um stub do módulo "pg"
// que use ./pgpsql.mjs (ver README, seção Testes).
import { psql } from './pgpsql.mjs';
import worker from '../src/index.js';
import { BLING, SCHEMA_BLING, definirRitmoBling } from '../src/bling.js';
definirRitmoBling({ intervalo: 0, esperasLimite: [1, 1] });
import { SCHEMA_DOCS, sincronizarTudo } from '../src/sync.js';
import { db } from './pgpsql.mjs';

let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const hoje = new Date().toISOString().slice(0, 10);
const env = { BLING_CLIENT_ID: 'c', BLING_CLIENT_SECRET: 's', HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('asset') } };
const ctx = { waitUntil: () => {} };
const api = async (path, method = 'GET', body) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': 'luis@x', 'content-type': 'application/json' } }), env, ctx);
  return { status: r.status, j: await r.json() };
};

// ---------- Bling simulado
const pedidos = {
  101: { id: 101, numero: 5001, data: hoje, totalProdutos: 1000, total: 1000, situacao: { id: 6 }, contato: { id: 1, nome: 'Cliente A' }, loja: { id: 0 },
         notaFiscal: { id: 9001 }, transporte: { frete: 0, pesoBruto: 50, quantidadeVolumes: 2, etiqueta: { cep: '90010-000', municipio: 'Porto Alegre', uf: 'RS' } },
         itens: [{ produto: { id: 501 }, codigo: 'D110160', descricao: 'Tubo saco 51x110x160', quantidade: 1000, valor: 1.18 }] },
  102: { id: 102, numero: 3552, data: hoje, totalProdutos: 95.88, total: 94, situacao: { id: 6 }, contato: { id: 2, nome: 'Fabio (ML)' }, loja: { id: 777 }, numeroLoja: '2000009999',
         intermediador: { cnpj: '03.007.331/0001-41', nomeUsuario: 'fabiubatista' }, taxas: { taxaComissao: 11.28, custoFrete: 19.75 },
         transporte: { frete: 0, pesoBruto: 0, etiqueta: { cep: '57400-000', municipio: 'Pão de Açúcar', uf: 'AL' } },
         itens: [{ produto: { id: 503 }, codigo: 'D16-50', descricao: 'Tubo Saco 51X110X160 50 unidades COM LACRES', quantidade: 1, valor: 95.88 }] },
};
const propostas = {
  201: { id: 201, numero: 159461, data: hoje, situacao: 'Pendente', total: 1360, totalProdutos: 1360, contato: { id: 3, nome: 'FELICIO MELOTTI NETTO' },
         itens: [{ produto: { id: 501 }, descricao: 'TUBO Saco 51X110X160', quantidade: 1000, valor: 1.18 }, { produto: { id: 502 }, descricao: 'KIT LACRE', quantidade: 1000, valor: 0.18 }] },
};
const notas = {
  9001: { id: 9001, tipo: 1, numero: '12345', serie: '1', dataEmissao: hoje + ' 10:00:00', situacao: 5, chaveAcesso: '4326...', valorNota: 1000, valorFrete: 0,
          contato: { nome: 'Cliente A', numeroDocumento: '11', endereco: { cep: '90010-000', municipio: 'Porto Alegre', uf: 'RS' } },
          transporte: { fretePorConta: 0, transportador: { nome: 'Trânsito Brasil' }, volume: { quantidade: 2, pesoBruto: 52.5, pesoLiquido: 50 } },
          itens: [{ codigo: 'D110160', descricao: 'Tubo saco', quantidade: 1000, valor: 1.18, valorTotal: 1180 }], xml: '<grande/>' },
  9002: { id: 9002, tipo: 0, numero: '1', situacao: 5 },
};
const produtos = {
  501: { id: 501, codigo: 'D110160', nome: 'Tubo Saco 51x110x160', formato: 'S', situacao: 'A', preco: 1.18, pesoBruto: 0.292, pesoLiquido: 0.29 },
  502: { id: 502, codigo: 'LACRE', nome: 'KIT LACRE FRONTEC 4,8X180 PRETO UV', formato: 'S', situacao: 'A', preco: 0.18, pesoBruto: 0.002 },
  503: { id: 503, codigo: 'D16-50', nome: 'Tubo Saco 51X110X160 50 un COM LACRES', formato: 'E', situacao: 'A', preco: 95.88, pesoBruto: 0,
         estrutura: { componentes: [{ produto: { id: 501 }, quantidade: 50 }, { produto: { id: 502 }, quantidade: 50 }] } },
};
const urls = []; let recusar = new Set(); let limitar = 0;
globalThis.fetch = async (url) => {
  const u = String(url).replace(BLING.apiBase, ''); urls.push(u);
  const R = (s, j) => new Response(JSON.stringify(j), { status: s, headers: { 'content-type': 'application/json' } });
  if (limitar > 0 && /\/\d+$/.test(u)) { limitar--; return R(429, {}); }
  for (const r of recusar) if (u.includes(r)) return R(400, { error: { description: 'parâmetro inválido' } });
  const lista = (obj, f = () => true) => R(200, { data: u.includes('pagina=1') || !u.includes('pagina=') ? Object.values(obj).filter(f).map((x) => ({ id: x.id, numero: x.numero, data: x.data, dataEmissao: x.dataEmissao, total: x.total, situacao: x.situacao, tipo: x.tipo, preco: x.preco, formato: x.formato })) : [] });
  if (u.startsWith('/pedidos/vendas?')) return lista(pedidos);
  if (u.startsWith('/propostas-comerciais?')) return lista(propostas);
  if (u.startsWith('/nfe?')) return lista(notas);
  if (u.startsWith('/produtos?')) return lista(produtos);
  let m;
  if ((m = u.match(/^\/pedidos\/vendas\/(\d+)$/))) return R(200, { data: structuredClone(pedidos[m[1]]) });
  if ((m = u.match(/^\/propostas-comerciais\/(\d+)$/))) return R(200, { data: structuredClone(propostas[m[1]]) });
  if ((m = u.match(/^\/nfe\/(\d+)$/))) return R(200, { data: structuredClone(notas[m[1]]) });
  if ((m = u.match(/^\/produtos\/(\d+)$/))) return produtos[m[1]] ? R(200, { data: structuredClone(produtos[m[1]]) }) : R(404, {});
  if (u === '/contatos/3') return R(200, { data: { numeroDocumento: '333', endereco: { geral: { cep: '29100-000', municipio: 'Vila Velha', uf: 'ES' } } } });
  if ((m = u.match(/^\/situacoes\/(\d+)$/))) return R(200, { data: { id: +m[1], nome: 'Em aberto' } });
  return R(404, {});
};

// ---------- preparação
let r = await api('/api/bling/status');
t('status antes de conectar', r.status === 200 && r.j.configurado && !r.j.conectado);
psql(`INSERT INTO bling_tokens (id, access_token, refresh_token, expira_em) VALUES (1,'TK','RF', now()+interval '5 hours');`);

// ---------- 1ª sincronização (tudo)
r = await api('/api/bling/sincronizar', 'POST');
t('sincronizar: ' + r.j.mensagem, r.status === 200 && r.j.resultados.every((x) => !x.erro));
const q = (s) => psql(s).trim();
t('pedidos gravados com canal', q(`SELECT string_agg(numero||':'||canal, ',' ORDER BY id) FROM pedidos_bling;`) === '5001:Venda direta,3552:Mercado Livre');
t('custo frete do ML e nº da loja', q(`SELECT custo_frete_marketplace||'|'||numero_loja FROM pedidos_bling WHERE id=102;`) === '19.75|2000009999');
t('itens do pedido', q(`SELECT count(*) FROM pedido_itens;`) === '2');
t('proposta com CEP do cadastro', q(`SELECT cep||'|'||cidade||'|'||situacao FROM propostas_bling;`) === '29100000|Vila Velha|Pendente');
t('itens da proposta', q(`SELECT count(*) FROM proposta_itens;`) === '2');
t('só NF de saída', q(`SELECT string_agg(numero, ',') FROM notas_bling;`) === '12345');
t('NF: transportadora/peso/volumes, sem XML', q(`SELECT transportadora||'|'||peso_bruto||'|'||volumes||'|'||(dados ? 'xml')::text FROM notas_bling;`) === 'Trânsito Brasil|52.500|2|false');
t('produtos e estrutura do kit', q(`SELECT count(*) FROM produtos_bling;`) === '3' && q(`SELECT string_agg(componente_id||'x'||quantidade, ',' ORDER BY componente_id) FROM produtos_estrutura WHERE produto_id=503;`) === '501x50.0000,502x50.0000');
t('peso do kit = soma dos componentes', q(`SELECT round(peso_unitario,3)||'|'||origem_peso FROM produtos_peso WHERE id=503;`) === '14.700|componentes');
t('estado por recurso', q(`SELECT count(*) FROM bling_sync_recurso WHERE ultimo_completo IS NOT NULL;`) === '4');

// ---------- APIs de listagem
r = await api('/api/bling/pedidos');
const ml = r.j.pedidos.find((p) => p.numero === '3552');
t('pedido ML: peso calculado do kit 14,7 kg', ml && +ml.peso_calculado === 14.7 && ml.canal === 'Mercado Livre' && +ml.custo_frete_marketplace === 19.75);
const pa = r.j.pedidos.find((p) => p.numero === '5001');
t('pedido 5001: peso calculado 292 kg', pa && +pa.peso_calculado === 292 && +pa.itens_sem_peso === 0);
t('filtro canal marketplace', (await api('/api/bling/pedidos?canal=marketplace')).j.pedidos.map((p) => p.numero).join() === '3552');
t('filtro canal venda direta', (await api('/api/bling/pedidos?canal=direta')).j.pedidos.map((p) => p.numero).join() === '5001');
r = await api('/api/bling/propostas');
t('proposta: peso 1000×0,292 + 1000×0,002 = 294 kg', +r.j.propostas[0].peso_calculado === 294);
r = await api('/api/bling/notas');
t('nota ligada ao pedido 5001 e peso pelos itens (código)', r.j.notas[0].pedido_numero === '5001' && +r.j.notas[0].peso_calculado === 292);
r = await api('/api/bling/produtos?filtro=kits');
t('produtos: filtro kits', r.j.produtos.length === 1 && +r.j.produtos[0].n_componentes === 2);
r = await api('/api/bling/itens?tipo=pedido&id=102');
t('itens com componentes do kit', r.j.itens[0].componentes.length === 2 && r.j.itens[0].componentes.some((c) => c.nome.startsWith('KIT LACRE')));
r = await api('/api/bling/status');
t('status com sincronização', r.j.conectado && r.j.sync && r.j.sync.recursos.length === 4);

// ---------- 2ª sincronização: nada mudou
urls.length = 0;
r = await sincronizarTudo(env, db);
const detalhes = urls.filter((u) => /\/\d+$/.test(u));
t(`2ª sync sem mudanças: ${r.mensagem} (${r.chamadas} chamadas)`, detalhes.length === 0);

// ---------- alteração e filtros recusados
pedidos[102].total = 99; pedidos[102].transporte.frete = 25;
recusar = new Set(['dataAlteracaoInicial']);
urls.length = 0;
r = await sincronizarTudo(env, db);
t('pedido alterado relido usando a reserva dataInicial', urls.some((u) => u.startsWith('/pedidos/vendas?') && u.includes('dataInicial')) && q(`SELECT frete_bling FROM pedidos_bling WHERE id=102;`) === '25.00');
t('produtos: sem filtro de alteração, só busca faltantes (sem erro)', !r.resultados.find((x) => x.recurso === 'produtos').erro);
recusar = new Set();

// ---------- produto novo usado num pedido entra como faltante
pedidos[101].itens.push({ produto: { id: 504 }, codigo: 'NOVO', descricao: 'Produto novo', quantidade: 2, valor: 10 });
pedidos[101].total = 1020;
produtos[504] = { id: 504, codigo: 'NOVO', nome: 'Produto novo', formato: 'S', preco: 10, pesoBruto: 1.5 };
psql(`UPDATE bling_sync_recurso SET ultimo_completo = now() WHERE recurso='produtos';`);
recusar = new Set(['/produtos?']);
r = await sincronizarTudo(env, db);
recusar = new Set();
t('produto faltante importado mesmo sem listar produtos', q(`SELECT peso_bruto FROM produtos_bling WHERE id=504;`) === '1.5000');

// ---------- limite de chamadas: divide entre recursos e continua depois
psql(`TRUNCATE pedidos_bling, propostas_bling, notas_bling, produtos_bling, produtos_estrutura, pedido_itens, proposta_itens, nota_itens, bling_sync_recurso;`);
r = await sincronizarTudo(env, db, fetch, { limiteChamadas: 6 });
t(`limite 6: ${r.mensagem}`, r.chamadas <= 6 && r.resultados.some((x) => x.pendentes > 0 || x.adiado));
for (let i = 0; i < 6; i++) await sincronizarTudo(env, db, fetch, { limiteChamadas: 6 });
t('execuções seguintes completam tudo', q(`SELECT (SELECT count(*) FROM pedidos_bling)||'/'||(SELECT count(*) FROM propostas_bling)||'/'||(SELECT count(*) FROM notas_bling)||'/'||(SELECT count(*) FROM produtos_bling);`) === '2/1/1/4');

// ---------- HTTP 429: tenta de novo e, se persistir, para e deixa para a próxima
limitar = 2; pedidos[101].total = 1030;
r = await sincronizarTudo(env, db);
t('429 passageiro: tenta de novo e grava', q(`SELECT valor_total FROM pedidos_bling WHERE id=101;`) === '1030.00');
limitar = 1000; pedidos[101].total = 1040; propostas[201].total = 1400;
r = await sincronizarTudo(env, db);
t('429 persistente: para os demais recursos', r.resultados.filter((x) => x.adiado).length >= 1 && r.resultados.find((x) => x.codigo === 'limite'));
limitar = 0;
r = await sincronizarTudo(env, db);
t('depois do limite, completa', q(`SELECT valor_total FROM pedidos_bling WHERE id=101;`) === '1040.00');

// ---------- trava: duas sincronizações ao mesmo tempo
const [a1, a2] = await Promise.all([sincronizarTudo(env, db), sincronizarTudo(env, db)]);
t('só uma sincronização por vez', [a1, a2].filter((x) => x.emAndamento).length === 1);

// ---------- busca manual e cotação ligada à proposta
r = await api('/api/bling/pedido?numero=3552');
t('busca manual devolve canal e itens', r.status === 200 && r.j.canal === 'Mercado Livre' && r.j.itens.length === 1);
r = await api('/api/cotacoes', 'POST', { resultados: [{ transportadora: 'Bento', total: 300, prazo: '10' }], bling_proposta_id: 201, pedido: '159461' });
t('cotação salva com proposta', r.status === 201);
r = await api('/api/bling/propostas');
t('proposta mostra a cotação', r.j.propostas[0].cotacao_id && +r.j.propostas[0].melhor_valor === 300);

// ---------- busca manual de proposta pelo número (fora do banco: procura na lista do Bling)
psql(`DELETE FROM proposta_itens; DELETE FROM propostas_bling;`);
r = await api('/api/bling/pedido?numero=159461');
t('busca por nº acha proposta', r.status === 200 && r.j.tipo === 'proposta' && r.j.cep === '29100000' && +r.j.pesoItens === 294);
t('proposta gravada pela busca', q(`SELECT count(*) FROM propostas_bling;`) === '1');
r = await api('/api/bling/pedido?numero=424242');
t('nº inexistente: mensagem', r.status === 404 && /pedido de venda, proposta comercial ou nota fiscal/.test(r.j.erro));
psql(`DELETE FROM nota_itens; DELETE FROM notas_bling;`);
r = await api('/api/bling/pedido?numero=12345');
t('busca por nº acha NF de saída', r.status === 200 && r.j.tipo === 'nota' && +r.j.pesoBruto === 52.5 && +r.j.valorProdutos === 1000 && r.j.transportadora === 'Trânsito Brasil');
r = await api('/api/cotacoes', 'POST', { resultados: [{ transportadora: 'Bento', total: 1 }], bling_nota_id: 9001 });
t('cotação ligada à NF', r.status === 201 && q(`SELECT bling_nota_id FROM cotacoes WHERE id=${r.j.id};`) === '9001');

// ---------- valores manuais e divergências
r = await api('/api/cotacoes', 'POST', { uf: 'AL', cidade: 'Pão de Açúcar', peso_real: 120, valor_nf: 2000,
  resultados: [{ transportadora: 'Bento', total: 300, praca: 'AL interior' }, { transportadora: 'Braspress', total: 350 }],
  sem_cotacao: [{ transportadora: 'TJB' }],
  valores_manuais: [{ transportadora: 'Bento', valor_manual: 330, motivo: 'ICMS', referencia: 'cot 999' }, { transportadora: 'X', valor_manual: 0 }] });
const idc = r.j.id;
t('cotação salva com valor manual', r.status === 201 && r.j.valores_manuais === 1);
r = await api(`/api/cotacoes/${idc}/manual`, 'POST', { transportadora: 'Braspress', valor_manual: 340, motivo: 'Desconto ou negociação' });
t('valor manual adicionado depois', r.status === 201 && +r.j.valor_calculado === 350);
r = await api(`/api/cotacoes/${idc}/manual`, 'POST', { transportadora: 'TJB', valor_manual: 280 });
t('manual de transportadora sem cálculo', r.status === 201 && r.j.valor_calculado === null);
t('manual sem valor recusado', (await api(`/api/cotacoes/${idc}/manual`, 'POST', { transportadora: 'Bento' })).status === 400);
r = await api(`/api/cotacoes/${idc}`);
t('detalhe traz manuais', r.j.valores_manuais.length === 3 && r.j.motivos.length > 3);
r = await api('/api/cotacoes?manual=1');
t('filtro só com manual', r.j.cotacoes.length === 1 && r.j.cotacoes[0].manuais.length === 3);
r = await api('/api/divergencias');
const bento = r.j.por_transportadora.find((x) => x.grupo === 'Bento');
t('divergência Bento +10%', +bento.media_pct === 10 && +bento.media_dif === 30 && r.j.linhas.find((x) => x.transportadora === 'Bento').praca === 'AL interior');
t('resumos por UF, peso e motivo', r.j.por_uf.some((x) => x.grupo === 'Bento · AL') && r.j.por_peso.some((x) => x.grupo === 'Bento · 101 a 200 kg') && r.j.por_motivo.length === 2);
t('sem cálculo separado', r.j.sem_calculo.length === 1 && r.j.linhas.length === 2);
r = await api('/api/cotacoes', 'POST', { uf: 'SP', cidade: 'Cravinhos', peso_real: 43.8, valor_nf: 816,
  resultados: [{ transportadora: 'Braspress', total: 162.05, fonte_valor: 'online', valor_online: 162.05, valor_tabela: 145.26, praca_tabela: 'Interior de SP 1', cotacao_online: '777' }] });
await api('/api/cotacoes', 'POST', { uf: 'SP', resultados: [{ transportadora: 'Braspress', total: 150, fonte_valor: 'tabela', valor_tabela: 150, erro_online: 'timeout' }] });
r = await api('/api/divergencias');
t('online × tabela', r.j.online.linhas.length === 1 && +r.j.online.linhas[0].diferenca === 16.79 && r.j.online.por_praca[0].grupo === 'Braspress · SP · Interior de SP 1' && +r.j.online.fontes[0].online === 1 && +r.j.online.fontes[0].tabela === 1);
const idm = r.j.sem_calculo[0].id;
t('remover manual', (await api(`/api/manuais/${idm}`, 'DELETE')).status === 200 && (await api(`/api/cotacoes/${idc}`)).j.valores_manuais.length === 2);

console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
