// Envio da cotação para a proposta comercial no Bling, contra um PostgreSQL local (via psql) e um Bling simulado.
// Requer o mesmo ambiente de tests/sync.test.mjs (Postgres na porta 5499, banco "gf" vazio, stub do módulo "pg").
import { psql } from './pgpsql.mjs';
import { cadastrarAdmins } from './usuarios.mjs';
import worker from '../src/index.js';
import { BLING, definirRitmoBling } from '../src/bling.js';
import { juntarObservacao, blocoObservacao, linhaCompacta, juntarCompacto } from '../src/propostaBling.js';
definirRitmoBling({ intervalo: 0, esperasLimite: [1, 1] });

let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { BLING_CLIENT_ID: 'c', BLING_CLIENT_SECRET: 's', HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('asset') } };
const ctx = { waitUntil: () => {} };
const api = async (path, method = 'GET', body, email = 'luis@x') => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' } }), env, ctx);
  return { status: r.status, j: await r.json() };
};
await cadastrarAdmins(api, 'luis@x');
psql(`INSERT INTO bling_tokens (id, access_token, refresh_token, expira_em) VALUES (1,'TK','RF', now()+interval '5 hours');`);

// ---------- funções puras
const b1 = blocoObservacao({ transportadora: 'Braspress', valor: 162.05, prazo: '5', cotacaoOnline: '777' });
t('bloco com nº online, custo e prazo', b1.includes('Transportadora: Braspress') && b1.includes('Nº da cotação (online): 777') && b1.includes('R$ 162,05') && b1.includes('5 dias úteis'));
t('bloco sem nº quando é tabela', !blocoObservacao({ transportadora: 'TJB', valor: 10, prazo: '1' }).includes('Nº da cotação'));
const ob1 = juntarObservacao('Cliente pediu entrega pela manhã', b1);
t('mantém o texto do vendedor e acrescenta o bloco', ob1.startsWith('Cliente pediu entrega pela manhã\n\n') && ob1.endsWith(b1));
const b2 = blocoObservacao({ transportadora: 'Rodonaves', valor: 100, prazo: '2' });
const ob2 = juntarObservacao(ob1 + '\nOutra nota depois', b2);
t('troca só o bloco anterior', ob2.includes('Cliente pediu entrega') && ob2.includes('Outra nota depois') && ob2.includes('Rodonaves') && !ob2.includes('Braspress'));
t('linha compacta do exemplo', linhaCompacta({ valor: 187.15, prazo: '4', cotacaoOnline: '23569' }) === '23569/18715.4');
t('linha compacta sem cotação', linhaCompacta({ valor: 187.15, prazo: 4 }) === '/18715.4');
t('linha compacta: milhar e centavos', linhaCompacta({ valor: 1234.5, prazo: '10 dias' }) === '/123450.10' && linhaCompacta({ valor: 0.5, prazo: null }) === '/50');
t('observações: acrescenta numa linha nova', juntarCompacto('Validade 10 dias', '1/2.3') === 'Validade 10 dias\n1/2.3' && juntarCompacto('', '1/2.3') === '1/2.3');
t('observações: troca a linha enviada antes', juntarCompacto('Validade\n1/2.3\nfim', '9/9.9', ['1/2.3']) === 'Validade\n9/9.9\nfim');
t('campo vazio: só o bloco', juntarObservacao('', b2) === b2 && juntarObservacao(null, b2) === b2);

