// Cotação online (Braspress e SSW simulados) contra o PostgreSQL local, mesma preparação do sync.test.mjs.
import worker from '../src/index.js';
import { lerResposta, montarParametros, envelope } from '../src/apis/ssw.js';
import { normalizarPedido } from '../src/apis/comum.js';
import { psql } from './pgpsql.mjs';
import { cadastrarAdmins } from './usuarios.mjs';

let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') },
  BRASPRESS_CONTAS: JSON.stringify([{ cnpj: '12.995.553/0001-00', usuario: 'U1', senha: 'S1' }, { cnpj: '46816509000108', usuario: 'U2', senha: 'S2' }]),
  SSW_TRANSPORTADORAS: JSON.stringify([{ transportadora: 'Expresso Leomar', dominio: 'LEO', login: 'proloplast', senha: 'segredo', cnpjPagador: '12995553000100' }]) };
const api = async (path, method = 'GET', body) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': 'luis@x' } }), env, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
const WSDL = `<definitions targetNamespace="urn:sswinfbr.sswCotacao"><binding><operation name="cotar"><soap:operation soapAction="urn:sswinfbr.sswCotacao#cotar" style="rpc"/></operation></binding></definitions>`;
const sswResp = (inner) => `<?xml version="1.0"?><SOAP-ENV:Envelope><SOAP-ENV:Body><ns1:cotarResponse><return xsi:type="xsd:string">${inner.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</return></ns1:cotarResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
let bp = () => ({ s: 200, j: { id: 777, prazo: 6, totalFrete: 301.45 } });
let leo = () => sswResp('<cotacao><erro>0</erro><mensagem>OK</mensagem><frete>210,30</frete><prazo>4</prazo><totalFrete>212,40</totalFrete><cotacao>88123</cotacao></cotacao>');
const chamadas = [];
globalThis.fetch = async (url, o = {}) => {
  url = String(url); chamadas.push({ url, o });
  const R = (s, j) => new Response(JSON.stringify(j), { status: s });
  if (url.includes('brasilapi.com.br/api/cnpj/v1/12995553000100')) return R(200, { razao_social: 'PROLOPLAST INDUSTRIA', nome_fantasia: 'PROLOPLAST', municipio: 'NOVA SANTA RITA', uf: 'RS', cep: '92480-000' });
  if (url.includes('cnpj')) return R(404, {});
  if (url.includes('api.braspress.com')) { const r = bp(JSON.parse(o.body)); return R(r.s, r.j); }
  if (url.endsWith('sswCotacao/index.php?wsdl')) return new Response(WSDL);
  if (url.includes('sswCotacao/index.php')) return new Response(leo(o.body));
  return R(404, {});
};

// ---- unidades
const req = normalizarPedido({ cepDestino: '57400-000', peso: 19, vlrMercadoria: 697.51, volumes: 2, m3: 0.054, cnpjDestinatario: '' }, { cnpj: '12995553000100', cep: '92480000' });
t('pedido normalizado: cubo pelo m³', req.cubagem[0].volumes === 2 && Math.abs(req.m3 - 0.054) < 0.001 && req.cnpjDestinatario === null && req.cepOrigem === '92480000');
const par = montarParametros({ dominio: 'LEO', login: 'l', senha: 's', extras: { ciffob: 'C' } }, req);
t('SSW: parâmetros', par.cnpjPagador === '12995553000100' && par.volume === '0.0540' && par.quantidade === 2 && par.ciffob === 'C' && !('cnpjDestinatario' in par));
t('SSW: envelope', /<ws:cotar><dominio>LEO<\/dominio>/.test(envelope({ ns: 'urn:x' }, par)) && /xmlns:ws="urn:x"/.test(envelope({ ns: 'urn:x' }, par)));
t('SSW: resposta com totalFrete', lerResposta(sswResp('<cotacao><erro>0</erro><totalFrete>1.234,56</totalFrete><prazo>3</prazo><cotacao>9</cotacao></cotacao>')).total === 1234.56);
let msg = ''; try { lerResposta(sswResp('<cotacao><erro>1</erro><mensagem>CEP nao atendido</mensagem></cotacao>')); } catch (e) { msg = e.message; }
t('SSW: erro da transportadora', msg === 'SSW: CEP nao atendido');
msg = ''; try { lerResposta('<Envelope><Fault><faultstring>Login invalido</faultstring></Fault></Envelope>'); } catch (e) { msg = e.message; }
t('SSW: SOAP fault', msg === 'SSW: Login invalido');

// ---- migração da versão anterior (braspress_cotacoes)
psql(`CREATE TABLE braspress_cotacoes (id BIGSERIAL, criado_em TIMESTAMPTZ DEFAULT now(), usuario TEXT, chave TEXT, cnpj_remetente TEXT, cep_destino TEXT,
  peso NUMERIC, volumes INT, valor_mercadoria NUMERIC, requisicao JSONB, resposta JSONB, id_braspress TEXT, total NUMERIC, prazo INT, erro TEXT);
  INSERT INTO braspress_cotacoes (usuario, chave, total, prazo, id_braspress) VALUES ('antigo','k',100,5,'1');`);

// ---- status e configuração
await cadastrarAdmins(api, 'luis@x');
let r = await api('/api/online/status');
t('status: 2 integrações ativas', r.status === 200 && r.j.integracoes.filter((i) => i.ativa).map((i) => i.id).join() === 'braspress,ssw-expresso-leomar');
t('consultas antigas migradas', +psql(`SELECT count(*) FROM api_consultas WHERE integracao='braspress' AND usuario='antigo';`).trim() === 1);
t('remetente padrão: Nova Santa Rita', r.j.remetente.cnpj === '12995553000100' && r.j.remetente.cep === '92480000' && !r.j.remetente.cepPresumido);
r = await api('/api/config');
t('config: CNPJs da empresa', r.j.remetentes.length === 2 && r.j.remetentes[0].nome === 'PROLOPLAST');

// ---- cotação em todas
const corpo = { cepDestino: '57400000', peso: 19, vlrMercadoria: 697.51, volumes: 1, cubagem: [{ comprimento: 0.16, largura: 0.4, altura: 0.55, volumes: 1 }], cnpjDestinatario: '11.222.333/0001-81' };
chamadas.length = 0;
r = await api('/api/online/cotar', 'POST', corpo);
const L = Object.fromEntries(r.j.resultados.map((x) => [x.integracao, x]));
t('Braspress online', L.braspress.ok && L.braspress.total === 301.45 && L.braspress.tabela === 'bp');
t('Leomar via SSW', L['ssw-expresso-leomar'].ok && L['ssw-expresso-leomar'].total === 212.4 && L['ssw-expresso-leomar'].prazo === 4 && L['ssw-expresso-leomar'].id === '88123');
const soap = chamadas.find((c) => c.url.endsWith('sswCotacao/index.php'));
t('SOAP com soapAction do WSDL e destinatário', soap.o.headers.soapaction === '"urn:sswinfbr.sswCotacao#cotar"' && /<cnpjDestinatario>11222333000181<\/cnpjDestinatario>/.test(soap.o.body));
t('senha não gravada no registro', !/segredo/.test(psql(`SELECT requisicao::text FROM api_consultas WHERE integracao='ssw-expresso-leomar';`)));
chamadas.length = 0;
r = await api('/api/online/cotar', 'POST', corpo);
t('repetição no dia: cache, sem chamar', r.j.resultados.every((x) => x.doCache) && !chamadas.some((c) => /braspress|sswCotacao/.test(c.url)));

// ---- falha de uma não derruba a outra
leo = () => sswResp('<cotacao><erro>1</erro><mensagem>Cliente sem tabela</mensagem></cotacao>');
r = await api('/api/online/cotar', 'POST', { ...corpo, peso: 20 });
t('uma falha, a outra responde', r.j.resultados.find((x) => x.integracao === 'braspress').ok && r.j.resultados.find((x) => x.integracao === 'ssw-expresso-leomar').erro === 'SSW: Cliente sem tabela');

// ---- desativar e testar
r = await api('/api/online/ativar', 'POST', { id: 'ssw-expresso-leomar', ativa: false });
r = await api('/api/online/cotar', 'POST', { ...corpo, peso: 21 });
t('desativada não é consultada', r.j.resultados.length === 1);
leo = () => sswResp('<cotacao><erro>0</erro><totalFrete>99,90</totalFrete><prazo>2</prazo></cotacao>');
r = await api('/api/online/testar', 'POST', { id: 'ssw-expresso-leomar' });
t('teste de conexão', r.j.ok && r.j.total === 99.9);
r = await api('/api/online/status');
const sl = r.j.integracoes.find((i) => i.id === 'ssw-expresso-leomar');
t('status: desativada, último teste ok, estatística sem testes', !sl.ativa && sl.ultima.ok && sl.ultima.teste && sl.consultas30 === 2 && sl.sucesso30 === 1);

// ---- configurar remetente
r = await api('/api/config', 'POST', { cnpj: '46816509000108', cep: '93000-000' });
t('remetente configurado', r.j.remetente.cnpj === '46816509000108' && r.j.remetente.cep === '93000000');
chamadas.length = 0;
await api('/api/online/cotar', 'POST', { ...corpo, peso: 22 });
const bpc = chamadas.find((c) => c.url.includes('braspress'));
t('Braspress usa a conta do remetente', bpc.o.headers.authorization === 'Basic ' + btoa('U2:S2') && JSON.parse(bpc.o.body).cepOrigem === 93000000);

t('validação', (await api('/api/online/cotar', 'POST', { ...corpo, peso: 0 })).status === 400);

// ---- análise online × tabela, por transportadora
await api('/api/cotacoes', 'POST', { uf: 'AL', resultados: [
  { transportadora: 'Braspress', total: 301.45, fonte_valor: 'online', valor_online: 301.45, valor_tabela: 280, praca_tabela: 'Interior AL' },
  { transportadora: 'Expresso Leomar', total: 212.4, fonte_valor: 'online', valor_online: 212.4, valor_tabela: null }] });
r = await api('/api/divergencias');
t('análise online × tabela', r.j.online.linhas.length === 1 && r.j.online.por_transportadora[0].grupo === 'Braspress' && r.j.online.fontes.length === 2);

console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
