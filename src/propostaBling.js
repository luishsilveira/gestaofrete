// Cotação de frete → proposta comercial no Bling (única gravação que a aplicação faz no Bling).
//
// Só propostas comerciais; pedidos de venda e notas fiscais continuam só de leitura.
// O envio é sempre feito por um usuário (botão), com prévia antes de gravar, e fica registrado em `bling_envios`.
// Campos alterados na proposta:
//   - observacaoInterna: bloco "Frete cotado" com transportadora, nº da cotação online, valor de custo e prazo
//     (o texto que já existir no campo é mantido; só o bloco anterior é trocado);
//   - transporte.frete: valor da transportadora + acréscimo % do cadastro de transportadoras;
//   - transportador: contato do Bling informado no cadastro de transportadoras (quando houver).
// A API do Bling (PUT) exige a proposta inteira: lemos a atual, trocamos só esses campos e devolvemos o resto.
// Depois do envio, a proposta é lida de novo para conferir o que o Bling gravou de fato.
import { BLING, BlingErro, blingGet, tokenValido } from './bling.js';

export const SCHEMA_PROPOSTA = `
CREATE TABLE IF NOT EXISTS transportadoras_cadastro (
  nome               TEXT PRIMARY KEY,
  acrescimo_pct      NUMERIC(7,3) NOT NULL DEFAULT 0,
  bling_contato_id   BIGINT,
  bling_contato_nome TEXT,
  atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por     TEXT
);
CREATE TABLE IF NOT EXISTS bling_envios (
  id               BIGSERIAL PRIMARY KEY,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario          TEXT NOT NULL,
  cotacao_id       BIGINT,
  proposta_id      BIGINT,
  proposta_numero  TEXT,
  transportadora   TEXT,
  valor_custo      NUMERIC(14,2),
  acrescimo_pct    NUMERIC(7,3),
  valor_enviado    NUMERIC(14,2),
  transportador_id BIGINT,
  observacao       TEXT,
  ok               BOOLEAN NOT NULL,
  erro             TEXT,
  conferencia      JSONB
);
CREATE INDEX IF NOT EXISTS bling_envios_cotacao_idx ON bling_envios (cotacao_id, criado_em DESC);
`;

const INICIO = '--- Frete cotado (Gestão de Frete) ---';
const FIM = '--- fim do frete cotado ---';
const MODO_PADRAO = { modo: 'teste', numero_teste: '159504' };
const r2 = (v) => Math.round((+v + Number.EPSILON) * 100) / 100;
const brl = (v) => 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------------------------------------------------------------- configuração (modo do envio)
async function lerConfig(db, chave, padrao) {
  const r = await db.query('SELECT valor FROM app_config WHERE chave = $1', [chave]);
  return r.rows.length ? r.rows[0].valor : padrao;
}
export async function configEnvio(db) {
  return { ...MODO_PADRAO, ...((await lerConfig(db, 'envio_proposta', null)) || {}) };
}
export async function salvarConfigEnvio(db, c, usuario) {
  const modo = ['desligado', 'teste', 'ligado'].includes(c.modo) ? c.modo : 'teste';
  const numero_teste = String(c.numero_teste || '').replace(/\D/g, '') || MODO_PADRAO.numero_teste;
  await db.query(`INSERT INTO app_config (chave, valor, atualizado_por) VALUES ('envio_proposta', $1, $2)
                  ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = now(), atualizado_por = $2`,
  [JSON.stringify({ modo, numero_teste }), usuario]);
  return configEnvio(db);
}

