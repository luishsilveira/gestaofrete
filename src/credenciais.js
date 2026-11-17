// Credenciais das integrações cadastradas pela tela Integrações (sem variáveis no Cloudflare).
// Ficam no banco criptografadas com AES-GCM. A chave é derivada (HKDF) de um segredo que já existe no
// Cloudflare: CHAVE_CRIPTOGRAFIA, se for criado; senão BLING_CLIENT_SECRET. Se esse segredo mudar, as
// credenciais gravadas deixam de abrir e precisam ser cadastradas de novo (a tela avisa).
//
// Formato guardado por conector (o mesmo dos secrets antigos):
//   ssw:       [{ transportadora, dominio, login, senha, cnpjPagador, tabela?, senhaPagador? }]
//   braspress: [{ cnpj, usuario, senha }]

export const SCHEMA_CREDENCIAIS = `
CREATE TABLE IF NOT EXISTS integracoes_credenciais (
  tipo           TEXT PRIMARY KEY,
  dados          TEXT NOT NULL,            -- JSON criptografado (base64 de iv + conteúdo)
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por TEXT
);
`;

// Campos do formulário de cada conector. "chave" identifica a entrada; "secreto" nunca volta para a tela.
export const CAMPOS = {
  ssw: {
    nome: 'Transportadora do sistema SSW',
    chave: 'transportadora',
    campos: [
      { k: 'transportadora', rotulo: 'Nome da transportadora', obrig: true, ex: 'Expresso Leomar' },
      { k: 'dominio', rotulo: 'Domínio no SSW', obrig: true, ex: 'LEO' },
      { k: 'login', rotulo: 'Usuário', obrig: true },
      { k: 'senha', rotulo: 'Senha', obrig: true, secreto: true },
      { k: 'cnpjPagador', rotulo: 'CNPJ pagador (Proloplast)', ex: '12995553000100' },
      { k: 'tabela', rotulo: 'Comparar com a tabela', tipo: 'tabela' },
    ],
  },
  braspress: {
    nome: 'Braspress (conta por CNPJ)',
    chave: 'cnpj',
    campos: [
      { k: 'cnpj', rotulo: 'CNPJ da Proloplast', obrig: true },
      { k: 'usuario', rotulo: 'Usuário da API', obrig: true, ex: '12995553000100_PRD' },
      { k: 'senha', rotulo: 'Senha da API', obrig: true, secreto: true },
    ],
  },
};

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const deb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function chave(env) {
  const base = env.CHAVE_CRIPTOGRAFIA || env.BLING_CLIENT_SECRET;
  if (!base) throw Object.assign(new Error('Sem chave para proteger as credenciais: crie o secret CHAVE_CRIPTOGRAFIA no Cloudflare (uma vez só).'), { status: 400 });
  const k = await crypto.subtle.importKey('raw', enc.encode(base), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('gestaofrete'), info: enc.encode('credenciais-integracoes') },
    k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function cifrar(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await chave(env), enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + c.length); out.set(iv); out.set(c, iv.length);
  return b64(out);
}
export async function decifrar(env, texto) {
  const u = deb64(texto);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, await chave(env), u.slice(12))));
}

// Credenciais gravadas: { tipo: { lista, erro } }
export async function lerCredenciais(env, db) {
  const out = {};
  const rows = (await db.query('SELECT tipo, dados, atualizado_em, atualizado_por FROM integracoes_credenciais')).rows;
  for (const r of rows) {
    try { out[r.tipo] = { lista: await decifrar(env, r.dados), atualizado_em: r.atualizado_em, atualizado_por: r.atualizado_por }; }
    catch { out[r.tipo] = { lista: [], erro: 'As credenciais gravadas não puderam ser abertas (a chave mudou). Cadastre de novo.' }; }
  }
  return out;
}

const so = (s) => String(s ?? '').replace(/\D/g, '');
const igual = (tipo, a, b) => String(a[CAMPOS[tipo].chave] || '').trim().toLowerCase() === String(b[CAMPOS[tipo].chave] || '').trim().toLowerCase();

// Inclui ou altera uma entrada. "original" é o valor da chave antes da edição; senha em branco mantém a gravada.
export async function salvarCredencial(env, db, tipo, d, original, usuario) {
  const def = CAMPOS[tipo];
  if (!def) throw Object.assign(new Error('Tipo de integração desconhecido.'), { status: 400 });
  const atual = (await lerCredenciais(env, db))[tipo];
  const lista = atual && !atual.erro ? atual.lista : [];
  const ant = original != null && original !== '' ? lista.find((x) => igual(tipo, x, { [def.chave]: original })) : null;
  const novo = {};
  for (const c of def.campos) {
    let v = d[c.k] == null ? '' : String(d[c.k]).trim();
    if (c.secreto && !v && ant) v = ant[c.k] || '';
    if (['cnpj', 'cnpjPagador'].includes(c.k)) v = so(v);
    if (c.obrig && !v) throw Object.assign(new Error(`Preencha: ${c.rotulo}.`), { status: 400 });
    if (v) novo[c.k] = v;
  }
  if (tipo === 'braspress' && novo.cnpj.length !== 14) throw Object.assign(new Error('CNPJ inválido.'), { status: 400 });
  if (lista.some((x) => x !== ant && igual(tipo, x, novo))) throw Object.assign(new Error('Já existe um cadastro com esse ' + (tipo === 'ssw' ? 'nome de transportadora.' : 'CNPJ.')), { status: 400 });
  const nova = ant ? lista.map((x) => (x === ant ? { ...ant, ...novo } : x)) : [...lista, novo];
  await gravar(env, db, tipo, nova, usuario);
}

export async function excluirCredencial(env, db, tipo, chaveValor, usuario) {
  const atual = (await lerCredenciais(env, db))[tipo];
  if (!atual) return;
  await gravar(env, db, tipo, atual.lista.filter((x) => !igual(tipo, x, { [CAMPOS[tipo].chave]: chaveValor })), usuario);
}

async function gravar(env, db, tipo, lista, usuario) {
  if (!lista.length) { await db.query('DELETE FROM integracoes_credenciais WHERE tipo = $1', [tipo]); return; }
  await db.query(`INSERT INTO integracoes_credenciais (tipo, dados, atualizado_por) VALUES ($1, $2, $3)
                  ON CONFLICT (tipo) DO UPDATE SET dados = $2, atualizado_em = now(), atualizado_por = $3`, [tipo, await cifrar(env, lista), usuario]);
}

// Lista para a tela, sem senhas (só indica se estão preenchidas).
export async function listarCredenciais(env, db) {
  const cred = await lerCredenciais(env, db);
  const secretos = { ssw: env.SSW_TRANSPORTADORAS, braspress: env.BRASPRESS_CONTAS };
  return Object.entries(CAMPOS).map(([tipo, def]) => ({
    tipo, nome: def.nome, chave: def.chave, campos: def.campos.map(({ k, rotulo, obrig, secreto, ex, tipo: t }) => ({ k, rotulo, obrig: !!obrig, secreto: !!secreto, ex: ex || null, tipo: t || null })),
    noCloudflare: !!secretos[tipo], erro: cred[tipo] && cred[tipo].erro || null,
    atualizado_em: cred[tipo] && cred[tipo].atualizado_em || null, atualizado_por: cred[tipo] && cred[tipo].atualizado_por || null,
    entradas: ((cred[tipo] && cred[tipo].lista) || []).map((x) => Object.fromEntries(def.campos.map((c) => [c.k, c.secreto ? (x[c.k] ? '••••••' : '') : (x[c.k] || '')]))),
  }));
}
