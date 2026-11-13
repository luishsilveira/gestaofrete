// Teste da cotação online da Braspress (API simulada) contra o PostgreSQL local (mesma preparação do sync.test.mjs).
import worker from '../src/index.js';
import { montarRequisicao, DESTINATARIO_GENERICO } from '../src/braspress.js';
let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') },
  BRASPRESS_CONTAS: JSON.stringify([{ cnpj: '12.995.553/0001-00', usuario: 'U1', senha: 'S1' }, { cnpj: '46816509000108', usuario: 'U2', senha: 'S2', cepOrigem: '92480-000' }]) };
const api = async (path, method = 'GET', body) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': 'luis@x' } }), env, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
const chamadas = []; let respostaBP = () => ({ s: 200, j: { id: 777, prazo: 6, totalFrete: 301.45 } });
globalThis.fetch = async (url, o = {}) => {
  url = String(url); chamadas.push({ url, o });
  const R = (s, j) => new Response(JSON.stringify(j), { status: s });
  if (url.includes('brasilapi.com.br/api/cnpj/v1/12995553000100')) return R(200, { razao_social: 'PROLOPLAST LTDA', nome_fantasia: 'PROLOPLAST', municipio: 'NOVA SANTA RITA', uf: 'RS', cep: '92480-000' });
  if (url.includes('brasilapi')) return R(404, {});
  if (url.includes('api.braspress.com')) { const r = respostaBP(JSON.parse(o.body)); return R(r.s, r.j); }
  return R(404, {});
};

// montagem
const q = montarRequisicao({ cnpj: '12995553000100', cepOrigem: '92480000' }, { cepDestino: '57400-000', peso: 19, vlrMercadoria: 697.51, volumes: 2, m3: 0.054 });
t('cubagem pelo m³ e destinatário genérico', q.cubagem.length === 1 && q.cubagem[0].volumes === 2 && Math.abs(q.cubagem[0].altura ** 3 * 2 - 0.054) < 0.001 && q.cnpjDestinatario === +DESTINATARIO_GENERICO && q.tipoFrete === '1' && q.modal === 'R' && q.cepDestino === 57400000);

let r = await api('/api/braspress/status');
t('status: contas, padrão em Nova Santa Rita, sem senha', r.j.configurado && r.j.contas.length === 2 && r.j.contas[0].padrao && r.j.contas[0].cepOrigem === '92480000' && !('senha' in r.j.contas[0]) && r.j.contas[1].cepOrigem === '92480-000'.replace('-', ''));
const corpo = { cepDestino: '57400000', peso: 19, vlrMercadoria: 697.51, volumes: 1, cubagem: [{ comprimento: 0.16, largura: 0.4, altura: 0.55, volumes: 1 }], cnpjDestinatario: '11.222.333/0001-81' };
chamadas.length = 0;
r = await api('/api/braspress/cotar', 'POST', corpo);
const env1 = chamadas.find((c) => c.url.includes('braspress'));
t('cotação ok', r.status === 200 && r.j.totalFrete === 301.45 && r.j.prazo === 6 && r.j.id === '777' && r.j.cnpjRemetente === '12995553000100');
t('Basic auth e corpo', env1.o.headers.authorization === 'Basic ' + btoa('U1:S1') && JSON.parse(env1.o.body).cnpjDestinatario === 11222333000181 && JSON.parse(env1.o.body).cepOrigem === 92480000);
chamadas.length = 0;
r = await api('/api/braspress/cotar', 'POST', corpo);
t('mesma cotação no dia vem do cache', r.j.doCache && !chamadas.some((c) => c.url.includes('braspress')));
r = await api('/api/braspress/cotar', 'POST', { ...corpo, cnpjRemetente: '46816509000108' });
t('outro remetente usa a conta dele', chamadas.some((c) => c.o.headers && c.o.headers.authorization === 'Basic ' + btoa('U2:S2')) && r.j.cnpjRemetente === '46816509000108');
respostaBP = () => ({ s: 400, j: { statusCode: 400, message: 'Dados inválidos', errorList: [{ message: 'CEP destino não atendido' }] } });
r = await api('/api/braspress/cotar', 'POST', { ...corpo, peso: 20 });
t('erro da Braspress repassado', r.status === 502 && /CEP destino não atendido/.test(r.j.erro));
respostaBP = () => ({ s: 401, j: {} });
r = await api('/api/braspress/cotar', 'POST', { ...corpo, peso: 21 });
t('senha recusada', r.status === 502 && /recusou/.test(r.j.erro));
t('validação de entrada', (await api('/api/braspress/cotar', 'POST', { ...corpo, peso: 0 })).status === 400);
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