// ---------------------------------------------------------------- cadastro de transportadoras
export async function listarCadastro(db) {
  return (await db.query('SELECT * FROM transportadoras_cadastro ORDER BY nome')).rows;
}
export async function salvarCadastro(db, lista, usuario) {
  if (!Array.isArray(lista)) throw erro('Lista de transportadoras inválida.');
  for (const t of lista.slice(0, 100)) {
    const nome = String(t.nome || '').trim().slice(0, 120);
    if (!nome) continue;
    const pct = t.acrescimo_pct === '' || t.acrescimo_pct == null ? 0 : +String(t.acrescimo_pct).replace(',', '.');
    if (!(pct >= 0 && pct <= 500)) throw erro(`Acréscimo inválido para ${nome}: informe um percentual entre 0 e 500.`);
    const cid = String(t.bling_contato_id ?? '').replace(/\D/g, '');
    await db.query(
      `INSERT INTO transportadoras_cadastro (nome, acrescimo_pct, bling_contato_id, bling_contato_nome, atualizado_por)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (nome) DO UPDATE SET acrescimo_pct = $2, bling_contato_id = $3, bling_contato_nome = $4,
         atualizado_em = now(), atualizado_por = $5`,
      [nome, pct, cid ? +cid : null, cid ? String(t.bling_contato_nome || '').slice(0, 160) || null : null, usuario]);
  }
  return listarCadastro(db);
}
// Contatos do Bling para associar à transportadora (busca pelo nome, CNPJ ou código).
export async function buscarContatosBling(env, db, termo, fetchImpl = fetch) {
  const t = String(termo || '').trim();
  if (t.length < 2) throw erro('Digite ao menos 2 letras do nome ou o CNPJ da transportadora.');
  const token = await tokenValido(env, db, fetchImpl);
  if (/^\d+$/.test(t) && t.length < 14) { // código do contato
    const j = await blingGet(token, `/contatos/${t}`, fetchImpl);
    return j && j.data ? [contatoResumo(j.data)] : [];
  }
  const j = await blingGet(token, `/contatos?pagina=1&limite=30&pesquisa=${encodeURIComponent(t)}`, fetchImpl);
  return ((j && j.data) || []).map(contatoResumo);
}
const contatoResumo = (c) => ({ id: c.id, nome: c.nome || c.fantasia || '', documento: c.numeroDocumento || null, situacao: c.situacao || null });

// ---------------------------------------------------------------- montagem do envio
const fmtPrazo = (p) => {
  if (p == null || p === '') return null;
  const n = parseInt(p, 10);
  return String(n) === String(p).trim() ? (n === 1 ? '1 dia útil' : `${n} dias úteis`) : String(p);
};
// Texto do bloco na observação interna (custo real, sem o acréscimo).
export function blocoObservacao({ transportadora, valor, prazo, cotacaoOnline }) {
  return [INICIO,
    `Transportadora: ${transportadora}`,
    ...(cotacaoOnline ? [`Nº da cotação (online): ${cotacaoOnline}`] : []),
    `Valor do frete (custo): ${brl(valor)}`,
    `Prazo de entrega: ${fmtPrazo(prazo) || 'não informado'}`,
    FIM].join('\n');
}
// Mantém o texto atual do campo e troca só o bloco anterior (se houver).
export function juntarObservacao(atual, bloco) {
  const txt = String(atual || '');
  const i = txt.indexOf(INICIO), f = i >= 0 ? txt.indexOf(FIM, i) : -1;
  if (i >= 0 && f >= 0) return (txt.slice(0, i) + bloco + txt.slice(f + FIM.length)).trim();
  return txt.trim() ? txt.trimEnd() + '\n\n' + bloco : bloco;
}
// Onde está o transportador no JSON da proposta (o Bling usa "contato" dentro de "transporte").
const chaveTransportador = (tr) => (tr && 'transportador' in tr && !('contato' in tr) ? 'transportador' : 'contato');
const idTransportador = (tr) => {
  if (!tr) return null;
  const x = tr[chaveTransportador(tr)];
  return x && typeof x === 'object' ? (x.id ? +x.id : null) : (x ? +x || null : null);
};

