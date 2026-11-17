// Testes: cria o esquema (primeira chamada à API) e cadastra usuários de teste como administradores.
import { psql } from './pgpsql.mjs';
export async function cadastrarAdmins(api, ...emails) {
  await api('/api/eu'); // cria o esquema e os perfis iniciais (responde 403 para quem não está cadastrado)
  for (const e of emails) psql(`INSERT INTO usuarios (email, perfil_id) SELECT '${e.toLowerCase()}', id FROM perfis WHERE sistema ON CONFLICT DO NOTHING;`);
}
