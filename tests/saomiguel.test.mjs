// Cotação online na Expresso São Miguel (API simulada) contra o PostgreSQL local, mesma preparação do sync.test.mjs.
import worker from '../src/index.js';
import { montarRequisicao, diasUteisAte, URL } from '../src/apis/saomiguel.js';
import { normalizarPedido } from '../src/apis/comum.js';
import { psql } from './pgpsql.mjs';
import { cadastrarAdmins } from './usuarios.mjs';

let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') }, BLING_CLIENT_SECRET: 'segredo-de-teste' };
const api = async (path, method = 'GET', body) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': 'luis@x' } }), env, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
let sm = () => ({ s: 200, j: { status: 'ok', mensagem: '', data: '19/11/2026 10:00:00', valorFrete: 217.5, previsaoEmbarque: '19/11/2026', previsaoEntrega: '24/11/2026 15:00', informacaoEntrega: 'Entrega prevista' } });
const chamadas = [];
globalThis.fetch = async (url, o = {}) => {
  url = String(url); chamadas.push({ url, o });
  const R = (s, j) => new Response(JSON.stringify(j), { status: s });
  if (url.includes('viacep.com.br/ws/99999999')) return R(200, { erro: true });
  if (url.includes('viacep.com.br/ws/')) return R(200, { localidade: 'Londrina', uf: 'PR', ibge: '4113700' });
  if (url === URL) { const r = sm(JSON.parse(o.body), o.headers); return R(r.s, r.j); }
  if (url.includes('cnpj')) return R(404, {});
  return R(404, {});
};

// ---- unidades
const hoje = new Date(Date.UTC(2026, 10, 19)); // quinta-feira, 19/11/2026
t('dias úteis até a previsão (qui → ter = 3)', diasUteisAte('24/11/2026 15:00', hoje) === 3);
t('entrega no dia seguinte = 1; mesmo dia = 1; data inválida = null', diasUteisAte('20/11/2026', hoje) === 1 && diasUteisAte('19/11/2026', hoje) === 1 && diasUteisAte('', hoje) === null);
const req = normalizarPedido({ cepDestino: '86010-000', peso: 16, vlrMercadoria: 795.49, volumes: 2, m3: 0.0517, cnpjDestinatario: '12.345.678/0001-90' }, { cnpj: '12995553000100', cep: '92480000' });
const corpo = montarRequisicao(req, 4113700, hoje);
t('requisição no formato do manual', corpo.tipoPagoPagar === 'P' && corpo.codigoCidadeDestino === 4113700 && corpo.quantidadeMercadoria === 2 && corpo.pesoMercadoria === 16
  && Math.abs(corpo.cubagemMercadoria - 0.0517) < 0.001 && corpo.valorMercadoria === 795.49 && corpo.clienteDestino === '12345678000190' && corpo.dataEmbarque === '19/11/2026' && corpo.tipoPessoaDestino === 'J');
const semDoc = montarRequisicao(normalizarPedido({ cepDestino: '86010000', peso: 1, vlrMercadoria: 1, m3: 0.01 }, { cnpj: '1', cep: '92480000' }), 1, hoje);
t('sem destinatário: CPF genérico, pessoa física', semDoc.clienteDestino === '00000000191' && semDoc.tipoPessoaDestino === 'F');

// ---- pela aplicação
await cadastrarAdmins(api, 'luis@x');
let r = await api('/api/online/credenciais', 'POST', { tipo: 'saomiguel', dados: { customer: '12.995.553/0001-00', accessKey: 'CHAVE-100' } });
t('cadastra chave pela tela', r.status === 200);
await api('/api/online/credenciais', 'POST', { tipo: 'saomiguel', dados: { customer: '46816509000108', accessKey: 'CHAVE-108' } });
t('CNPJ inválido recusado', (await api('/api/online/credenciais', 'POST', { tipo: 'saomiguel', dados: { customer: '123', accessKey: 'x' } })).status === 400);
r = await api('/api/online/credenciais');
const cs = r.j.find((x) => x.tipo === 'saomiguel');
t('lista sem a chave', cs && cs.entradas.length === 2 && !JSON.stringify(cs).includes('CHAVE-100'));
t('chave guardada criptografada', !psql(`SELECT dados FROM integracoes_credenciais WHERE tipo='saomiguel';`).includes('CHAVE'));
r = await api('/api/online/status');
const st = r.j.integracoes.find((i) => i.id === 'saomiguel');
t('integração aparece ativa, comparando com a tabela da São Miguel', st && st.configurada && st.ativa && st.tabela === 'sm' && st.transportadora === 'Expresso São Miguel');