async function dadosDaCotacao(db, cotacaoId) {
  const r = await db.query(`SELECT c.*, p.numero AS proposta_numero FROM cotacoes c
                              LEFT JOIN propostas_bling p ON p.id = c.bling_proposta_id WHERE c.id = $1`, [cotacaoId]);
  const c = r.rows[0];
  if (!c) throw erro('Cotação não encontrada.', 404);
  if (!c.bling_proposta_id) throw erro('Esta cotação não está vinculada a uma proposta comercial do Bling. O envio só existe para propostas.');
  const transportadora = c.transportadora_escolhida || c.melhor_transportadora;
  const valor = +(c.valor_escolhido ?? c.melhor_valor);
  if (!transportadora || !(valor > 0)) throw erro('A cotação não tem transportadora e valor escolhidos.');
  const res = (Array.isArray(c.resultados) ? c.resultados : []).find((x) => x.transportadora === transportadora) || {};
  const cad = (await db.query('SELECT * FROM transportadoras_cadastro WHERE nome = $1', [transportadora])).rows[0] || null;
  return {
    c, transportadora, valor: r2(valor), prazo: res.prazo || (transportadora === c.melhor_transportadora ? c.melhor_prazo : null),
    cotacaoOnline: res.fonte_valor === 'online' && res.cotacao_online ? String(res.cotacao_online) : null, cad,
  };
}

// Monta a proposta alterada a partir da atual (devolve também o "antes" e o "depois" para a prévia).
export function montarProposta(atual, d) {
  const pct = d.cad ? +d.cad.acrescimo_pct || 0 : 0;
  const valorEnviado = r2(d.valor * (1 + pct / 100));
  const bloco = blocoObservacao(d);
  const novo = structuredClone(atual);
  novo.observacaoInterna = juntarObservacao(atual.observacaoInterna, bloco);
  novo.transporte = { ...(atual.transporte || {}) };
  novo.transporte.frete = valorEnviado;
  const tid = d.cad && d.cad.bling_contato_id ? +d.cad.bling_contato_id : null;
  if (tid) novo.transporte[chaveTransportador(atual.transporte)] = { id: tid };
  const tr0 = atual.transporte || {};
  return {
    corpo: novo, valorEnviado, pct, transportadorId: tid, bloco,
    antes: { observacaoInterna: atual.observacaoInterna || '', frete: tr0.frete ?? null, transportadorId: idTransportador(tr0), total: atual.total ?? null },
    depois: { observacaoInterna: novo.observacaoInterna, frete: valorEnviado, transportadorId: tid ?? idTransportador(tr0) },
  };
}

// PUT no Bling, com a mensagem de erro detalhada (campos recusados).
export async function blingPut(token, caminho, corpo, fetchImpl = fetch) {
  const r = await fetchImpl(BLING.apiBase + caminho, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 204 sem corpo */ }
  if (r.ok) return j;
  if (r.status === 401) throw new BlingErro('O Bling recusou o acesso. Conecte de novo ao Bling.', 409, 'desconectado');
  if (r.status === 403) throw new BlingErro('O aplicativo do Bling não tem permissão para alterar propostas comerciais. Libere a edição de Propostas Comerciais no aplicativo do Bling e clique em "Reconectar ao Bling".', 403, 'permissao');
  const e = (j && j.error) || {};
  const campos = (Array.isArray(e.fields) ? e.fields : []).map((f) => [f.element, f.msg].filter(Boolean).join(': ')).filter(Boolean);
  throw new BlingErro(`O Bling recusou a alteração da proposta${e.description || e.message ? ': ' + (e.description || e.message) : ''}${campos.length ? ' — ' + campos.join('; ') : ''} (HTTP ${r.status}).`, 400, 'recusado');
}

async function lerPropostaBling(token, id, fetchImpl) {
  const j = await blingGet(token, `/propostas-comerciais/${id}`, fetchImpl);
  if (!j || !j.data) throw erro('Proposta não encontrada no Bling (pode ter sido excluída).', 404);
  return j.data;
}

function conferirModo(cfg, numero) {
  if (cfg.modo === 'desligado') throw erro('O envio de cotações para o Bling está desligado (Configurações → Envio para o Bling).', 409);
  if (cfg.modo === 'teste' && String(numero) !== String(cfg.numero_teste))
    throw erro(`O envio para o Bling está em modo de teste: só a proposta nº ${cfg.numero_teste} pode ser alterada. Depois do teste, o administrador libera em Configurações → Envio para o Bling.`, 409);
}

