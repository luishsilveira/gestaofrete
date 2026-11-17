// Usuários e perfis de acesso (PostgreSQL local).
import worker from '../src/index.js';
import { psql } from './pgpsql.mjs';
let ok = 0, fail = 0; const t = (n, c) => { c ? ok++ : fail++; console.log((c ? 'OK  ' : 'FALHA ') + n); };
const env = { HYPERDRIVE: { connectionString: 'x' }, ASSETS: { fetch: async () => new Response('') }, BLING_CLIENT_ID: 'c', BLING_CLIENT_SECRET: 's' };
const api = async (path, method = 'GET', body, email = 'luish.silveira@gmail.com') => {
  const r = await worker.fetch(new Request('https://x.dev' + path, { method, body: body && JSON.stringify(body), headers: email ? { 'cf-access-authenticated-user-email': email } : {} }), env, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
};
const espera = () => new Promise((r) => setTimeout(r, 31000)); // cache de 30 s por usuário

// carga inicial
let r = await api('/api/eu');
t('Luis é administrador na carga inicial', r.status === 200 && r.j.perfil === 'Administrador' && r.j.permissoes.includes('admin.usuarios'));
r = await api('/api/eu', 'GET', null, 'Proloplasticos@Gmail.com');
t('Proloplasticos administrador (e-mail sem diferenciar maiúsculas)', r.status === 200 && r.j.perfil === 'Administrador');
r = await api('/api/eu', 'GET', null, 'vendasproloplast@gmail.com');
t('vendas no perfil Comercial, sem marketplace e sem admin', r.j.perfil === 'Comercial' && r.j.permissoes.includes('menu.calc') && !r.j.permissoes.includes('menu.mkt') && !r.j.permissoes.includes('admin.usuarios'));
r = await api('/api/eu', 'GET', null, 'estranho@x.com');
t('não cadastrado: 403 nao_cadastrado', r.status === 403 && r.j.codigo === 'nao_cadastrado');
t('sem login: 401', (await api('/api/eu', 'GET', null, null)).status === 401);
t('comercial não acessa admin', (await api('/api/admin/acesso', 'GET', null, 'vendasproloplast@gmail.com')).status === 403);
t('comercial não sincroniza Bling', (await api('/api/bling/sincronizar', 'POST', null, 'vendasproloplast@gmail.com')).status === 403);

// perfis dinâmicos
r = await api('/api/admin/acesso');
t('lista de acesso', r.j.usuarios.length === 3 && r.j.perfis.length === 2 && r.j.catalogo.length > 10);
r = await api('/api/admin/perfis', 'POST', { nome: 'Logística', descricao: 'Só cotação', permissoes: ['menu.calc', 'acao.salvar_cotacao', 'inexistente'] });
const log = r.j.perfis.find((p) => p.nome === 'Logística');
t('cria perfil e ignora permissão inexistente', log && log.permissoes.join() === 'menu.calc,acao.salvar_cotacao');
t('nome repetido recusado', (await api('/api/admin/perfis', 'POST', { nome: 'logística', permissoes: [] })).status === 400);
r = await api('/api/admin/usuarios', 'POST', { email: ' Joao@Proloplast.com ', nome: 'João', perfil_id: log.id });
t('cadastra usuário', r.j.usuarios.some((u) => u.email === 'joao@proloplast.com' && u.perfil === 'Logística'));
t('e-mail repetido recusado', (await api('/api/admin/usuarios', 'POST', { email: 'joao@proloplast.com', perfil_id: log.id })).status === 400);
t('e-mail inválido recusado', (await api('/api/admin/usuarios', 'POST', { email: 'joao', perfil_id: log.id })).status === 400);
r = await api('/api/eu', 'GET', null, 'joao@proloplast.com');
t('João entra com o perfil Logística', r.status === 200 && r.j.permissoes.join() === 'menu.calc,acao.salvar_cotacao');
t('João não vê histórico', (await api('/api/cotacoes', 'GET', null, 'joao@proloplast.com')).status === 403);
t('João salva cotação', (await api('/api/cotacoes', 'POST', { resultados: [{ transportadora: 'X', total: 1 }] }, 'joao@proloplast.com')).status === 201);
t('perfil em uso não pode ser excluído', (await api(`/api/admin/perfis/${log.id}`, 'DELETE')).status === 400);
const adm = (await api('/api/admin/acesso')).j.perfis.find((p) => p.sistema);
t('Administrador não pode ser excluído', (await api(`/api/admin/perfis/${adm.id}`, 'DELETE')).status === 400);
r = await api('/api/admin/perfis', 'POST', { id: adm.id, nome: 'Administrador', permissoes: ['menu.calc'] });
t('Administrador mantém todas as permissões', r.j.perfis.find((p) => p.sistema).permissoes.length > 10);

// último administrador
psql(`UPDATE usuarios SET ativo = false WHERE email = 'proloplasticos@gmail.com';`);
r = await api('/api/admin/usuarios', 'POST', { email_original: 'luish.silveira@gmail.com', email: 'luish.silveira@gmail.com', perfil_id: log.id });
t('não deixa tirar o último administrador', r.status === 400 && r.j.codigo === 'ultimo_admin');
t('não deixa excluir a si mesmo', (await api('/api/admin/usuarios?email=luish.silveira@gmail.com', 'DELETE')).status === 400);
psql(`UPDATE usuarios SET ativo = true WHERE email = 'proloplasticos@gmail.com';`);

// inativar e trocar perfil (vale depois do cache de 30 s)
r = await api('/api/admin/usuarios', 'POST', { email_original: 'joao@proloplast.com', email: 'joao@proloplast.com', nome: 'João', perfil_id: log.id, ativo: false });
t('inativa usuário', r.j.usuarios.find((u) => u.email === 'joao@proloplast.com').ativo === false);
r = await api('/api/eu', 'GET', null, 'joao@proloplast.com');
t('inativo bloqueado (cache limpo ao alterar)', r.status === 403 && r.j.codigo === 'inativo');
r = await api('/api/admin/usuarios?email=joao@proloplast.com', 'DELETE');
t('exclui usuário e depois o perfil', r.status === 200 && (await api(`/api/admin/perfis/${log.id}`, 'DELETE')).status === 200);

// marketplace pelo perfil
r = await api('/api/admin/acesso');
const com = r.j.perfis.find((p) => p.nome === 'Comercial');
await api('/api/admin/perfis', 'POST', { id: com.id, nome: 'Comercial', permissoes: [...com.permissoes, 'menu.mkt'] });
t('libera marketplace para o Comercial', (await api('/api/eu', 'GET', null, 'vendasproloplast@gmail.com')).j.permissoes.includes('menu.mkt'));
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
