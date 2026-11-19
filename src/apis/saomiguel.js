// Conector Expresso São Miguel: API REST de cotação (manual "Cotação de Frete – Expresso São Miguel", 2026).
//   POST https://wsintegcli01.expressosaomiguel.com.br:40504/wsservernet/rest/frete/buscar/cliente
//   Headers ACCESS_KEY (chave exclusiva do CNPJ), CUSTOMER (CNPJ de 14 dígitos), VERSION: 2
//   Corpo: tipoPagoPagar (P = pago), codigoCidadeDestino (IBGE), quantidadeMercadoria, pesoMercadoria,
//          cubagemMercadoria (m³), valorMercadoria, clienteDestino (CPF/CNPJ), dataEmbarque (DD/MM/AAAA), tipoPessoaDestino (F/J)
//   Resposta: { status: "ok", mensagem, valorFrete, previsaoEmbarque, previsaoEntrega: "DD/MM/AAAA HH:MM", informacaoEntrega }
// Limite da São Miguel: 20 requisições por minuto; acima disso a chave fica bloqueada por 30 minutos (HTTP 401).
// Por isso o orquestrador (src/online.js) respeita `limitePorMinuto` e cai para a tabela antes de chegar no limite.
// Credenciais pela tela Integrações: uma chave por CNPJ ("customer"); vale a do CNPJ remetente, senão a primeira.
import { so, arred, lerJSONSecret, DESTINATARIO_GENERICO, limparTexto } from './comum.js';

export const tipo = 'saomiguel';
export const URL = 'https://wsintegcli01.expressosaomiguel.com.br:40504/wsservernet/rest/frete/buscar/cliente';
export const limitePorMinuto = 15; // margem abaixo das 20/min da São Miguel

export function contas(env) {
  return lerJSONSecret(env, 'SAOMIGUEL_CONTAS')
    .map((c) => ({ customer: so(c.customer), accessKey: String(c.accessKey || '').trim() }))
    .filter((c) => c.customer.length === 14 && c.accessKey);
}

export function integracoes(env) {
  const L = contas(env);
  return L.length ? [{ id: 'saomiguel', tipo, transportadora: 'Expresso São Miguel', tabela: 'sm', conf: { contas: L }, cnpjs: L.map((c) => c.customer) }] : [];
}

// Código IBGE do município de destino pelo CEP (ViaCEP), guardado enquanto o servidor estiver ativo.
const IBGE = new Map();
export async function ibgeDoCep(cep, fetchImpl = fetch) {
  if (IBGE.has(cep)) return IBGE.get(cep);
  let r;
  try { r = await fetchImpl(`https://viacep.com.br/ws/${cep}/json/`, { headers: { accept: 'application/json' } }); } catch { r = null; }
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  const ibge = j && !j.erro && /^\d{7}$/.test(String(j.ibge || '')) ? +j.ibge : null;
  if (ibge) IBGE.set(cep, ibge);
  return ibge;
}

const hojeSP = () => new Date(Date.now() - 3 * 3600e3); // data de hoje em São Paulo (UTC−3)
const ddmmaaaa = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
// Dias úteis (seg–sex) de hoje até a previsão de entrega "DD/MM/AAAA[ HH:MM]".
export function diasUteisAte(previsao, hoje = hojeSP()) {
  const m = String(previsao || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const fim = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  let d = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()), n = 0;
  if (fim < d) return null;
  while (d < fim) { d += 864e5; const w = new Date(d).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return Math.max(n, 1);
}

export function montarRequisicao(req, ibge, hoje = hojeSP()) {
  const doc = req.cnpjDestinatario || DESTINATARIO_GENERICO;
  return {
    tipoPagoPagar: 'P',
    codigoCidadeDestino: ibge,
    quantidadeMercadoria: req.volumes,
    pesoMercadoria: arred(req.peso),
    cubagemMercadoria: arred(req.m3, 4),
    valorMercadoria: arred(req.valorNF, 2),
    clienteDestino: doc,
    dataEmbarque: ddmmaaaa(hoje),
    tipoPessoaDestino: doc.length === 14 ? 'J' : 'F',
  };
}

export async function cotar(integ, req, fetchImpl = fetch) {
  const L = integ.conf.contas;
  const conta = L.find((c) => c.customer === req.cnpjRemetente) || L[0];
  const ibge = await ibgeDoCep(req.cepDestino, fetchImpl);
  if (!ibge) throw Object.assign(new Error(`São Miguel: não foi possível obter o código IBGE da cidade do CEP ${req.cepDestino} (ViaCEP).`), { respondeu: false });
  const corpo = montarRequisicao(req, ibge);
  const resp = await fetchImpl(URL, {
    method: 'POST',
    headers: { ACCESS_KEY: conta.accessKey, CUSTOMER: conta.customer, VERSION: '2', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(corpo),
  });
  let j = null; try { j = await resp.json(); } catch { /* sem JSON */ }
  if (resp.status === 401) throw Object.assign(new Error('São Miguel: chave de acesso recusada ou limite de 20 consultas por minuto excedido (nesse caso a chave fica bloqueada por 30 minutos).'), { requisicao: corpo, resposta: j });
  const msg = j && j.mensagem ? limparTexto(j.mensagem) : '';
  if (!resp.ok || !j || String(j.status).toLowerCase() !== 'ok' || !(+j.valorFrete > 0)) {
    // com mensagem da São Miguel = recusa dela (ex.: cidade não atendida); sem resposta útil = falha técnica
    throw Object.assign(new Error(`São Miguel: ${msg || 'erro'} (HTTP ${resp.status}).`), { requisicao: corpo, resposta: j, respondeu: resp.status < 500 && !!msg, mensagem: msg || null });
  }
  return { total: +j.valorFrete, prazo: diasUteisAte(j.previsaoEntrega), id: null, requisicao: corpo, resposta: j,
    obs: [j.previsaoEntrega ? `entrega prevista ${j.previsaoEntrega}` : null, corpo.clienteDestino === DESTINATARIO_GENERICO ? 'sem destinatário (só cidade)' : null].filter(Boolean).join(' · ') || null };
}