// ---------- Bling simulado (proposta 159504 de teste e 159461 normal)
const propostas = {
  301: { id: 301, numero: 159504, total: 1000, totalProdutos: 1000, situacao: 'Pendente', contato: { id: 3, nome: 'Cliente Teste' },
         observacaoInterna: 'Anotação do vendedor', observacoes: 'Validade da proposta: 10 dias', transporte: { fretePorConta: 0, frete: 0, contato: { id: 0 } },
         itens: [{ produto: { id: 501 }, quantidade: 10, valor: 100 }] },
  302: { id: 302, numero: 159461, total: 500, totalProdutos: 500, situacao: 'Pendente', contato: { id: 4, nome: 'Outro' }, itens: [{ produto: { id: 501 }, quantidade: 5, valor: 100 }] },
};
const puts = []; let recusarPut = false, ignorarTransportador = false;
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url).replace(BLING.apiBase, '');
  const R = (s, j) => new Response(j === undefined ? null : JSON.stringify(j), { status: s, headers: { 'content-type': 'application/json' } });
  let m;
  if ((m = u.match(/^\/propostas-comerciais\/(\d+)$/))) {
    if (opt.method === 'PUT') {
      const b = JSON.parse(opt.body); puts.push({ id: +m[1], b });
      if (recusarPut) return R(400, { error: { type: 'VALIDATION_ERROR', description: 'Não foi possível salvar', fields: [{ element: 'itens', msg: 'Produto inválido' }] } });
      const novo = structuredClone(b);
      if (ignorarTransportador) novo.transporte.contato = propostas[m[1]].transporte.contato;
      novo.total = b.totalProdutos + (b.transporte.frete || 0);
      propostas[m[1]] = novo; return R(204);
    }
    return propostas[m[1]] ? R(200, { data: structuredClone(propostas[m[1]]) }) : R(404, {});
  }
  if (u.startsWith('/contatos?')) return R(200, { data: [{ id: 9988, nome: 'BRASPRESS TRANSPORTES URGENTES', numeroDocumento: '48740351000165', situacao: 'A' }] });
  if (u === '/contatos/9988') return R(200, { data: { id: 9988, nome: 'BRASPRESS TRANSPORTES URGENTES', numeroDocumento: '48740351000165' } });
  return R(404, {});
};
psql(`INSERT INTO propostas_bling (id, numero) VALUES (301,'159504'), (302,'159461') ON CONFLICT DO NOTHING;`);
const salvar = async (prop, extra = {}) => (await api('/api/cotacoes', 'POST', {
  resultados: [{ transportadora: 'Braspress', total: 162.05, prazo: '5', fonte_valor: 'online', valor_online: 162.05, cotacao_online: '777' },
    { transportadora: 'TJB', total: 170, prazo: '7' }],
  transportadora_escolhida: 'Braspress', valor_escolhido: 162.05, bling_proposta_id: prop, ...extra })).j.id;

// ---------- cadastro de transportadoras
let r = await api('/api/transportadoras/contatos-bling?q=braspress');
t('busca contato no Bling', r.status === 200 && r.j.contatos[0].id === 9988);
r = await api('/api/transportadoras/contatos-bling?q=9988');
t('busca contato pelo código', r.j.contatos[0].nome.startsWith('BRASPRESS'));
r = await api('/api/transportadoras/cadastro', 'POST', { cadastro: [{ nome: 'Braspress', acrescimo_pct: '10,5', bling_contato_id: '9988', bling_contato_nome: 'BRASPRESS TRANSPORTES URGENTES' }] });
t('salva cadastro (vírgula no %)', r.status === 200 && +r.j.cadastro[0].acrescimo_pct === 10.5 && +r.j.cadastro[0].bling_contato_id === 9988);
r = await api('/api/transportadoras/cadastro', 'POST', { cadastro: [{ nome: 'TJB', acrescimo_pct: '-3' }] });
t('recusa % negativo', r.status === 400);