const pedido = { cepDestino: '86010-000', peso: 16, vlrMercadoria: 795.49, volumes: 1, m3: 0.035, cnpjDestinatario: '12345678000190', integracao: 'saomiguel' };
r = await api('/api/online/cotar', 'POST', pedido);
let x = r.j.resultados[0];
t('cota: valor e prazo em dias úteis', r.status === 200 && x.ok && x.total === 217.5 && x.prazo >= 1 && /entrega prevista 24\/11\/2026/.test(x.obs));
const ch = chamadas.filter((c) => c.url === URL).at(-1);
t('headers ACCESS_KEY, CUSTOMER e VERSION 2 (chave do CNPJ remetente)', ch.o.headers.ACCESS_KEY === 'CHAVE-100' && ch.o.headers.CUSTOMER === '12995553000100' && ch.o.headers.VERSION === '2');
const n1 = chamadas.filter((c) => c.url === URL).length;
r = await api('/api/online/cotar', 'POST', pedido);
t('mesma consulta no dia vem do registro (não gasta o limite)', r.j.resultados[0].doCache && chamadas.filter((c) => c.url === URL).length === n1);

sm = () => ({ s: 200, j: { status: 'erro', mensagem: 'Cidade de destino n&atilde;o atendida' } });
r = await api('/api/online/cotar', 'POST', { ...pedido, peso: 17 });
x = r.j.resultados[0];
t('recusa da São Miguel = não atende', !x.ok && x.tipoErro === 'nao_atende' && /não atendida/.test(x.erro));
sm = () => ({ s: 401, j: null });
r = await api('/api/online/cotar', 'POST', { ...pedido, peso: 18 });
t('401: chave ou limite, como falha', !r.j.resultados[0].ok && r.j.resultados[0].tipoErro === 'falha' && /30 minutos/.test(r.j.resultados[0].erro));
r = await api('/api/online/cotar', 'POST', { ...pedido, cepDestino: '99999-999', peso: 19 });
t('sem IBGE: falha clara', !r.j.resultados[0].ok && /IBGE/.test(r.j.resultados[0].erro));

// limite por minuto: com 15 consultas no último minuto, não chama a São Miguel
sm = () => ({ s: 200, j: { status: 'ok', valorFrete: 100, previsaoEntrega: '25/11/2026' } });
psql(`INSERT INTO api_consultas (integracao, chave, criado_em) SELECT 'saomiguel', 'x' || g, now() FROM generate_series(1, 15) g;`);
const n2 = chamadas.filter((c) => c.url === URL).length;
r = await api('/api/online/cotar', 'POST', { ...pedido, peso: 20 });
t('limite por minuto: cai para a tabela sem chamar a API', !r.j.resultados[0].ok && /limite de 15/.test(r.j.resultados[0].erro) && chamadas.filter((c) => c.url === URL).length === n2);
psql(`UPDATE api_consultas SET criado_em = now() - interval '2 minutes' WHERE integracao = 'saomiguel';`);
r = await api('/api/online/cotar', 'POST', { ...pedido, peso: 20 });
t('passado o minuto, volta a cotar', r.j.resultados[0].ok && r.j.resultados[0].total === 100);
r = await api('/api/online/testar', 'POST', { id: 'saomiguel' });
t('testar conexão', r.status === 200 && r.j.ok);

console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
