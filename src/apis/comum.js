// Utilidades comuns aos conectores de cotação online.
//
// Cada conector (src/apis/<nome>.js) exporta:
//   tipo                       nome curto do conector ("braspress", "ssw"…)
//   integracoes(env)           lista de integrações configuradas nos secrets, cada uma
//                              { id, tipo, transportadora, tabela, conf }   (tabela = id da tabela de frete, se houver)
//   cotar(integ, req, fetch)   cota na transportadora e devolve { total, prazo, id, resposta }
//                              ou lança Error com mensagem legível.
// req é o pedido de cotação já normalizado (ver normalizarPedido abaixo).

export const so = (s) => String(s ?? '').replace(/\D/g, '');
export const arred = (v, n = 3) => Math.round((+v || 0) * 10 ** n) / 10 ** n;

// Origem da Proloplast (Nova Santa Rita/RS), usada quando nada mais foi configurado.
export const CEP_ORIGEM_PADRAO = '92480000';
// CPF genérico, não cadastrado nas transportadoras: a cotação fica só pelo CEP de destino.
export const DESTINATARIO_GENERICO = '00000000191';

export function lerJSONSecret(env, nome) {
  if (!env[nome]) return [];
  let L;
  try { L = JSON.parse(env[nome]); } catch { throw new Error(`O secret ${nome} não é um JSON válido.`); }
  return Array.isArray(L) ? L : [L];
}

export const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Pedido de cotação normalizado, igual para todos os conectores.
export function normalizarPedido(d, remetente) {
  const volumes = Math.max(1, parseInt(d.volumes, 10) || 1);
  let cubagem = (Array.isArray(d.cubagem) ? d.cubagem : [])
    .map((x) => ({ altura: arred(x.altura), largura: arred(x.largura), comprimento: arred(x.comprimento), volumes: Math.max(1, parseInt(x.volumes, 10) || 1) }))
    .filter((x) => x.altura > 0 && x.largura > 0 && x.comprimento > 0);
  if (!cubagem.length && +d.m3 > 0) { // só o volume total: um cubo equivalente por volume
    const lado = arred(Math.cbrt(+d.m3 / volumes));
    cubagem = [{ altura: lado, largura: lado, comprimento: lado, volumes }];
  }
  const m3 = arred(cubagem.reduce((s, x) => s + x.altura * x.largura * x.comprimento * x.volumes, 0), 4);
  const doc = so(d.cnpjDestinatario);
  return {
    cnpjRemetente: remetente.cnpj,
    cepOrigem: so(remetente.cep).padStart(8, '0'),
    cepDestino: so(d.cepDestino).padStart(8, '0'),
    valorNF: arred(d.vlrMercadoria ?? d.valorNF, 2),
    peso: arred(d.peso),
    volumes,
    cubagem,
    m3,
    cnpjDestinatario: doc.length === 11 || doc.length === 14 ? doc : null,
  };
}

export function validarPedido(req) {
  if (req.cepDestino.length !== 8 || /^0+$/.test(req.cepDestino)) return 'Informe o CEP de destino.';
  if (req.cepOrigem.length !== 8) return 'Sem CEP de origem configurado.';
  if (!(req.peso > 0) || !(req.valorNF > 0)) return 'Informe o peso e o valor da NF.';
  if (!(req.m3 > 0)) return 'Informe as dimensões ou o volume (m³).';
  return null;
}

// Converte "1.234,56", "1234,56" ou "1234.56" em número.
export function numeroBR(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(s)) return +s.replace(/\./g, '').replace(',', '.');
  if (/^-?\d+,\d+$/.test(s)) return +s.replace(',', '.');
  return +s;
}

export async function comTempoLimite(promessa, ms, msg) {
  let t;
  return Promise.race([promessa, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

// Tipo do erro de uma cotação online, para a tela explicar direito:
//   'nao_atende' – a transportadora respondeu que não atende o destino (CEP/cidade/região)
//   'recusou'    – a transportadora respondeu com outra recusa (ex.: peso acima do limite, cliente sem tabela)
//   'falha'      – não houve resposta útil (rede, tempo esgotado, login, erro do servidor)
const NAO_ATENDE = /n[ãa]o\s+(atend|h[áa]\s+atendimento|possui\s+atendimento|aten[dt])|sem\s+atendimento|fora\s+da\s+(área|area|abrang)|n[ãa]o\s+(é|e)\s+atendid|localidade\s+(n[ãa]o|inv[áa]lida)|cep\s+(de\s+)?destino\s+(n[ãa]o|inv[áa]lid)|destino\s+n[ãa]o|n[ãa]o\s+(entrega|coleta|trabalha)|sem\s+cobertura|não\s+abrang/i;
export function tipoDoErro(e) {
  if (!e || !e.respondeu) return 'falha';
  return NAO_ATENDE.test(e.message || '') ? 'nao_atende' : 'recusou';
}