// ---------- prévia e envio
const c1 = await salvar(301);
r = await api('/api/bling/proposta/previa', 'POST', { cotacao_id: c1 });
t('prévia: valores', r.status === 200 && r.j.valor_custo === 162.05 && r.j.valor_enviado === 179.07 && r.j.proposta.numero === '159504' && !r.j.bloqueio);
t('prévia: antes e depois', r.j.antes.observacaoInterna === 'Anotação do vendedor' && r.j.depois.observacaoInterna.includes('Nº da cotação (online): 777') && r.j.depois.transportadorId === 9988);
t('prévia: observações compactas', r.j.depois.observacoes === 'Validade da proposta: 10 dias\n777/16205.5');
t('prévia não grava', puts.length === 0);
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c1 });
t('envio ok e conferido', r.status === 200 && r.j.ok && r.j.conferencia.observacao && r.j.conferencia.observacoes && r.j.conferencia.frete && r.j.conferencia.transportador && r.j.conferencia.itens);
const pb = puts[0].b;
t('PUT mantém o resto da proposta', pb.itens.length === 1 && pb.contato.id === 3 && pb.totalProdutos === 1000 && pb.transporte.fretePorConta === 0);
t('PUT: frete com acréscimo, transportador e observação', pb.transporte.frete === 179.07 && pb.transporte.contato.id === 9988 && pb.observacaoInterna.startsWith('Anotação do vendedor\n\n--- Frete cotado') && pb.observacaoInterna.includes('Valor do frete (custo): R$ 162,05'));
t('registro do envio', psql(`SELECT ok||'/'||valor_enviado||'/'||usuario FROM bling_envios;`).trim() === 'true/179.07/luis@x');
// segundo envio: troca o bloco, não duplica
psql(`UPDATE transportadoras_cadastro SET acrescimo_pct = 0;`);
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c1 });
t('reenvio troca o bloco (sem duplicar)', r.j.ok && (propostas[301].observacaoInterna.match(/Frete cotado/g) || []).length === 1 && propostas[301].observacoes === 'Validade da proposta: 10 dias\n777/16205.5' && propostas[301].transporte.frete === 162.05);

// transportador não aplicado pelo Bling → avisa na conferência
ignorarTransportador = true; propostas[301].transporte.contato = { id: 0 };
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c1 });
t('conferência acusa transportador não gravado', r.status === 200 && !r.j.ok && r.j.conferencia.transportador === false);
ignorarTransportador = false;

// recusa do Bling
recusarPut = true;
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c1 });
t('recusa do Bling com os campos', r.status === 400 && /Produto inválido/.test(r.j.erro));
t('falha registrada', psql(`SELECT count(*) FROM bling_envios WHERE NOT ok AND erro LIKE '%Produto inválido%';`).trim() === '1');
recusarPut = false;

// ---------- modo de teste e permissões
const c2 = await salvar(302);
const nPuts = puts.length;
r = await api('/api/bling/proposta/previa', 'POST', { cotacao_id: c2 });
t('prévia avisa o modo de teste', r.status === 200 && /modo de teste/.test(r.j.bloqueio));
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c2 });
t('modo de teste bloqueia outra proposta', r.status === 409 && puts.length === nPuts);
r = await api('/api/bling/envio-config', 'POST', { modo: 'ligado' });
t('liga o envio', r.status === 200 && r.j.modo === 'ligado');
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c2 });
t('ligado: envia qualquer proposta', r.status === 200 && r.j.ok && propostas[302].observacaoInterna.includes('Braspress'));
await api('/api/bling/envio-config', 'POST', { modo: 'desligado' });
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c2 });
t('desligado bloqueia', r.status === 409);
const c3 = (await api('/api/cotacoes', 'POST', { resultados: [{ transportadora: 'TJB', total: 10 }], bling_pedido_id: 101 })).j.id;
r = await api('/api/bling/proposta/previa', 'POST', { cotacao_id: c3 });
t('cotação de pedido não envia', r.status === 400 && /só existe para propostas/.test(r.j.erro));

psql(`INSERT INTO perfis (nome, permissoes) VALUES ('SemEnvio', '{menu.calc,menu.hist}') ON CONFLICT DO NOTHING;
      INSERT INTO usuarios (email, perfil_id) SELECT 'vend@x', id FROM perfis WHERE nome='SemEnvio' ON CONFLICT DO NOTHING;`);
r = await api('/api/bling/proposta/enviar', 'POST', { cotacao_id: c1 }, 'vend@x');
t('sem permissão: 403', r.status === 403);
r = await api('/api/transportadoras/cadastro', 'POST', { cadastro: [] }, 'vend@x');
t('cadastro só com permissão', r.status === 403);

console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
