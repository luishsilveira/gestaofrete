// Conector Braspress: API própria (https://api.braspress.com, POST /v1/cotacao/calcular/json, Basic auth).
// Secret BRASPRESS_CONTAS: uma conta por CNPJ da empresa
//   [{"cnpj":"12995553000100","usuario":"12995553000100_PRD","senha":"..."}, ...]
// A conta usada é a do CNPJ remetente configurado; se não houver, a primeira.
import { so, arred, lerJSONSecret, DESTINATARIO_GENERICO, limparTexto } from './comum.js';

export const tipo = 'braspress';
export const URL = 'https://api.braspress.com/v1/cotacao/calcular/json';

export function contas(env) {
  return lerJSONSecret(env, 'BRASPRESS_CONTAS')
    .map((c) => ({ cnpj: so(c.cnpj), usuario: String(c.usuario || ''), senha: String(c.senha || '') }))
    .filter((c) => c.cnpj.length === 14 && c.usuario && c.senha);
}

export function integracoes(env) {
  const L = contas(env);
  return L.length ? [{ id: 'braspress', tipo, transportadora: 'Braspress', tabela: 'bp', conf: { contas: L }, cnpjs: L.map((c) => c.cnpj) }] : [];
}

export function montarRequisicao(conta, req, opcoes = {}) {
  return {
    cnpjRemetente: +conta.cnpj,
    cnpjDestinatario: +(req.cnpjDestinatario || DESTINATARIO_GENERICO),
    modal: opcoes.modal === 'A' ? 'A' : 'R',
    tipoFrete: ['1', '2', '3'].includes(String(opcoes.tipoFrete)) ? String(opcoes.tipoFrete) : '1',
    cepOrigem: +req.cepOrigem,
    cepDestino: +req.cepDestino,
    vlrMercadoria: arred(req.valorNF, 2),
    peso: arred(req.peso),
    volumes: req.volumes,
    cubagem: req.cubagem,
  };
}

export async function cotar(integ, req, fetchImpl = fetch) {
  const L = integ.conf.contas;
  const conta = L.find((c) => c.cnpj === req.cnpjRemetente) || L[0];
  const corpo = montarRequisicao(conta, req);
  const resp = await fetchImpl(URL, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${conta.usuario}:${conta.senha}`), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(corpo),
  });
  let j = null; try { j = await resp.json(); } catch { /* sem JSON */ }
  if (resp.status === 401 || resp.status === 403) throw new Error('A Braspress recusou o usuário e a senha deste CNPJ.');
  if (!resp.ok || !j || j.totalFrete == null) {
    const lista = j && Array.isArray(j.errorList) ? limparTexto(j.errorList.map((e) => e.message || e).join('; ')) : '';
    if (j && j.message) j.message = limparTexto(j.message);
    // 4xx com mensagem da Braspress = recusa dela (ex.: CEP não atendido); 5xx/sem JSON = falha técnica
    const respondeu = resp.status >= 400 && resp.status < 500 && !!(j && (j.message || lista));
    throw Object.assign(new Error(`Braspress: ${(j && j.message) || 'erro'}${lista ? ' – ' + lista : ''} (HTTP ${resp.status}).`), { requisicao: corpo, resposta: j, respondeu, mensagem: [j && j.message, lista].filter(Boolean).join(' – ') || null });
  }
  return { total: +j.totalFrete, prazo: parseInt(j.prazo, 10) || null, id: j.id != null ? String(j.id) : null,
    requisicao: corpo, resposta: j, obs: corpo.cnpjDestinatario === +DESTINATARIO_GENERICO ? 'sem destinatário (só CEP)' : null };
}
