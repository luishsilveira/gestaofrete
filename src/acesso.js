// Usuários e perfis de acesso, administrados dentro da aplicação.
//
// O Cloudflare Access só confirma que a pessoa é dona do e-mail (código por e-mail). Quem entra e o que
// cada um vê é decidido aqui: o usuário precisa estar cadastrado e ativo, e o perfil dele diz quais
// menus e ações estão liberados. Perfis são criados, alterados e excluídos pelo administrador.

// Catálogo de permissões (a chave é o que fica gravado no perfil).
export const PERMISSOES = [
  { chave: 'menu.calc', ajuda: 'Calculadora de frete e busca de pedido, proposta ou NF', grupo: 'Menus', nome: 'Calcular frete' },
  { chave: 'menu.bling', ajuda: 'Listas de pedidos, propostas, notas e produtos importados', grupo: 'Menus', nome: 'Bling: pedidos, propostas, notas fiscais e produtos' },
  { chave: 'menu.mkt', ajuda: 'Quanto a empresa recebe por produto no Mercado Livre e outros', grupo: 'Menus', nome: 'Resultado no marketplace' },
  { chave: 'menu.hist', ajuda: 'Cotações salvas e o detalhe de cada uma', grupo: 'Menus', nome: 'Histórico de cotações' },
  { chave: 'menu.div', ajuda: 'Comparação entre valor calculado, valor manual e cotação online', grupo: 'Menus', nome: 'Divergências' },
  { chave: 'menu.tab', ajuda: 'Consulta das tabelas de frete carregadas', grupo: 'Menus', nome: 'Tabelas de frete' },
  { chave: 'menu.integ', ajuda: 'Situação das APIs das transportadoras', grupo: 'Menus', nome: 'Integrações (APIs)' },
  { chave: 'menu.cfg', ajuda: 'CNPJ e CEP de origem das cotações online', grupo: 'Menus', nome: 'Empresa remetente' },
  { chave: 'menu.json', ajuda: 'Estrutura técnica dos dados', grupo: 'Menus', nome: 'Modelo de dados' },
  { chave: 'acao.salvar_cotacao', ajuda: 'Gravar a cotação no histórico', grupo: 'Ações', nome: 'Salvar cotações' },
  { chave: 'acao.valor_manual', ajuda: 'Informar o valor cotado direto com a transportadora', grupo: 'Ações', nome: 'Registrar e remover valores manuais' },
  { chave: 'acao.bling_sincronizar', ajuda: 'Importar agora e refazer a conexão com o Bling', grupo: 'Ações', nome: 'Sincronizar e reconectar o Bling' },
  { chave: 'acao.bling_proposta', ajuda: 'Gravar transportadora, frete e observação interna na proposta comercial do Bling', grupo: 'Ações', nome: 'Enviar cotação para a proposta no Bling' },
  { chave: 'acao.integracoes', ajuda: 'Usar cotação online e testar conexão', grupo: 'Ações', nome: 'Ligar, desligar e testar integrações' },
  { chave: 'acao.configuracoes', ajuda: 'Salvar empresa remetente, itens com valor fixo, cadastro de transportadoras e envio para o Bling', grupo: 'Ações', nome: 'Alterar configurações (remetente, valores fixos, transportadoras, envio ao Bling)' },
  { chave: 'admin.usuarios', ajuda: 'Tela Usuários e perfis (incluir, bloquear, alterar acessos)', grupo: 'Administração', nome: 'Cadastrar usuários e perfis de acesso' },
];
const CHAVES = new Set(PERMISSOES.map((p) => p.chave));
const TODAS = PERMISSOES.map((p) => p.chave);

