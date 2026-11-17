// Credenciais das integrações cadastradas pela tela (banco, criptografadas), PostgreSQL local.
import worker from '../src/index.js';
import { psql } from './pgpsql.mjs';
import { cadastrarAdmins } from './usuarios.mjs';
let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') }, BLING_CLIENT_SECRET: 'segredo-do-bling',
  SSW_TRANSPORTADORAS: JSON.stringify([{ transportadora: 'Expresso Leomar', dominio: 'LEO', login: 'antigo', senha: 'velha' }]) };
const api = async (path, method = 'GET', body, e = env) => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: { 'cf-access-authenticated-user-email': 'luis@x' } }), e, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
await cadastrarAdmins(api, 'luis@x');
const chamadas = [];
globalThis.fetch = async (url, o = {}) => { url = String(url); chamadas.push({ url, o });
  if (url.endsWith('?wsdl')) return new Response('<definitions targetNamespace="urn:sswinfbr.sswCotacao"></definitions>');
  if (url.includes('sswCotacao')) return new Response('<E><B><return>&lt;cotacao&gt;&lt;erro&gt;0&lt;/erro&gt;&lt;totalFrete&gt;150,00&lt;/totalFrete&gt;&lt;prazo&gt;3&lt;/prazo&gt;&lt;/cotacao&gt;</return></B></E>');
  return new Response('{}', { status: 404 }); };

let r = await api('/api/online/status');
t('antes: Leomar vem do Cloudflare', r.j.integracoes.find((i) => i.id === 'ssw-expresso-leomar').origem === 'Cloudflare');
r = await api('/api/online/credenciais', 'POST', { tipo: 'ssw', dados: { transportadora: 'Expresso Leomar', dominio: 'leo', login: 'prolopas', senha: 'prolopas', cnpjPagador: '12.995.553/0001-00' } });
const ssw = r.j.find((x) => x.tipo === 'ssw');
t('salva e devolve sem a senha', r.status === 200 && ssw.entradas[0].senha === '••••••' && ssw.entradas[0].cnpjPagador === '12995553000100' && ssw.noCloudflare);
t('gravado criptografado no banco', !/prolopas/.test(psql(`SELECT dados FROM integracoes_credenciais WHERE tipo='ssw';`)));
r = await api('/api/online/status');
t('agora a Leomar vem da tela (substitui a do Cloudflare)', r.j.integracoes.filter((i) => i.tipo === 'ssw').length === 1 && r.j.integracoes.find((i) => i.id === 'ssw-expresso-leomar').origem === 'tela');
chamadas.length = 0;
r = await api('/api/online/testar', 'POST', { id: 'ssw-expresso-leomar' });
const soap = chamadas.find((c) => c.url.endsWith('sswCotacao/index.php'));
t('teste usa as credenciais da tela', r.j.ok && r.j.total === 150 && /<login>prolopas<\/login>/.test(soap.o.body) && /<senha>prolopas<\/senha>/.test(soap.o.body));
r = await api('/api/online/credenciais', 'POST', { tipo: 'ssw', original: 'Expresso Leomar', dados: { transportadora: 'Expresso Leomar', dominio: 'LEO', login: 'prolopas', senha: '' } });
chamadas.length = 0; await api('/api/online/testar', 'POST', { id: 'ssw-expresso-leomar' });
t('senha em branco mantém a gravada', /<senha>prolopas<\/senha>/.test(chamadas.find((c) => c.url.endsWith('sswCotacao/index.php')).o.body));
t('campo obrigatório', (await api('/api/online/credenciais', 'POST', { tipo: 'ssw', dados: { transportadora: 'Outra', dominio: 'X' } })).status === 400);
t('nome repetido', (await api('/api/online/credenciais', 'POST', { tipo: 'ssw', dados: { transportadora: 'expresso leomar', dominio: 'X', login: 'a', senha: 'b' } })).status === 400);
r = await api('/api/online/credenciais', 'POST', { tipo: 'braspress', dados: { cnpj: '12.995.553/0001-00', usuario: 'U', senha: 'S' } });
r = await api('/api/online/status');
t('Braspress cadastrada pela tela', r.j.integracoes.find((i) => i.id === 'braspress').origem === 'tela');
t('comercial não vê credenciais', (await (async () => { psql(`INSERT INTO usuarios (email, perfil_id) SELECT 'v@x', id FROM perfis WHERE nome='Comercial';`);
  const x = await worker.fetch(new Request('https://x.dev/api/online/credenciais', { headers: { 'cf-access-authenticated-user-email': 'v@x' } }), env, { waitUntil() {} }); return x.status; })()) === 403);
r = await api('/api/online/credenciais', 'GET', null, { ...env, BLING_CLIENT_SECRET: 'outro' });
t('chave trocada: avisa para cadastrar de novo', r.j.find((x) => x.tipo === 'ssw').erro && /chave mudou/.test(r.j.find((x) => x.tipo === 'ssw').erro));
r = await api('/api/online/credenciais?tipo=ssw&chave=Expresso%20Leomar', 'DELETE');
r = await api('/api/online/status');
t('excluída da tela: volta a do Cloudflare', r.j.integracoes.find((i) => i.id === 'ssw-expresso-leomar').origem === 'Cloudflare');
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