// Prévia: o que vai mudar na proposta (não grava nada).
export async function previaEnvio(env, db, cotacaoId, fetchImpl = fetch) {
  const d = await dadosDaCotacao(db, cotacaoId);
  const token = await tokenValido(env, db, fetchImpl);
  const atual = await lerPropostaBling(token, d.c.bling_proposta_id, fetchImpl);
  const m = montarProposta(atual, d);
  const cfg = await configEnvio(db);
  let bloqueio = null;
  try { conferirModo(cfg, atual.numero ?? d.c.proposta_numero); } catch (e) { bloqueio = e.message; }
  const avisos = [];
  if (!d.cad) avisos.push(`"${d.transportadora}" não está no cadastro de transportadoras: frete sem acréscimo e transportador não alterado.`);
  else if (!d.cad.bling_contato_id) avisos.push(`"${d.transportadora}" não tem o código do transportador no Bling: o transportador da proposta não será alterado.`);
  return {
    proposta: { id: d.c.bling_proposta_id, numero: String(atual.numero ?? d.c.proposta_numero ?? ''), cliente: (atual.contato && atual.contato.nome) || null },
    transportadora: d.transportadora, valor_custo: d.valor, acrescimo_pct: m.pct, valor_enviado: m.valorEnviado,
    transportador: d.cad && d.cad.bling_contato_id ? { id: +d.cad.bling_contato_id, nome: d.cad.bling_contato_nome } : null,
    antes: m.antes, depois: m.depois, bloco: m.bloco, avisos, bloqueio, modo: cfg,
    envios: (await db.query('SELECT id, criado_em, usuario, ok, valor_enviado, erro FROM bling_envios WHERE cotacao_id = $1 ORDER BY criado_em DESC LIMIT 5', [cotacaoId])).rows,
  };
}

// Envio: grava na proposta, lê de novo e confere campo a campo. Tudo fica em bling_envios (inclusive falhas).
export async function enviarProposta(env, db, cotacaoId, usuario, fetchImpl = fetch) {
  const d = await dadosDaCotacao(db, cotacaoId);
  const token = await tokenValido(env, db, fetchImpl);
  const atual = await lerPropostaBling(token, d.c.bling_proposta_id, fetchImpl);
  const numero = String(atual.numero ?? d.c.proposta_numero ?? '');
  conferirModo(await configEnvio(db), numero);
  const m = montarProposta(atual, d);
  const reg = (ok, erroMsg, conferencia) => db.query(
    `INSERT INTO bling_envios (usuario, cotacao_id, proposta_id, proposta_numero, transportadora, valor_custo, acrescimo_pct,
       valor_enviado, transportador_id, observacao, ok, erro, conferencia)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, criado_em`,
    [usuario, cotacaoId, d.c.bling_proposta_id, numero, d.transportadora, d.valor, m.pct, m.valorEnviado, m.transportadorId,
      m.bloco, ok, erroMsg, conferencia ? JSON.stringify(conferencia) : null]);
  try {
    await blingPut(token, `/propostas-comerciais/${d.c.bling_proposta_id}`, m.corpo, fetchImpl);
  } catch (e) {
    await reg(false, e.message, null);
    throw e;
  }
  // conferência: o que o Bling gravou de fato
  const depois = await lerPropostaBling(token, d.c.bling_proposta_id, fetchImpl);
  const tr = depois.transporte || {};
  const conferencia = {
    observacao: String(depois.observacaoInterna || '').includes(m.bloco),
    frete: Math.abs((+tr.frete || 0) - m.valorEnviado) < 0.005,
    transportador: m.transportadorId ? idTransportador(tr) === m.transportadorId : null,
    itens: Array.isArray(atual.itens) && Array.isArray(depois.itens) ? atual.itens.length === depois.itens.length : null,
    total_antes: atual.total ?? null, total_depois: depois.total ?? null,
  };
  const ok = conferencia.observacao && conferencia.frete && conferencia.transportador !== false && conferencia.itens !== false;
  const r = await reg(ok, ok ? null : 'O Bling aceitou, mas nem todos os campos ficaram como enviados (ver conferência).', conferencia);
  try { await db.query('UPDATE propostas_bling SET frete = $2 WHERE id = $1', [d.c.bling_proposta_id, +tr.frete || null]); } catch { /* lista local se atualiza na próxima importação */ }
  return { ok, envio: r.rows[0], proposta: { id: d.c.bling_proposta_id, numero }, valor_enviado: m.valorEnviado, conferencia };
}
