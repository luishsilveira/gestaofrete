// Conector SSW: web service de cotação usado por várias transportadoras (Expresso Leomar e outras).
// SOAP em https://ssw.inf.br/ws/sswCotacao/index.php, operação "cotar"; a resposta é um XML <cotacao>
// com <erro>, <mensagem>, <totalFrete>, <prazo> e o nº da cotação.
// Secret SSW_TRANSPORTADORAS: uma entrada por transportadora (cada uma tem seu domínio no SSW)
//   [{"transportadora":"Expresso Leomar","dominio":"LEO","login":"...","senha":"...","cnpjPagador":"12995553000100"}]
// Opcionais: "id" (identificador interno), "tabela" (id da tabela de frete da mesma transportadora,
// para comparar online × tabela), "senhaPagador", "mercadoria" (código, padrão 1) e "extras" (outros
// parâmetros do web service, repassados como estão).
import { so, lerJSONSecret, slug, numeroBR } from './comum.js';

export const tipo = 'ssw';
export const URL = 'https://ssw.inf.br/ws/sswCotacao/index.php';
const PADRAO = { ns: 'urn:sswinfbr.sswCotacao', acao: 'urn:sswinfbr.sswCotacao#cotar' };
let wsdl = null; // namespace e soapAction lidos do WSDL (uma vez por instância do Worker)

export function integracoes(env) {
  return lerJSONSecret(env, 'SSW_TRANSPORTADORAS')
    .filter((t) => t && t.transportadora && t.dominio && t.login && t.senha)
    .map((t) => ({ id: 'ssw-' + (t.id ? slug(t.id) : slug(t.transportadora)), tipo, transportadora: String(t.transportadora),
      tabela: t.tabela || null, conf: t, cnpjs: t.cnpjPagador ? [so(t.cnpjPagador)] : [] }));
}

async function lerWsdl(fetchImpl) {
  if (wsdl) return wsdl;
  try {
    const r = await fetchImpl(URL + '?wsdl', { headers: { accept: 'text/xml' } });
    const x = await r.text();
    const ns = (x.match(/targetNamespace="([^"]+)"/) || [])[1];
    const acao = (x.match(/<(?:\w+:)?operation name="cotar"[\s\S]*?soapAction="([^"]*)"/) || [])[1];
    wsdl = { ns: ns || PADRAO.ns, acao: acao ?? (ns ? ns + '#cotar' : PADRAO.acao) };
  } catch { wsdl = PADRAO; }
  return wsdl;
}

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const desescXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// valor de um elemento simples (sem filhos); "bloco" pega o conteúdo inteiro, com filhos
const tag = (xml, ...nomes) => { for (const n of nomes) { const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([^<]*)</${n}>`, 'i')); if (m) return desescXml(m[1]).trim(); } return null; };
const bloco = (xml, n) => { const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')); return m ? m[1] : null; };

export function montarParametros(conf, req) {
  const p = {
    dominio: conf.dominio, login: conf.login, senha: conf.senha,
    cnpjPagador: so(conf.cnpjPagador) || req.cnpjRemetente,
    ...(conf.senhaPagador ? { senhaPagador: conf.senhaPagador } : {}),
    cepOrigem: req.cepOrigem, cepDestino: req.cepDestino,
    valorNF: req.valorNF.toFixed(2), quantidade: req.volumes, peso: req.peso.toFixed(3), volume: req.m3.toFixed(4),
    mercadoria: conf.mercadoria ?? 1,
    ...(req.cnpjDestinatario ? { cnpjDestinatario: req.cnpjDestinatario } : {}),
    ...(conf.extras || {}),
  };
  return p;
}

export function envelope(w, params) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="${escXml(w.ns)}">` +
    `<soapenv:Body><ws:cotar>${Object.entries(params).map(([k, v]) => `<${k}>${escXml(v)}</${k}>`).join('')}</ws:cotar></soapenv:Body></soapenv:Envelope>`;
}

// Lê a resposta SOAP: o retorno vem como texto com o XML <cotacao> escapado dentro de <return>.
export function lerResposta(texto) {
  const falha = tag(texto, 'faultstring');
  if (falha) throw new Error('SSW: ' + falha);
  const r0 = bloco(texto, 'return');
  const ret = r0 != null ? desescXml(r0) : texto;
  const erro = tag(ret, 'erro');
  const msg = tag(ret, 'mensagem');
  // recusa da própria transportadora (ex.: destino não atendido): a mensagem vem dela
  if (erro != null && erro !== '0') throw Object.assign(new Error('SSW: ' + (msg || `erro ${erro}`)), { respondeu: true, mensagem: msg || `erro ${erro}` });
  const total = numeroBR(tag(ret, 'totalFrete', 'frete', 'valorFrete'));
  if (!(total > 0)) throw Object.assign(new Error('SSW: ' + (msg || 'resposta sem valor de frete')), { respondeu: !!msg, mensagem: msg || null });
  return { total, prazo: parseInt(tag(ret, 'prazo'), 10) || null, id: tag(ret, 'cotacao', 'numeroCotacao', 'nroCotacao') };
}

export async function cotar(integ, req, fetchImpl = fetch) {
  const w = await lerWsdl(fetchImpl);
  const params = montarParametros(integ.conf, req);
  const resp = await fetchImpl(URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${w.acao}"` },
    body: envelope(w, params),
  });
  const texto = await resp.text();
  const { senha, senhaPagador, ...semSenha } = params;
  try {
    return { ...lerResposta(texto), requisicao: semSenha, resposta: texto.slice(0, 4000) };
  } catch (e) {
    if (!resp.ok && !/SSW:/.test(e.message)) e.message = `SSW: HTTP ${resp.status}`;
    throw Object.assign(e, { requisicao: semSenha, resposta: texto.slice(0, 4000) });
  }
}
