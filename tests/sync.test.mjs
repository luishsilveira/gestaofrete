import { db, psql } from './pgpsql.mjs';
import { SCHEMA_BLING, sincronizarPedidos, gravarPedidos, buscarPedido, BLING } from '../src/bling.js';
import fs from 'node:fs';
const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const SCHEMA = idx.match(/const SCHEMA = `([\s\S]*?)`;/)[1];
let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
psql(SCHEMA); psql(SCHEMA_BLING); psql(SCHEMA_BLING);
psql(`INSERT INTO bling_tokens (id, access_token, refresh_token, expira_em) VALUES (1,'TK','RF', now()+interval '5 hours');`);
const env = { BLING_CLIENT_ID: 'c', BLING_CLIENT_SECRET: 's' };
const hoje = new Date().toISOString().slice(0, 10);
let LISTA = [
  { id: 101, numero: 5001, data: hoje, total: 1000, situacao: { id: 6 } },
  { id: 102, numero: 5002, data: hoje, total: 2000, situacao: { id: 6 } },
  { id: 103, numero: 5003, data: hoje, total: 3283.35, situacao: { id: 9 } },
];
const DET = {
  101: { id: 101, numero: 5001, data: hoje, totalProdutos: 1000, total: 1000, situacao: { id: 6 }, contato: { id: 1, nome: 'Cliente A', numeroDocumento: '11.111.111/0001-11' },
         transporte: { frete: 0, fretePorConta: 0, pesoBruto: 50, quantidadeVolumes: 2, etiqueta: { cep: '90010-000', municipio: 'Porto Alegre', uf: 'RS' } } },
  102: { id: 102, numero: 5002, data: hoje, totalProdutos: 2000, total: 2000, situacao: { id: 6 }, contato: { id: 2, nome: 'Cliente B' },
         transporte: { frete: 150.5, pesoBruto: 80, quantidadeVolumes: 3, etiqueta: {}, contato: { nome: 'Braspress' } } },
  103: { id: 103, numero: 5003, data: hoje, totalProdutos: 3283.35, total: 3283.35, situacao: { id: 9 }, contato: { id: 3, nome: 'Irisvan' },
         transporte: { frete: 400, pesoBruto: 190, quantidadeVolumes: 10, etiqueta: { cep: '65901-307', municipio: 'Imperatriz', uf: 'MA' } } },
};
let recusaAlteracao = false; const urls = [];
const fakeFetch = async (url) => {
  const u = url.replace(BLING.apiBase, ''); urls.push(u);
  const R = (s, j) => ({ ok: s < 300, status: s, json: async () => j });
  if (u.startsWith('/pedidos/vendas?')) {
    if (recusaAlteracao && u.includes('dataAlteracaoInicial')) return R(400, { error: { description: 'parâmetro inválido' } });
    if (u.includes('numero=')) { const n = u.match(/numero=(\d+)/)[1]; return R(200, { data: LISTA.filter((p) => String(p.numero) === n) }); }
    return R(200, { data: u.includes('pagina=1') ? LISTA : [] });
  }
  const m = u.match(/^\/pedidos\/vendas\/(\d+)$/); if (m) return R(200, { data: JSON.parse(JSON.stringify(DET[m[1]])) });
  if (u === '/contatos/2') return R(200, { data: { numeroDocumento: '222', endereco: { geral: { cep: '57400-000', municipio: 'Pão de Açúcar', uf: 'AL' } } } });
  const s = u.match(/^\/situacoes\/(\d+)$/); if (s) return R(200, { data: { id: +s[1], nome: s[1] === '6' ? 'Em aberto' : 'Atendido' } });
  return R(404, {});
};
// 1ª sincronização
let r = await sincronizarPedidos(env, db, fakeFetch);
t(`1ª sync: ${r.mensagem}`, r.lidos === 3 && r.completo && r.pendentes === 0);
t('filtro dataAlteracaoInicial = hoje-30', urls[0].includes('dataAlteracaoInicial=' + new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)));
let P = JSON.parse(psql(`SELECT json_agg(t ORDER BY id) FROM (SELECT id, numero, cep, cidade, uf, origem_cep, peso_bruto, volumes, frete_bling, transportadora_bling, documento, importado_por FROM pedidos_bling) t;`));
t('3 pedidos gravados', P.length === 3);
t('CEP da etiqueta (101)', P[0].cep === '90010000' && P[0].origem_cep === 'etiqueta de transporte');
t('CEP do cadastro (102) + doc', P[1].cep === '57400000' && P[1].origem_cep === 'cadastro do cliente' && P[1].documento === '222');
t('frete e transportadora do Bling (102)', +P[1].frete_bling === 150.5 && P[1].transportadora_bling === 'Braspress');
t('importado_por automático', P[0].importado_por === 'importação automática');
t('dados brutos guardados', psql(`SELECT dados->'transporte'->>'pesoBruto' FROM pedidos_bling WHERE id=103;`).trim() === '190');
t('situações nomeadas', psql(`SELECT string_agg(nome, ',' ORDER BY id) FROM bling_situacoes;`).trim() === 'Em aberto,Atendido');
t('bling_sync gravado', psql(`SELECT ultimo_completo IS NOT NULL FROM bling_sync;`).trim() === 't');
// 2ª sincronização sem mudanças
urls.length = 0; r = await sincronizarPedidos(env, db, fakeFetch);
t(`2ª sync sem mudanças: ${r.mensagem} (${r.chamadas} chamadas)`, r.lidos === 0 && r.chamadas === 1);
t('desde = último completo - 1 dia', urls[0].includes('dataAlteracaoInicial=' + new Date(Date.now() - 864e5).toISOString().slice(0, 10)));
// pedido alterado
LISTA[1].total = 2100; DET[102].total = 2100; DET[102].transporte.frete = 199.9;
r = await sincronizarPedidos(env, db, fakeFetch);
t('pedido alterado relido', r.lidos === 1 && psql(`SELECT frete_bling FROM pedidos_bling WHERE id=102;`).trim() === '199.90');
// limite de chamadas
psql(`DELETE FROM pedidos_bling; DELETE FROM bling_sync;`);
r = await sincronizarPedidos(env, db, fakeFetch, { limiteChamadas: 4 });
const st = psql(`SELECT ultimo_completo IS NULL FROM bling_sync;`).trim();
t(`limite de chamadas: ${r.mensagem}`, r.pendentes > 0 && !r.completo && st === 't');
r = await sincronizarPedidos(env, db, fakeFetch);
t('execução seguinte completa o que faltou', psql(`SELECT count(*) FROM pedidos_bling;`).trim() === '3' && r.completo);
// Bling recusa dataAlteracaoInicial
recusaAlteracao = true; urls.length = 0; psql(`DELETE FROM bling_sync;`);
r = await sincronizarPedidos(env, db, fakeFetch);
t('reserva com dataInicial', urls.some((u) => u.includes('dataInicial=')) && r.listados === 3);
recusaAlteracao = false;
// busca manual grava o pedido
const p = await buscarPedido('TK', '5003', fakeFetch);
const { _bruto, ...n } = p; await gravarPedidos(db, [{ n, bruto: _bruto }], 'luis@x');
t('busca manual atualiza pedido (importado_por mantém o 1º)', psql(`SELECT importado_por FROM pedidos_bling WHERE id=103;`).trim() === 'importação automática');
// consulta da tela de pedidos (SQL do index.js)
psql(`INSERT INTO cotacoes (usuario, resultados, bling_pedido_id, melhor_transportadora, melhor_valor, transportadora_escolhida, valor_escolhido) VALUES ('u','[]',103,'Bento',331.25,'Bento',331.25);`);
const sqlLista = idx.match(/`(SELECT p\.id, p\.numero[\s\S]*?LIMIT \$1)`/)[1];
const run = (cond) => JSON.parse(psql(`SELECT coalesce(json_agg(t),'[]') FROM (${sqlLista.replace("${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}", cond).replace('$1', '200')}) t;`));
let L = run('');
t('lista com cotação e situação', L.length === 3 && L.find((x) => x.id === 103).cotacao_id && L.find((x) => x.id === 101).situacao === 'Em aberto');
t('filtro sem cotação', run('WHERE c.id IS NULL').length === 2);
t('filtro frete acima da cotação (400 > 331,25)', run('WHERE p.frete_bling > 0 AND c.id IS NOT NULL AND p.frete_bling > COALESCE(c.valor_escolhido, c.melhor_valor) + 0.01').map((x) => x.id).join() === '103');
// sem permissão de Contatos: importação continua
psql(`DELETE FROM pedidos_bling; DELETE FROM bling_sync;`);
const fetch403 = async (url) => (url.includes('/contatos/') ? { ok: false, status: 403, json: async () => ({ error: { description: 'The request requires higher privileges than provided by the access token' } }) } : fakeFetch(url));
r = await sincronizarPedidos(env, db, fetch403);
t(`sem permissão de Contatos: ${r.mensagem}`, r.lidos === 3 && r.semContatos && psql(`SELECT cep IS NULL FROM pedidos_bling WHERE id=102;`).trim() === 't');
// 403 em pedidos: mensagem clara
try { await sincronizarPedidos(env, db, async () => ({ ok: false, status: 403, json: async () => ({}) })); t('403 pedidos', false); }
catch (e) { t('403 em pedidos → ' + e.message, e.codigo === 'permissao' && /pedidos\/vendas/.test(e.message)); }
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