export const SCHEMA_ACESSO = `
CREATE TABLE IF NOT EXISTS perfis (
  id             SERIAL PRIMARY KEY,
  nome           TEXT NOT NULL UNIQUE,
  descricao      TEXT,
  permissoes     TEXT[] NOT NULL DEFAULT '{}',
  sistema        BOOLEAN NOT NULL DEFAULT false,   -- perfil Administrador: sempre com todas as permissões, não pode ser excluído
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por TEXT
);
CREATE TABLE IF NOT EXISTS usuarios (
  email          TEXT PRIMARY KEY,                  -- sempre em minúsculas
  nome           TEXT,
  perfil_id      INTEGER NOT NULL REFERENCES perfis(id),
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por     TEXT,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por TEXT,
  ultimo_acesso  TIMESTAMPTZ
);
`;

// Primeira carga: perfis Administrador e Comercial e os usuários que já usavam a aplicação.
const ADMINS_INICIAIS = ['luish.silveira@gmail.com', 'proloplasticos@gmail.com'];
const COMERCIAIS_INICIAIS = ['vendasproloplast@gmail.com'];
export async function prepararAcesso(db) {
  await db.query(`INSERT INTO perfis (nome, descricao, permissoes, sistema, atualizado_por)
                  SELECT 'Administrador', 'Acesso total, inclusive usuários e perfis', $1::text[], true, 'sistema'
                   WHERE NOT EXISTS (SELECT 1 FROM perfis WHERE sistema)`, [TODAS]);
  // o perfil Administrador sempre tem o catálogo inteiro (inclusive permissões criadas depois)
  await db.query(`UPDATE perfis SET permissoes = $1::text[] WHERE sistema AND permissoes <> $1::text[]`, [TODAS]);
  const vazio = (await db.query('SELECT NOT EXISTS (SELECT 1 FROM usuarios) AS v')).rows[0].v;
  if (!vazio) return;
  const com = await db.query(`INSERT INTO perfis (nome, descricao, permissoes, atualizado_por)
      VALUES ('Comercial', 'Cotação, Bling, histórico e divergências', $1::text[], 'sistema')
      ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
    [['menu.calc', 'menu.bling', 'menu.hist', 'menu.div', 'menu.tab', 'acao.salvar_cotacao', 'acao.valor_manual']]);
  const adm = (await db.query('SELECT id FROM perfis WHERE sistema LIMIT 1')).rows[0].id;
  for (const e of ADMINS_INICIAIS) await db.query(`INSERT INTO usuarios (email, perfil_id, criado_por) VALUES ($1,$2,'sistema') ON CONFLICT DO NOTHING`, [e, adm]);
  for (const e of COMERCIAIS_INICIAIS) await db.query(`INSERT INTO usuarios (email, perfil_id, criado_por) VALUES ($1,$2,'sistema') ON CONFLICT DO NOTHING`, [e, com.rows[0].id]);
}

export class AcessoErro extends Error {
  constructor(msg, status = 403, codigo = 'sem_permissao') { super(msg); this.status = status; this.codigo = codigo; }
}

// Usuário da requisição: cadastrado, ativo e com as permissões do perfil.
export async function carregarUsuario(db, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) throw new AcessoErro('Usuário não identificado pelo login.', 401, 'nao_identificado');
  const r = (await db.query(
    `SELECT u.email, u.nome, u.ativo, u.ultimo_acesso, p.id AS perfil_id, p.nome AS perfil, p.permissoes, p.sistema
       FROM usuarios u JOIN perfis p ON p.id = u.perfil_id WHERE u.email = $1`, [e])).rows[0];
  if (!r) throw new AcessoErro(`O e-mail ${e} não está cadastrado na aplicação. Peça acesso ao administrador.`, 403, 'nao_cadastrado');
  if (!r.ativo) throw new AcessoErro(`O usuário ${e} está inativo. Fale com o administrador.`, 403, 'inativo');
  return { ...r, permissoes: r.sistema ? TODAS : (r.permissoes || []).filter((p) => CHAVES.has(p)) };
}

export function exigir(u, ...chaves) {
  const falta = chaves.find((c) => !u.permissoes.includes(c));
  if (falta) {
    const p = PERMISSOES.find((x) => x.chave === falta);
    throw new AcessoErro(`Seu perfil (${u.perfil}) não tem permissão para: ${p ? p.nome : falta}.`);
  }
}

// Permissão necessária para cada rota da API (a primeira regra que casar vale; null = basta estar cadastrado).
const REGRAS = [
  [/^\/api\/eu$/, null],
  [/^\/api\/motivos$/, null],
  [/^\/api\/admin\//, 'admin.usuarios'],
  [/^\/api\/cotacoes$/, { POST: 'acao.salvar_cotacao', GET: 'menu.hist' }],
  [/^\/api\/cotacoes\/\d+\/manual$/, 'acao.valor_manual'],
  [/^\/api\/manuais\/\d+$/, 'acao.valor_manual'],
  [/^\/api\/cotacoes\/\d+$/, 'menu.hist'],
  [/^\/api\/divergencias$/, 'menu.div'],
  [/^\/api\/bling\/(sincronizar|conectar|callback)$/, 'acao.bling_sincronizar'],
  [/^\/api\/bling\/status$/, null],
  [/^\/api\/bling\/envio-config$/, { GET: null, POST: 'acao.configuracoes' }],
  [/^\/api\/bling\/proposta\//, 'acao.bling_proposta'],
  [/^\/api\/transportadoras\/cadastro$/, { GET: 'menu.tab', POST: ['menu.tab', 'acao.configuracoes'] }],
  [/^\/api\/transportadoras\/contatos-bling$/, 'acao.configuracoes'],
  [/^\/api\/bling\/pedido$/, 'menu.calc'],
  [/^\/api\/bling\//, 'menu.bling'],
  [/^\/api\/online\/cotar$/, 'menu.calc'],
  [/^\/api\/online\/(ativar|testar|credenciais)$/, 'acao.integracoes'],
  [/^\/api\/online\/status$/, null],
  [/^\/api\/marketplace\/fixos$/, { GET: 'menu.mkt', POST: ['menu.mkt', 'acao.configuracoes'] }],
  [/^\/api\/marketplace/, 'menu.mkt'],
  [/^\/api\/config$/, { GET: 'menu.cfg', POST: ['menu.cfg', 'acao.configuracoes'] }],
];
export function permissaoDaRota(caminho, metodo) {
  for (const [re, p] of REGRAS) {
    if (!re.test(caminho)) continue;
    if (p && typeof p === 'object' && !Array.isArray(p)) return p[metodo] ?? p.GET ?? null;
    return p;
  }
  return 'admin.usuarios'; // rota não mapeada: só administrador
}

export async function registrarAcesso(db, email) {
  await db.query(`UPDATE usuarios SET ultimo_acesso = now() WHERE email = $1 AND (ultimo_acesso IS NULL OR ultimo_acesso < now() - interval '5 minutes')`, [email]);
}

// ---------------------------------------------------------------- administração
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const limpar = (lista) => [...new Set((Array.isArray(lista) ? lista : []).filter((p) => CHAVES.has(p)))];

// Administradores ativos (perfil com "Cadastrar usuários e perfis"), sem contar quem está sendo alterado.
async function outrosAdmins(db, { semEmail = null, semPerfil = null } = {}) {
  return +(await db.query(`SELECT count(*) AS n FROM usuarios u JOIN perfis p ON p.id = u.perfil_id
                             WHERE u.ativo AND (p.sistema OR 'admin.usuarios' = ANY(p.permissoes))
                               AND ($1::text IS NULL OR u.email <> $1) AND ($2::int IS NULL OR p.id <> $2)`, [semEmail, semPerfil])).rows[0].n;
}
const ULTIMO_ADMIN = () => new AcessoErro('É preciso manter pelo menos um usuário ativo com acesso a "Cadastrar usuários e perfis".', 400, 'ultimo_admin');
const perfilAdmin = async (db, id) => !!(await db.query(`SELECT 1 FROM perfis WHERE id = $1 AND (sistema OR 'admin.usuarios' = ANY(permissoes))`, [id])).rows.length;

export async function listarAcesso(db) {
  const usuarios = (await db.query(
    `SELECT u.email, u.nome, u.ativo, u.perfil_id, p.nome AS perfil, u.criado_em, u.criado_por, u.atualizado_em, u.atualizado_por, u.ultimo_acesso
       FROM usuarios u JOIN perfis p ON p.id = u.perfil_id ORDER BY u.ativo DESC, lower(COALESCE(u.nome, u.email))`)).rows;
  const perfis = (await db.query(
    `SELECT p.*, (SELECT count(*) FROM usuarios u WHERE u.perfil_id = p.id) AS usuarios FROM perfis p ORDER BY p.sistema DESC, lower(p.nome)`)).rows
    .map((p) => ({ ...p, permissoes: p.sistema ? TODAS : p.permissoes, usuarios: +p.usuarios }));
  return { usuarios, perfis, catalogo: PERMISSOES };
}

// Cria ou altera um usuário. Ao alterar, "email_original" identifica o cadastro (permite corrigir o e-mail).
export async function salvarUsuario(db, d, autor) {
  const email = String(d.email || '').trim().toLowerCase();
  if (!emailOk(email)) throw new AcessoErro('Informe um e-mail válido.', 400, 'dados');
  const perfil = (await db.query('SELECT id FROM perfis WHERE id = $1', [+d.perfil_id])).rows[0];
  if (!perfil) throw new AcessoErro('Escolha um perfil de acesso.', 400, 'dados');
  const original = String(d.email_original || '').trim().toLowerCase();
  const nome = String(d.nome || '').trim().slice(0, 120) || null;
  const ativo = d.ativo !== false;
  if (original) {
    const atual = (await db.query('SELECT perfil_id, ativo FROM usuarios WHERE email = $1', [original])).rows[0];
    if (!atual) throw new AcessoErro('Usuário não encontrado.', 404, 'dados');
    const eraAdmin = atual.ativo && await perfilAdmin(db, atual.perfil_id), seraAdmin = ativo && await perfilAdmin(db, perfil.id);
    if (eraAdmin && !seraAdmin && (await outrosAdmins(db, { semEmail: original })) < 1) throw ULTIMO_ADMIN();
    if (email !== original && (await db.query('SELECT 1 FROM usuarios WHERE email = $1', [email])).rows.length) throw new AcessoErro(`O e-mail ${email} já está cadastrado.`, 400, 'dados');
    await db.query(`UPDATE usuarios SET email = $1, nome = $2, perfil_id = $3, ativo = $4, atualizado_em = now(), atualizado_por = $5 WHERE email = $6`,
      [email, nome, perfil.id, ativo, autor, original]);
  } else {
    const r = await db.query(`INSERT INTO usuarios (email, nome, perfil_id, ativo, criado_por, atualizado_por) VALUES ($1,$2,$3,$4,$5,$5)
                               ON CONFLICT (email) DO NOTHING RETURNING email`, [email, nome, perfil.id, ativo, autor]);
    if (!r.rows.length) throw new AcessoErro(`O e-mail ${email} já está cadastrado.`, 400, 'dados');
  }
}

export async function excluirUsuario(db, email, autor) {
  const e = String(email || '').trim().toLowerCase();
  if (e === String(autor || '').toLowerCase()) throw new AcessoErro('Você não pode excluir o seu próprio usuário.', 400, 'dados');
  const atual = (await db.query('SELECT perfil_id, ativo FROM usuarios WHERE email = $1', [e])).rows[0];
  if (!atual) return;
  if (atual.ativo && await perfilAdmin(db, atual.perfil_id) && (await outrosAdmins(db, { semEmail: e })) < 1) throw ULTIMO_ADMIN();
  await db.query('DELETE FROM usuarios WHERE email = $1', [e]);
}

export async function salvarPerfil(db, d, autor) {
  const nome = String(d.nome || '').trim().slice(0, 60);
  if (!nome) throw new AcessoErro('Informe o nome do perfil.', 400, 'dados');
  const descricao = String(d.descricao || '').trim().slice(0, 200) || null;
  const permissoes = limpar(d.permissoes);
  let id = +d.id || null;
  if ((await db.query('SELECT 1 FROM perfis WHERE lower(nome) = lower($1) AND ($2::int IS NULL OR id <> $2)', [nome, id])).rows.length)
    throw new AcessoErro(`Já existe um perfil com o nome "${nome}".`, 400, 'dados');
  if (id) {
    const p = (await db.query('SELECT sistema FROM perfis WHERE id = $1', [id])).rows[0];
    if (!p) throw new AcessoErro('Perfil não encontrado.', 404, 'dados');
    if (!p.sistema && !permissoes.includes('admin.usuarios') && await perfilAdmin(db, id) && (await outrosAdmins(db, { semPerfil: id })) < 1) throw ULTIMO_ADMIN();
    await db.query(`UPDATE perfis SET nome = $2, descricao = $3, permissoes = CASE WHEN sistema THEN permissoes ELSE $4::text[] END,
                    atualizado_em = now(), atualizado_por = $5 WHERE id = $1`, [id, nome, descricao, permissoes, autor]);
  } else {
    id = (await db.query(`INSERT INTO perfis (nome, descricao, permissoes, atualizado_por) VALUES ($1,$2,$3::text[],$4) RETURNING id`,
      [nome, descricao, permissoes, autor])).rows[0].id;
  }
  return id;
}

export async function excluirPerfil(db, id) {
  const p = (await db.query(`SELECT sistema, (SELECT count(*) FROM usuarios WHERE perfil_id = $1) AS n FROM perfis WHERE id = $1`, [+id])).rows[0];
  if (!p) throw new AcessoErro('Perfil não encontrado.', 404, 'dados');
  if (p.sistema) throw new AcessoErro('O perfil Administrador não pode ser excluído.', 400, 'dados');
  if (+p.n > 0) throw new AcessoErro(`Há ${p.n} usuário(s) com este perfil. Troque o perfil deles antes de excluir.`, 400, 'dados');
  await db.query('DELETE FROM perfis WHERE id = $1', [+id]);
}

// ---------------------------------------------------------------- assinatura do Cloudflare Access
// Com ACCESS_AUD configurado, o token (cabeçalho Cf-Access-Jwt-Assertion) é conferido: assinatura RS256
// com as chaves públicas do time, audiência e validade. Sem ACCESS_AUD, vale o cabeçalho de e-mail.
const TIME_PADRAO = 'odd-salad-41a5.cloudflareaccess.com';
let chaves = { em: 0, lista: [] };
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function emailDaRequisicao(request, env, fetchImpl = fetch) {
  const cabecalho = request.headers.get('cf-access-authenticated-user-email');
  if (!env.ACCESS_AUD) return cabecalho;
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) throw new AcessoErro('Login do Cloudflare Access ausente.', 401, 'nao_identificado');
  const [h, p, s] = jwt.split('.');
  let cab, dados;
  try { cab = JSON.parse(new TextDecoder().decode(b64url(h))); dados = JSON.parse(new TextDecoder().decode(b64url(p))); }
  catch { throw new AcessoErro('Login inválido.', 401, 'nao_identificado'); }
  const time = env.ACCESS_TEAM || TIME_PADRAO;
  if (Date.now() - chaves.em > 3600e3 || !chaves.lista.some((k) => k.kid === cab.kid)) {
    const r = await fetchImpl(`https://${time}/cdn-cgi/access/certs`);
    chaves = { em: Date.now(), lista: (await r.json()).keys || [] };
  }
  const jwk = chaves.lista.find((k) => k.kid === cab.kid);
  if (!jwk) throw new AcessoErro('Login inválido (chave desconhecida).', 401, 'nao_identificado');
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  const aud = Array.isArray(dados.aud) ? dados.aud : [dados.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || (dados.exp && dados.exp * 1000 < Date.now()) || dados.iss !== `https://${time}`)
    throw new AcessoErro('Login inválido ou expirado. Recarregue a página.', 401, 'nao_identificado');
  return dados.email;
}
