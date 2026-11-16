// Gestão de Frete – Proloplast
// As tabelas ficam em dados/transportadoras/*.json (lista em dados/transportadoras/index.json)
// e as listas de cidades em dados/cidades/*.json.
const D = {};
async function carregar(){
  const get=p=>fetch(p,{cache:'no-cache'}).then(r=>{ if(!r.ok) throw new Error(p+': '+r.status); return r.json(); });
  const idx=await get('dados/transportadoras/index.json');
  D.tabelas=await Promise.all(idx.ativas.map(f=>get('dados/transportadoras/'+f)));
  const c=await Promise.all(['transito-brasil','tjb','rodonaves','sao-miguel','rodonaves-taxas-entrega','zonas-sp'].map(n=>get('dados/cidades/'+n+'.json')));
  [D.tbmap,D.tjmap,D.rtemap,D.smmap,D.txcid]=c; D.zr=c[5].restricao; D.zk=c[5].risco;
  iniciar();
}
carregar().catch(e=>{ document.getElementById('subt').textContent='Erro ao carregar as tabelas: '+e.message; console.error(e); });

function iniciar(){
const TABELAS = D.tabelas;
const UFNOME={RS:'Rio Grande do Sul',SC:'Santa Catarina',PR:'Paraná',SP:'São Paulo',RJ:'Rio de Janeiro',MG:'Minas Gerais',ES:'Espírito Santo',BA:'Bahia',GO:'Goiás',DF:'Distrito Federal',MS:'Mato Grosso do Sul',MT:'Mato Grosso',SE:'Sergipe',AL:'Alagoas',PE:'Pernambuco',PB:'Paraíba',RN:'Rio Grande do Norte',CE:'Ceará',PI:'Piauí',MA:'Maranhão',PA:'Pará',AP:'Amapá',AM:'Amazonas',RR:'Roraima',TO:'Tocantins',AC:'Acre',RO:'Rondônia'};
const CAPITAL={RS:'PORTO ALEGRE',SC:'FLORIANOPOLIS',PR:'CURITIBA',SP:'SAO PAULO',RJ:'RIO DE JANEIRO',MG:'BELO HORIZONTE',ES:'VITORIA',BA:'SALVADOR',GO:'GOIANIA',DF:'BRASILIA',MS:'CAMPO GRANDE',MT:'CUIABA',SE:'ARACAJU',AL:'MACEIO',PE:'RECIFE',PB:'JOAO PESSOA',RN:'NATAL',CE:'FORTALEZA',PI:'TERESINA',MA:'SAO LUIS',PA:'BELEM',AP:'MACAPA',AM:'MANAUS',RR:'BOA VISTA',TO:'PALMAS',AC:'RIO BRANCO',RO:'PORTO VELHO'};
function aliqICMS(uf){ if(uf==='RS')return 12; return ['SC','PR','SP','RJ','MG'].includes(uf)?12:7; }
const $=id=>document.getElementById(id);
const UFCEP=[[1000000,19999999,'SP'],[20000000,28999999,'RJ'],[29000000,29999999,'ES'],[30000000,39999999,'MG'],[40000000,48999999,'BA'],[49000000,49999999,'SE'],[50000000,56999999,'PE'],[57000000,57999999,'AL'],[58000000,58999999,'PB'],[59000000,59999999,'RN'],[60000000,63999999,'CE'],[64000000,64999999,'PI'],[65000000,65999999,'MA'],[66000000,68899999,'PA'],[68900000,68999999,'AP'],[69000000,69299999,'AM'],[69300000,69399999,'RR'],[69400000,69899999,'AM'],[69900000,69999999,'AC'],[70000000,72799999,'DF'],[72800000,72999999,'GO'],[73000000,73699999,'DF'],[73700000,76799999,'GO'],[76800000,76999999,'RO'],[77000000,77999999,'TO'],[78000000,78899999,'MT'],[79000000,79999999,'MS'],[80000000,87999999,'PR'],[88000000,89999999,'SC'],[90000000,99999999,'RS']];
const ufDoCep=n=>{ const r=UFCEP.find(([a,b])=>n>=a&&n<=b); return r?r[2]:null; };
const fp=p=>p==1?'1 dia útil':p+' dias úteis';
const brl=v=>v.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const norm=s=>s.normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
// chave de comparação de nomes de cidade: sem acento, sem pontuação (D'OESTE = D OESTE)
const K=s=>norm(String(s)).replace(/[^A-Z0-9]+/g,' ').trim();
const IDX={};
[['tb',D.tbmap],['tjb',D.tjmap],['sm',D.smmap],['rte',D.rtemap]].forEach(([k,l])=>{ const m=new Map(); l.forEach(x=>{ const key=K(x[0])+'|'+x[1]; if(!m.has(key)) m.set(key,x); }); IDX[k]=m; });
const TXCID=new Map(Object.entries(D.txcid).map(([k,v])=>{ const [c,u]=k.split('|'); return [K(c)+'|'+u,v]; }));
let tonMode='exc'; let override={}; let ULT=null; let API_OK=false; let BLING_PED=null; let BLING_SYNC=null; const VERSAO='2.0';
$('subt').textContent=`Origem Nova Santa Rita/RS · carga fracionada · ${TABELAS.length} tabelas carregadas`;

// índice de cidades (união das listas)
const CID=new Map();
D.tbmap.forEach(m=>CID.set(m[0]+'|'+m[1],{c:m[0],uf:m[1]}));
D.tjmap.forEach(m=>CID.set(m[0]+'|'+m[1],{c:m[0],uf:m[1]}));
D.rtemap.forEach(m=>CID.set(m[0]+'|'+m[1],{c:m[0],uf:m[1]}));
D.smmap.forEach(m=>CID.set(m[0]+'|'+m[1],{c:m[0],uf:m[1]}));
Object.entries(CAPITAL).forEach(([uf,c])=>CID.set(c+'|'+uf,{c,uf}));
$('cidades').innerHTML=[...CID.values()].sort((a,b)=>a.c.localeCompare(b.c)).map(x=>`<option value="${x.c} - ${x.uf}">`).join('');
const ufs=[...new Set(TABELAS.flatMap(t=>t.rotas.map(r=>r.uf)))].sort((a,b)=>UFNOME[a].localeCompare(UFNOME[b]));
$('uf').innerHTML=ufs.map(u=>`<option value="${u}">${u} – ${UFNOME[u]}</option>`).join('');

let dest={uf:'SP',cidade:'CAMPINAS'};
function parseCidade(v){ const m=norm(v).match(/^(.*?)\s*[-\/]\s*([A-Z]{2})$/); return m?{cidade:m[1],uf:m[2]}:{cidade:norm(v),uf:$('uf').value}; }
function setDest(d,from){ dest=d; override={};
  if(from!=='uf') $('uf').value=d.uf;
  if(from!=='cid') $('cid').value=d.cidade?d.cidade+' - '+d.uf:'';
  calc(); }
$('cid').addEventListener('change',()=>{ $('cep').value=''; setDest(parseCidade($('cid').value),'cid'); });
$('uf').addEventListener('change',()=>{ $('cep').value=''; setDest({uf:$('uf').value,cidade:''},'uf'); });
// consulta do CEP: ViaCEP, com BrasilAPI como reserva; se as duas falharem, usa as listas das transportadoras
const CEPCACHE=new Map(); let cepSeq=0;
async function buscaJSON(url,ms=5000){ const ac=new AbortController(); const tm=setTimeout(()=>ac.abort(),ms);
  try{ const r=await fetch(url,{signal:ac.signal}); if(!r.ok) throw new Error(r.status); return await r.json(); } finally{ clearTimeout(tm); } }
async function consultaCep(cep8){
  if(CEPCACHE.has(cep8)) return CEPCACHE.get(cep8);
  let res=null;
  try{ const j=await buscaJSON(`https://viacep.com.br/ws/${cep8}/json/`);
    if(j&&!j.erro&&j.localidade) res={cidade:j.localidade,uf:j.uf,ibge:j.ibge,fonte:'ViaCEP'};
    else if(j&&j.erro) res={inexistente:true}; }catch(e){}
  if(!res||res.inexistente){ try{ const j=await buscaJSON(`https://brasilapi.com.br/api/cep/v2/${cep8}`);
    if(j&&j.city) res={cidade:j.city,uf:j.state,fonte:'BrasilAPI'}; }catch(e){} }
  if(res&&!res.inexistente) CEPCACHE.set(cep8,res);
  return res;
}
$('cep').addEventListener('input',async()=>{ const dg=$('cep').value.replace(/\D/g,''); if(dg.length<8) return; const n=+dg.slice(0,8);
  const ufc=ufDoCep(n);
  if(!ufc){ $('destinfo').innerHTML='CEP inválido.'; return; }
  const seq=++cepSeq; $('destinfo').innerHTML='Consultando CEP…';
  const r=await consultaCep(dg.slice(0,8));
  if(seq!==cepSeq) return; // o usuário já digitou outro CEP
  if(r&&r.uf&&!r.inexistente){ setDest({uf:r.uf,cidade:norm(r.cidade),cep:n,ibge:r.ibge,fonteCep:r.fonte},'cep'); return; }
  // reserva: listas das transportadoras
  let best=null; const chk=(c,uf,a,b)=>{ if(uf!==ufc||ufDoCep(a)!==uf||ufDoCep(b)!==uf) return; if(n>=a&&n<=b&&(!best||b-a<best.w)) best={c,uf,w:b-a}; };
  D.rtemap.forEach(x=>{ for(let i=0;i<x[5].length;i+=2) chk(x[0],x[1],x[5][i],x[5][i+1]); });
  D.tbmap.forEach(x=>chk(x[0],x[1],x[3],x[4]));
  D.smmap.forEach(x=>chk(x[0],x[1],x[3],x[4]));
  const naoCorreios=!!(r&&r.inexistente);
  if(best) setDest({uf:best.uf,cidade:best.c,cep:n,naoCorreios},'cep');
  else { setDest({uf:ufc,cidade:'',cep:n,semLista:true,naoCorreios},'cep'); } });

// resolve a praça de cada transportadora
function resolver(t){
  const uf=dest.uf, c=dest.cidade, dep=$('dep').checked;
  const doUf=t.rotas.map((r,i)=>({r,i})).filter(x=>x.r.uf===uf);
  if(override[t.id]!==undefined) return {i:override[t.id],fonte:'man',txt:'escolha manual',op:doUf};
  if(t.mapa&&dest.semLista) return {erro:'a cidade desse CEP não está na lista de cidades atendidas'};
  if(t.mapa==='tb'&&c){
    const m=IDX.tb.get(K(c)+'|'+uf);
    if(!m) return {erro:`${c}/${uf} não está na lista de cidades atendidas`};
    const want=(dep&&m[2]==='RS1');
    let i=t.rotas.findIndex(r=>r.cod===m[2]&&!!r.deposito===want);
    if(i<0) return {erro:`praça ${m[2]} sem tarifa na tabela (sob cotação)`};
    return {i,fonte:'lista',txt:`praça ${m[2]} pela lista de cidades`,prazo:m[5],op:doUf};
  }
  if(t.mapa==='tjb'&&c){
    const m=IDX.tjb.get(K(c)+'|'+uf);
    if(!m) return {erro:`${c}/${uf} não está na lista de cidades atendidas`};
    if(!m[2]) return {erro:t.semTarifa};
    return {i:t.rotas.findIndex(r=>r.regiao===m[2]),fonte:'lista',txt:'praça pela lista de cidades',prazo:m[3],freq:m[4],op:doUf};
  }
  if(t.mapa==='sm'&&c){
    const m=IDX.sm.get(K(c)+'|'+uf);
    if(!m) return {erro:`${c}/${uf} não está na lista de cidades atendidas`};
    const i=t.rotas.findIndex(r=>r.regiao===m[2]);
    if(i<0) return {erro:`praça ${m[2]} sem tarifa na tabela`};
    return {i,fonte:'lista',txt:`praça ${m[2]} pela lista de cidades`,prazo:m[5]===m[6]?m[5]:`${m[5]} a ${m[6]}`,freq:m[7],op:doUf};
  }
  if(t.mapa==='rte'&&c){
    const m=IDX.rte.get(K(c)+'|'+uf);
    if(!m) return {erro:`${c}/${uf} não está na lista de cidades atendidas`};
    let i=t.rotas.findIndex(r=>r.cidade&&K(r.cidade)===K(c)&&r.uf===uf);
    const polo=(t.aliasPolo&&t.aliasPolo[m[2]])||m[2];
    if(i<0) i=t.rotas.findIndex(r=>r.regiao===polo);
    if(i<0) return {erro:`polo ${m[2]} sem tarifa. ${t.semTarifa}`};
    return {i,fonte:'lista',txt:`polo ${m[2]} pela lista de cidades`,prazo:m[4],und:String(m[3]),op:doUf,extras:extrasRte(t,c,uf)};
  }
  if(!doUf.length) return {erro:`não atende ${uf}`};
  if(c){ // praça com o nome da cidade (ex.: "Imperatriz - IP1", "Palmas", "Maceio")
    const base=r=>r.tarifaKg!=null?r.tarifaKg:(r.faixas?r.faixas[0]:(r.kg||0));
    const byCity=doUf.filter(x=>!x.r.naoAuto).filter(x=>{ const n=K(x.r.regiao.split(' - ')[0].replace(/\(.*?\)/g,'')), cc=K(c); return n===cc||n.startsWith(cc+' E ')||n.startsWith(cc+' REG'); }).sort((a,b)=>base(a.r)-base(b.r))[0];
    if(byCity) return {i:byCity.i,fonte:'cap',txt:'praça da cidade',op:doUf};
  }
  if(c&&K(c)===CAPITAL[uf]&&!t.semCapital){
    const cap=doUf.find(x=>!x.r.naoAuto&&!/^interior/i.test(x.r.regiao)); if(cap) return {i:cap.i,fonte:'cap',txt:'capital',op:doUf};
  }
  const first=(c||dest.semLista)?(doUf.find(x=>/interior/i.test(x.r.regiao))||doUf[0]):doUf[0];
  return {i:first.i,fonte:'man',txt:(c||dest.semLista)?'sem lista de cidades: confira a praça':'escolha a praça',op:doUf,aviso:!!c};
}

function extrasRte(t,c,uf){
  const k=K(c)+'|'+uf, ex=(TXCID.get(k)||[]).map(([n,v])=>({n,v,d:'taxa de entrega da cidade'}));
  t.especiais.forEach(e=>{ if(e.cidades.some(x=>{ const [a,b]=x.split('|'); return K(a)+'|'+b===k; })) ex.push({n:e.nome,faixas:e.faixas}); });
  const cep=dest.cep; const inZ=z=>cep&&z.some(([a,b])=>cep>=a&&cep<=b);
  if(inZ(D.zr)) ex.push({n:t.zonaRestricao.nome,faixas:t.zonaRestricao.faixas});
  if(inZ(D.zk)) ex.push({n:t.zonaRisco.nome,v:t.zonaRisco.valor,d:'CEP em zona de risco'});
  return ex;
}
function fretePeso(t,r,p,nf){
  if(t.modelo==='taxaKg'){ let ac=0; (t.acrescimoKg||[]).forEach(([lim,pc],i)=>{ if(i?p>lim:p>=lim) ac=pc; });
    const kg=p*r.kg*(1+ac/100);
    return {v:r.taxa+kg,d:`Taxa ${brl(r.taxa)} + ${p.toFixed(1)} kg × R$ ${r.kg.toLocaleString("pt-BR",{minimumFractionDigits:3})}/kg${ac?` (+${ac}% por peso)`:''}`}; }
  if(t.modelo==='pctNF'){ const a=r.fmin,b=nf*r.pct/100,c=p*r.minKg, v=Math.max(a,b,c);
    const d=v===c?`${p.toFixed(1)} kg × ${brl(r.minKg)}/kg (mínimo por kg)`:v===b?`${r.pct.toLocaleString('pt-BR')}% × NF`:'Frete mínimo';
    return {v,d:`${d} · maior entre mínimo ${brl(a)}, % NF ${brl(b)} e kg ${brl(c)}`}; }
  if(t.modelo==='kg'){ const v=p*r.tarifaKg; return v<r.minimo?{v:r.minimo,min:true,d:`Frete mínimo da região (peso × tarifa = ${brl(v)})`}:{v,d:`${p.toFixed(1)} kg × ${brl(r.tarifaKg)}/kg`}; }
  const L=t.limites;
  for(let i=0;i<L.length;i++) if(p<=L[i]) return {v:r.faixas[i],d:`Faixa até ${L[i]} kg`};
  const last=r.faixas[L.length-1], lim=L[L.length-1];
  if(t.acima==='kg') return {v:p*r.fpk,d:`Acima de ${lim} kg: ${p.toFixed(1)} kg × ${brl(r.fpk)}/kg`};
  if(tonMode==='exc') return {v:last+(p-lim)*r.ton/1000,d:`Faixa ${lim} kg (${brl(last)}) + ${(p-lim).toFixed(1)} kg excedentes × ${brl(r.ton)}/t`};
  const tot=p*r.ton/1000; return tot>last?{v:tot,d:`${p.toFixed(1)} kg × ${brl(r.ton)}/t`}:{v:last,d:`Mínimo da faixa ${lim} kg (peso × tonelada = ${brl(tot)})`};
}

function cotar(t,r,p,nf,uf,op,rvx={}){
  const it=[]; const add=(n,v,d='')=>{ if(v>0.0049) it.push({n,v,d}); };
  const f=fretePeso(t,r,p,nf), fp=f.v; add(t.modelo==='pctNF'?'Frete (% NF / kg / mínimo)':'Frete peso',fp,f.d);
  if(t.modelo==='pctNF'){}
  else if(t.modelo==='kg'){ const av=t.advalorem; if(!(f.min&&nf<=av.isentoNoMinimoAte)) add('Ad valorem',nf*av.pct/100,`${av.pct.toLocaleString('pt-BR')}% × NF${f.min?' (NF acima de R$ 1.000 no frete mínimo)':''}`); }
  else add('Frete valor (ad valorem)',nf*r.fvPct/100,`${r.fvPct.toLocaleString('pt-BR')}% × NF`);
  if(r.txa) add('TXA – taxa de percurso',r.txa,'valor fixo da praça');
  if(r.txaKg) add('TXA – taxa de percurso',r.txaKg*p,`${p.toFixed(1)} kg × ${brl(r.txaKg)}`);
  if(r.taxaExtra) add('Taxa da praça',r.taxaExtra);
  if(t.gris&&t.gris.pct){ const g=t.gris; let pc=g.pct;
    if(g.porUnd&&rvx.und&&g.porUnd[rvx.und]!==undefined) pc=g.porUnd[rvx.und];
    else if(g.porUf&&g.porUf[uf]!==undefined) pc=g.porUf[uf];
    else if(g.acimaNF&&nf>g.acimaNF) pc=g.pctAcima;
    const gm=(g.minPorUf&&g.minPorUf[uf])||g.min||0;
    add('GRIS',Math.max(nf*pc/100,gm),`${pc.toLocaleString('pt-BR')}% × NF${gm?' (mín. '+brl(gm)+')':''}`); }
  (rvx.extras||[]).forEach(e=>{ if(e.faixas){ const j=e.faixas.findIndex(x=>p<=x[0]), f=e.faixas[j]; add(e.n,f[1],f[0]>=1e9?`acima de ${e.faixas[j-1][0]} kg`:`até ${f[0]} kg`); } else add(e.n,e.v,e.d); });
  const fr=Math.ceil(p/100), pv=(t.pedagioUf&&t.pedagioUf[uf])||t.pedagio; add('Pedágio',fr*pv,`${fr} fração(ões) de 100 kg × ${brl(pv)}`);
  (t.fixas||[]).forEach(x=>{ if(x.pesoAcima&&p<=x.pesoAcima)return; if(x.ufs&&!x.ufs.includes(uf))return; add(x.nome,x.valor); });
  (t.pctFrete||[]).forEach(x=>{ if(x.uf&&x.uf!==uf)return; add(x.nome,Math.max(fp*x.pct/100,x.min||0),`${x.pct}% s/ frete peso${x.min?' (mín. '+brl(x.min)+')':''}`); });
  (t.opcionais||[]).forEach(x=>{
    let on={tde:op.tde&&!(t.id==='tjb'&&op.int),tdei:op.tde&&op.int,tda:op.tda,trt:op.trt,tag:op.ag,comp:op.ag,pal:op.pal}[x.id];
    if(!on)return;
    if(x.porUf){ const v=x.porUf[uf]; if(v) add(x.nome,Math.max(fp*v[0]/100,v[1]),`${v[0]}% s/ frete peso (mín. ${brl(v[1])})`); return; }
    if(x.valor) add(x.nome,x.valor); else add(x.nome,Math.max(fp*x.pct/100,x.min),`${x.pct}% s/ frete peso (mín. ${brl(x.min)})`);
  });
  let sub=it.reduce((s,x)=>s+x.v,0);
  (t.pctSubtotal||[]).forEach(x=>{ const v=Math.max(sub*x.pct/100,x.min||0); add(x.nome,v,`${x.pct.toLocaleString('pt-BR')}% s/ subtotal`); sub+=v; });
  let icms=0, al=0;
  if(op.icms){ al=aliqICMS(uf); icms=sub/(1-al/100)-sub; }
  return {it,sub,icms,al,total:sub+icms};
}

function calc(){
  if(dest.invalido){ ULT=null; $('salvar').classList.add('hide'); $('destinfo').innerHTML='CEP não encontrado nos Correios. Confira o número ou digite a cidade.'; $('out').innerHTML=''; $('avisos').innerHTML=''; return; }
  const uf=dest.uf, peso=+$('peso').value||0, nf=+$('nf').value||0;
  let m3=+$('m3').value||0; const dim=(+$('c').value)*(+$('l').value)*(+$('a').value)*(+$('qv').value||1);
  if(dim>0) m3=dim;
  const pt=Math.max(peso,m3*300);
  const ptDe=t=>(t.isentoCubM3&&m3<=t.isentoCubM3)?peso:Math.max(peso,m3*(t.cubagem||300));
  $('pt').textContent=pt.toLocaleString('pt-BR',{maximumFractionDigits:2})+' kg'+(m3>0?`  (cubado: ${(m3*300).toLocaleString('pt-BR',{maximumFractionDigits:2})} kg)`:'');
  $('destinfo').innerHTML=dest.cidade?`Destino: <b>${dest.cidade} / ${uf}</b>${dest.cep?' · CEP '+String(dest.cep).padStart(8,'0').replace(/(\d{5})(\d{3})/,'$1-$2'):''}${dest.fonteCep?` <span class="small">(cidade confirmada pelos Correios via ${dest.fonteCep})</span>`:(dest.cep?` <span class="small">(cidade pela faixa de CEP das listas das transportadoras; ${dest.naoCorreios?'os Correios não reconheceram este CEP, confira o número':'consulta aos Correios indisponível'})</span>`:'')}`:(dest.semLista?`CEP ${String(dest.cep).padStart(8,'0').replace(/(\d{5})(\d{3})/,'$1-$2')} é de <b>${UFNOME[uf]||uf}</b>, mas a cidade não está nas listas das transportadoras. Digite o nome da cidade acima.`:`Destino: <b>${UFNOME[uf]}</b> (sem cidade: escolha a praça de cada transportadora)`);
  const op={tde:$('o_tde').checked,tda:$('o_tda').checked,trt:$('o_trt').checked,ag:$('o_ag').checked,pal:$('o_pal').checked,int:false,icms:$('icms').checked};
  $('icmsinfo').textContent=op.icms?`Alíquota aplicada RS → ${uf}: ${aliqICMS(uf)}%`:'Valores sem ICMS';
  const res=[], nao=[];
  TABELAS.forEach(t=>{ const rv=resolver(t);
    if(rv.erro){ nao.push({t,msg:rv.erro}); return; }
    const r=t.rotas[rv.i];
    if(t.id==='tjb') op.int=/interior/i.test(r.regiao);
    const pT=ptDe(t); res.push({t,r,rv,pT,...cotar(t,r,pT,nf,uf,op,rv)}); });
  // Cotação online: vale o valor da API; a tabela só entra quando a API não responde (as duas ficam registradas).
  const onReq=ONL.integ.length?reqOnline(peso,nf,m3):null, onChave=onReq?JSON.stringify(onReq):null;
  if(onReq){ const x=ONL.res&&ONL.res.chave===onChave?ONL.res:null, pend=ONL.pend===onChave;
    for(const ig of ONL.integ){
      const ib=ig.tabela?res.findIndex(r=>r.t.id===ig.tabela):-1, tb=ib>=0?res[ib]:null;
      const o=x&&x.ok?x.resultados.find(r=>r.integracao===ig.id):null;
      if(o&&o.ok){
        const on={t:tb?tb.t:(TABELAS.find(t=>t.id===ig.tabela)||{id:'api-'+ig.id,transportadora:o.transportadora}),r:{regiao:'cotação online',prazo:o.prazo},
          rv:{prazo:o.prazo,txt:'online',fonte:'api'},pT:pt,total:o.total,sub:o.total,icms:0,al:0,api:true,
          on:{fonte:'online',online:o.total,tabela:tb?+tb.total.toFixed(2):null,praca_tabela:tb?tb.r.regiao:null,id:o.id||null,prazo:o.prazo,erro:null},
          it:[{n:`Frete total informado pela ${o.transportadora}`,d:`cotação nº ${o.id||'—'} · válida no dia${x.remetente&&x.remetente.nome?' · remetente '+x.remetente.nome:''}${x.destinatarioGenerico?' · sem destinatário (só CEP)':''}`,v:o.total}].concat(
            tb?[{n:'Diferença para a tabela (só informativo)',d:`pela tabela: ${brl(tb.total)} (praça ${tb.r.regiao})`,v:o.total-tb.total}]:[])};
        if(ib>=0) res.splice(ib,1,on); else { res.push(on); const k=nao.findIndex(n=>n.t.id===ig.tabela); if(k>=0) nao.splice(k,1); }
      } else if(tb){
        const erro=o?o.erro:(x&&!x.ok?x.erro:(pend?'consulta online em andamento':'sem resposta da API'));
        tb.on={fonte:'tabela',online:null,tabela:+tb.total.toFixed(2),praca_tabela:tb.r.regiao,id:null,prazo:null,erro};
      }
    }
  }
  res.sort((a,b)=>a.total-b.total);
  ULT={uf,peso,nf,pt,m3,icms:op.icms,res,nao};
  if(onReq) agendarOnline(onReq,onChave);
  $('salvar').classList.toggle('hide',!res.length||!API_OK);
  { const sel=$('s_transp'), ant=sel.value;
    sel.innerHTML=res.map((x,k)=>`<option value="${k}" data-n="${x.t.transportadora}">${x.t.transportadora} – ${brl(x.total)}${k?'':' (menor preço)'}</option>`).join('');
    const k=res.findIndex(x=>x.t.transportadora===(sel.dataset.escolhida||'')); sel.value=String(k>=0?k:0); }
  if(res.length) $('s_status').textContent='';
  if(res.length&&API_OK) desenharManualCalc();
  const simples=$('simples').checked;
  $('out').classList.toggle('simple',simples); $('avisos').classList.toggle('hide',simples);
  if(simples){
    let h=res.map((x,k)=>{ const prazo=x.rv.prazo||x.r.prazo;
      return `<div class="r ${k?'':'best'}"><div class="rh"><div class="pos">${k+1}</div>
      <div class="nm"><b>${x.t.transportadora} ${k?'':'<span class="tag">Melhor opção</span>'}</b>${x.rv.fonte==='api'?`<span><span class="badge b-api">online</span> valor oficial da transportadora${x.it[1]&&Math.abs(x.it[1].v)>0.01?` · a tabela dá ${brl(Math.abs(x.it[1].v))} ${x.it[1].v>0?'a menos':'a mais'}`:''}</span>`:`<span><span class="badge b-tab">tabela</span>${x.on?(x.on.erro==='consulta online em andamento'?' consultando online…':' online indisponível'):''}${x.rv.fonte==='man'?` · praça ${x.r.regiao} a confirmar`:''}</span>`}</div>
      <div class="prz">${prazo?fp(prazo):'não informado'}<small>prazo</small></div>
      <div class="val">${brl(x.total)}<small>${k?'+'+brl(x.total-res[0].total):'menor preço'}</small></div></div></div>`;}).join('');
    if(!res.length) h+='<div class="na">Nenhuma tabela atende esse destino.</div>';
    if(nao.length) h+=`<div class="na">Sem cotação: ${nao.map(n=>n.t.transportadora).join(', ')}</div>`;
    $('out').innerHTML=h+onStatus(onChave); return;
  }
  let h=res.map((x,k)=>{
    const dif=k?` <small>+${brl(x.total-res[0].total)} (${((x.total/res[0].total-1)*100).toFixed(1)}%)</small>`:'<small>menor preço</small>';
    const prazo=x.rv.prazo||x.r.prazo;
    const bcls={lista:'b-lista',cap:'b-cap',man:'b-man',api:'b-api'}[x.rv.fonte];
    const bpNota=x.on&&x.on.fonte==='tabela'?` · <span class="aviso">${x.on.erro==='consulta online em andamento'?'consultando online…':'cotação online indisponível: '+esc(x.on.erro)}</span>`:'';
    return `<div class="r ${k?'':'best'}"><div class="rh"><div class="pos">${k+1}</div>
      <div class="nm"><b>${x.t.transportadora} ${k?'':'<span class="tag">Melhor opção</span>'}</b><span>${x.r.regiao}<span class="badge ${bcls}">${x.rv.txt}</span>${prazo?' · prazo '+fp(prazo):''}${x.rv.freq?' · saídas '+x.rv.freq:''}${bpNota}</span></div>
      <div class="val">${brl(x.total)}${dif}</div></div>
      <div class="det">${x.rv.op&&x.rv.op.length>1?`<label>Praça usada no cálculo</label><select data-t="${x.t.id}">${x.rv.op.map(o=>`<option value="${o.i}" ${o.i==x.rv.i?'selected':''}>${o.r.regiao}</option>`).join('')}</select>`:''}
      ${x.pT!==pt?`<div class="small" style="margin:8px 0">Peso taxado nesta transportadora: <b>${x.pT.toLocaleString('pt-BR')} kg</b> (isenta de cubagem até ${x.t.isentoCubM3.toLocaleString('pt-BR')} m³)</div>`:''}
      <table><tr><th>Componente</th><th>Base</th><th class="n">Valor</th></tr>
      ${x.it.map(i=>`<tr><td>${i.n}</td><td class="small">${i.d}</td><td class="n">${brl(i.v)}</td></tr>`).join('')}
      ${x.api?'':`<tr><td>Subtotal</td><td></td><td class="n">${brl(x.sub)}</td></tr>`}
      ${x.icms?`<tr><td>ICMS</td><td class="small">${x.al}% por dentro</td><td class="n">${brl(x.icms)}</td></tr>`:''}
      <tr class="tot"><td>Total</td><td></td><td class="n">${brl(x.total)}</td></tr></table></div></div>`;}).join('');
  if(!res.length) h+='<div class="na">Nenhuma tabela atende esse destino.</div>';
  if(nao.length) h+=`<div class="na">Sem cotação: ${nao.map(n=>`<b>${n.t.transportadora}</b> – ${n.msg}`).join('<br>')}</div>`;
  $('out').innerHTML=h+onStatus(onChave);
  $('out').querySelectorAll('.rh').forEach(e=>e.onclick=()=>e.parentNode.classList.toggle('open'));
  $('out').querySelectorAll('.det select').forEach(s=>{ s.onclick=e=>e.stopPropagation(); s.onchange=()=>{override[s.dataset.t]=+s.value;calc();}; });
  const b=$('out').querySelector('.r'); if(b) b.classList.add('open');
  const av=[];
  if(res.some(x=>x.rv.fonte==='man')) av.push('Bento Brasil e Braspress ainda não têm lista de cidades. Fora das capitais, confira a praça no detalhe de cada uma.');
  if(res.some(x=>x.t.id==='bp'&&/\((Exp|Imp)\)/.test(x.r.regiao))) av.push('Braspress tem duas tarifas para São Paulo capital, (Exp) e (Imp). O cálculo usa a (Exp) até confirmarmos qual vale para a Proloplast.');
  if(['PA','PI','AM','AP'].includes(uf)) av.push('Bento Brasil: PA5, PI3, Manaus, Macapá e Santana só com cotação prévia.');
  av.push('A coluna "Tonelada" das tabelas Trânsito Brasil e TJB não diz se o valor é excedente ou peso total. Use o seletor em "Regras" e confirme com um CT-e real.');
  $('avisos').innerHTML=av.map(a=>'• '+a).join('<br>');
}

document.querySelectorAll('#tonmode button').forEach(b=>b.onclick=()=>{tonMode=b.dataset.m;document.querySelectorAll('#tonmode button').forEach(x=>x.classList.toggle('on',x===b));calc();});
['simples','peso','nf','m3','c','l','a','qv','icms','dep','o_tde','o_tda','o_trt','o_ag','o_pal','doc_dest'].forEach(id=>$(id).addEventListener('input',calc));

// ---------- Cotação online nas transportadoras (API) ----------
const ONL={integ:[],res:null,pend:null,timer:null};
function reqOnline(peso,nf,m3){
  const cep=String(dest.cep||'').replace(/\D/g,'').padStart(8,'0');
  if(!dest.cep||cep.length!==8||!(peso>0)||!(nf>0)) return null;
  const c=+$('c').value, l=+$('l').value, a=+$('a').value, qv=+$('qv').value||1;
  return {cepDestino:cep,peso,vlrMercadoria:nf,volumes:qv,m3:(c*l*a>0)?null:m3,
    cubagem:c*l*a>0?[{comprimento:c,largura:l,altura:a,volumes:qv}]:[],cnpjDestinatario:$('doc_dest').value.replace(/\D/g,'')};
}
function agendarOnline(req,chave){
  if((ONL.res&&ONL.res.chave===chave)||ONL.pend===chave) return;
  clearTimeout(ONL.timer); ONL.pend=chave;
  ONL.timer=setTimeout(async()=>{
    let r;
    try{ r={...await api('/api/online/cotar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req)}),ok:true}; }
    catch(e){ r={ok:false,erro:e.message}; }
    if(ONL.pend!==chave) return;
    ONL.pend=null; ONL.res={...r,chave}; calc();
  },900);
}
function onStatus(chave){
  if(!ONL.integ.length||!chave) return '';
  const x=ONL.res&&ONL.res.chave===chave?ONL.res:null; if(!x) return '';
  if(!x.ok) return `<div class="na"><b>Cotação online</b> – ${esc(x.erro)} Valores pela tabela.</div>`;
  const f=x.resultados.filter(r=>!r.ok);
  return f.length?`<div class="na"><b>Cotação online indisponível</b> – ${f.map(r=>`${esc(r.transportadora)}: ${esc(r.erro)}`).join('<br>')}</div>`:'';
}
async function iniciarOnline(){
  try{ const s=await api('/api/online/status'); ONL.integ=s.integracoes.filter(i=>i.ativa); if(ONL.integ.length) calc(); }catch(e){ /* sem API */ }
}

// ---------- Navegação (menu lateral) ----------
const TITULOS={calc:'Calcular frete','bling-pedidos':'Bling · Pedidos','bling-propostas':'Bling · Propostas','bling-notas':'Bling · Notas fiscais','bling-produtos':'Bling · Produtos',
  hist:'Histórico de cotações',div:'Divergências',mkt:'Resultado no marketplace',tab:'Tabelas de frete',integ:'Integrações (APIs)',cfg:'Empresa remetente',json:'Modelo de dados'};
const SECOES=['calc','tab','ped','hist','div','integ','cfg','json','mkt'];
function irPara(p,carregar=true){
  if(!TITULOS[p]||(p==='mkt'&&carregar&&!PODE_MKT)) p='calc';
  const sec=p.startsWith('bling-')?'ped':p;
  SECOES.forEach(x=>$(x).classList.toggle('hide',x!==sec));
  document.querySelectorAll('#menu nav a').forEach(a=>a.classList.toggle('on',a.dataset.p===p));
  $('titulo').textContent=TITULOS[p]; document.body.classList.remove('menu-aberto');
  if(('#'+p)!==location.hash) history.replaceState(null,'','#'+p);
  if(!carregar) return;
  if(sec==='ped') mudarRecurso(p.slice(6)); else if(p==='hist') carregarHistorico(); else if(p==='div') analiseDivergencias();
  else if(p==='integ') carregarIntegracoes(); else if(p==='mkt') carregarMkt(); else if(p==='cfg') carregarConfig();
  window.scrollTo(0,0);
}
document.querySelectorAll('#menu a').forEach(a=>a.onclick=e=>{ e.preventDefault(); irPara(a.dataset.p); });
window.addEventListener('hashchange',()=>irPara(location.hash.slice(1)));
$('abrir_menu').onclick=()=>document.body.classList.add('menu-aberto'); $('veu').onclick=()=>document.body.classList.remove('menu-aberto');
const fmtCnpj=c=>String(c||'').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5');

// ---------- Integrações ----------
async function carregarIntegracoes(){
  $('i_lista').innerHTML='<div class="small">Carregando…</div>';
  try{ const s=await api('/api/online/status'); const rm=s.remetente||{};
    $('i_rem').innerHTML=`Cotações online saem em nome de <b>${esc(rm.nome||fmtCnpj(rm.cnpj)||'—')}</b>${rm.cnpj?' ('+fmtCnpj(rm.cnpj)+')':''}, origem CEP ${fmtCep(+rm.cep||0)}${rm.cepPresumido?' (presumido)':''}. <a href="#cfg">Alterar</a>`;
    $('i_lista').innerHTML=s.integracoes.map(i=>{
      const pill=!i.configurada?(i.erroConfig?'<span class="pill err">erro na configuração</span>':'<span class="pill off">não configurada</span>'):i.ativa?'<span class="pill ok">ativa</span>':'<span class="pill off">desativada</span>';
      const tipo=i.tipo==='ssw'?'Web service SSW':i.tipo==='braspress'?'API própria da Braspress':esc(i.tipo);
      const tab=i.tabela?(TABELAS.find(t=>t.id===i.tabela)||{}).transportadora:null;
      if(!i.configurada) return `<div class="integ"><h3>${esc(i.transportadora||(i.tipo==='ssw'?'Transportadoras SSW':i.tipo))}${pill}</h3><div class="tp">${tipo}</div>
        <p class="small">${i.erroConfig?esc(i.erroConfig):i.tipo==='ssw'?'Nenhuma transportadora SSW cadastrada. Veja abaixo como incluir.':'Sem credenciais no Cloudflare.'}</p></div>`;
      const u=i.ultima;
      return `<div class="integ"><h3>${esc(i.transportadora)}${pill}</h3><div class="tp">${tipo}${tab?' · compara com a tabela '+esc(tab):' · sem tabela própria'}</div>
        <dl><dt>Consultas (30 dias)</dt><dd>${i.consultas30}${i.consultas30?` · ${Math.round(i.sucesso30/i.consultas30*100)}% com sucesso`:''}</dd>
        <dt>Tempo médio</dt><dd>${i.msMedio!=null?(i.msMedio/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})+' s':'—'}</dd>
        <dt>Última consulta</dt><dd>${u?`${horaBR(u.em)}${u.teste?' (teste)':''} · ${u.ok?'<span class="ok">ok</span>':'<span class="err">'+esc(u.erro)+'</span>'}`:'—'}</dd></dl>
        <div class="acoes"><label class="chk" style="margin:0"><input type="checkbox" data-ativa="${esc(i.id)}" ${i.ativa?'checked':''}> Usar cotação online</label>
        <button class="btn btn2 btn-mini" data-testar="${esc(i.id)}">Testar conexão</button></div><div class="teste small" id="t_${esc(i.id)}"></div></div>`; }).join('');
    $('i_lista').querySelectorAll('[data-ativa]').forEach(c=>c.onchange=async()=>{ c.disabled=true;
      try{ await api('/api/online/ativar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:c.dataset.ativa,ativa:c.checked})}); ONL.res=null; await iniciarOnline(); carregarIntegracoes(); }
      catch(e){ alert('Erro: '+e.message); c.disabled=false; } });
    $('i_lista').querySelectorAll('[data-testar]').forEach(b=>b.onclick=async()=>{ const el=$('t_'+b.dataset.testar); b.disabled=true; el.textContent='Consultando (São Paulo/SP, 50 kg, NF R$ 1.000)…';
      try{ const r=await api('/api/online/testar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:b.dataset.testar})});
        el.innerHTML=r.ok?`<span class="ok">Conexão ok</span>: ${brl(r.total)}${r.prazo?' · '+fp(r.prazo):''}${r.id?' · cotação nº '+esc(r.id):''} (${(r.ms/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})} s)`:`<span class="err">Falhou</span>: ${esc(r.erro)}`; }
      catch(e){ el.innerHTML='<span class="err">'+esc(e.message)+'</span>'; } finally{ b.disabled=false; } });
  }catch(e){ $('i_lista').innerHTML='<div class="small err">Erro: '+esc(e.message)+'</div>'; }
}

// ---------- Resultado no marketplace (quanto recebemos de fato por produto) ----------
const hojeISO=()=>new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10);
const diasAtras=n=>new Date(Date.now()-n*864e5-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10);
const n2=(v,c=2)=>(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:c,maximumFractionDigits:c});
let MKT=null, PODE_MKT=false;
document.querySelectorAll('#mkt [data-dias]').forEach(b=>b.onclick=()=>{ $('m_de').value=diasAtras(+b.dataset.dias); $('m_ate').value=hojeISO(); carregarMkt(); });
['m_de','m_ate','m_canal','m_ipi'].forEach(id=>$(id).addEventListener('change',()=>carregarMkt()));
$('m_fixos_btn').onclick=()=>{ $('m_fixos').classList.toggle('hide'); if(!$('m_fixos').classList.contains('hide')) carregarFixos(); };
async function carregarMkt(){
  if(!$('m_de').value){ $('m_de').value=diasAtras(30); $('m_ate').value=hojeISO(); }
  $('m_out').innerHTML='<div class="card small">Calculando…</div>';
  try{ const q=new URLSearchParams({de:$('m_de').value,ate:$('m_ate').value,canal:$('m_canal').value,ipi:$('m_ipi').checked?'1':'0'});
    MKT=await api('/api/marketplace?'+q); desenharMkt(); }
  catch(e){ $('m_out').innerHTML='<div class="card small err">Erro: '+esc(e.message)+'</div>'; }
}
function desenharMkt(){
  const d=MKT, r=d.resumo, canal=d.canal==='marketplace'?'marketplaces':d.canal;
  if(!r.pedidos){ $('m_out').innerHTML=`<div class="card small">Nenhum pedido de ${esc(canal)} importado entre ${dataBR(d.periodo.de)} e ${dataBR(d.periodo.ate)}.</div>`; return; }
  const pc=v=>r.total>0?(v/r.total*100):0;
  const fatias=[['Comissão',r.comissao,'f-com'],['Frete',r.frete,'f-fre'],...(d.descontarIpi?[['IPI',r.ipi,'f-ipi']]:[]),['Mercadoria',r.base,'f-mer']];
  const kpi=(t,v,sub='')=>`<div class="kpi"><span>${t}</span><b>${v}</b>${sub?`<small>${sub}</small>`:''}</div>`;
  const maxKg=Math.max(...d.produtos.filter(p=>!p.fixo).map(p=>p.porKg||0),0.01);
  $('m_out').innerHTML=`
  ${d.avisos.length?`<div class="mkt-aviso small">${d.avisos.map(a=>'• '+esc(a)).join('<br>')}</div>`:''}
  <div class="kpis">
    ${kpi('Pedidos',r.pedidos,`${dataBR(d.periodo.de)} a ${dataBR(d.periodo.ate)}`)}
    ${kpi('Vendido',brl(r.total))}
    ${kpi('Comissão + frete',brl(r.comissao+r.frete),`${n2(r.pctRetido,1)}% do vendido`)}
    ${kpi('Líquido a receber',brl(r.liquido))}
    ${kpi(d.descontarIpi?'Mercadoria (sem IPI)':'Mercadoria',brl(r.base),`${n2(pc(r.base),1)}% do vendido`)}
    ${kpi('Peso vendido',n2(r.peso,1)+' kg')}
    ${kpi('Recebido por kg',r.porKg!=null?brl(r.porKg):'—','mercadoria ÷ peso')}
  </div>
  <div class="card"><h2>De cada R$ 100 vendidos no ${esc(canal)}</h2>
    <div class="faixa-leg small">${fatias.map(([n,v,c])=>`<span><i class="${c}"></i>${n}: R$ ${n2(pc(v))} (${brl(v)})</span>`).join('')}</div>
    <div class="faixa">${fatias.map(([n,v,c])=>`<div class="${c}" style="flex:${Math.max(pc(v),0.5)}" title="${n}: ${brl(v)} (R$ ${n2(pc(v))} de cada R$ 100)">${pc(v)>=6?`<span>${n}<br><b>R$ ${n2(pc(v))}</b></span>`:''}</div>`).join('')}</div></div>
  <div class="card"><div class="hist-top"><h2 style="margin:0">Por produto (componentes dos kits)</h2><button class="btn btn2 btn-mini" id="m_csv">Baixar planilha (CSV)</button></div>
    <p class="small">Valor recebido rateado pelo peso de cada componente${d.fixos.length?'; itens com valor fixo ficam com o valor configurado':''}. "% do preço" compara o recebido por unidade com o preço de cadastro no Bling.</p>
    <div class="tbl-wrap"><table><tr><th>Código</th><th>Produto</th><th class="n">Pedidos</th><th class="n">Quantidade</th><th class="n">Peso</th><th class="n">Recebido</th><th class="n">Por unidade</th><th>Por kg</th><th class="n">Preço cadastro</th><th class="n">% do preço</th></tr>
    ${d.produtos.map(p=>`<tr><td>${esc(p.codigo||'')}</td><td>${esc(p.nome||'')}${p.fixo?' <span class="badge b-tab">valor fixo</span>':''}</td><td class="n">${p.pedidos}</td><td class="n">${n2(p.qtd,0)}</td>
      <td class="n">${p.peso>0?n2(p.peso,2)+' kg':'<span class="aviso">sem peso</span>'}</td><td class="n">${brl(p.valor)}</td><td class="n">${p.porUnidade!=null?'R$ '+n2(p.porUnidade,4):'—'}</td>
      <td class="barra">${p.porKg!=null&&!p.fixo?`<div><i style="width:${Math.round(p.porKg/maxKg*100)}%"></i></div><span>${brl(p.porKg)}</span>`:'—'}</td>
      <td class="n">${p.preco!=null?'R$ '+n2(p.preco,4):'—'}</td><td class="n ${p.pctPreco!=null&&p.pctPreco<100?'dif-pos':''}">${p.pctPreco!=null?n2(p.pctPreco,1)+'%':'—'}</td></tr>`).join('')}</table></div></div>
  <div class="card"><h2>Por anúncio (produto vendido)</h2>
    <div class="tbl-wrap"><table><tr><th>Código</th><th>Produto vendido</th><th class="n">Vendas</th><th class="n">Qtd.</th><th class="n">Vendido</th><th class="n">Recebido (mercadoria)</th><th class="n">% recebido</th><th class="n">Recebido por unidade</th><th class="n">Peso</th><th class="n">Por kg</th></tr>
    ${d.anuncios.map(a=>`<tr><td>${esc(a.codigo||'')}</td><td>${esc(a.nome||'')}${a.kit?' <span class="canal canal-mk">kit</span>':''}</td><td class="n">${a.vendas}</td><td class="n">${n2(a.qtd,0)}</td>
      <td class="n">${brl(a.total)}</td><td class="n">${brl(a.liquido)}</td><td class="n">${a.pctRecebido!=null?n2(a.pctRecebido,1)+'%':'—'}</td><td class="n">${a.liquidoPorVenda!=null?brl(a.liquidoPorVenda):'—'}</td>
      <td class="n">${a.peso>0?n2(a.peso,2)+' kg':'—'}</td><td class="n">${a.porKg!=null?brl(a.porKg):'—'}</td></tr>`).join('')}</table></div></div>
  <div class="card"><h2>Pedidos (${d.pedidos.length}${r.pedidos>d.pedidos.length?' de '+r.pedidos:''})</h2><p class="small">Clique num pedido para ver o rateio por componente.</p>
    <div class="tbl-wrap"><table id="m_ped"><tr><th>Nº</th><th>Nº loja</th><th>Data</th><th>Cliente</th><th class="n" title="Valor base no marketplace (o que o comprador pagou)">Vendido</th><th class="n">Comissão</th><th class="n">Frete</th><th class="n">IPI</th><th class="n">Líquido</th><th class="n">Mercadoria</th></tr>
    ${d.pedidos.map((p,i)=>`<tr class="lin" data-i="${i}"><td>${esc(p.numero)}</td><td class="small">${esc(p.numero_loja||'')}</td><td>${dataBR(p.data)}</td><td>${esc(p.cliente||'')}</td>
      <td class="n">${brl(+p.total)}${Math.abs(+p.total_bling-+p.total)>0.01?`<br><span class="small" title="Total do pedido no Bling (preço de lista + IPI)">Bling: ${brl(+p.total_bling)}</span>`:''}</td><td class="n">${brl(+p.comissao)}</td><td class="n">${brl(+p.frete)}</td><td class="n">${brl(+p.ipi)}</td><td class="n">${brl(p.liquido)}</td><td class="n">${brl(p.base)}</td></tr>`).join('')}</table></div></div>`;
  $('m_ped').querySelectorAll('tr.lin').forEach(tr=>tr.onclick=()=>{
    const nx=tr.nextElementSibling; if(nx&&nx.classList.contains('comp')){ nx.remove(); return; }
    const p=d.pedidos[+tr.dataset.i];
    tr.insertAdjacentHTML('afterend',`<tr class="comp"><td></td><td colspan="9">${p.aviso?`<span class="small aviso">${esc(p.aviso)}</span>`:`<table class="mini"><tr><th>Componente</th><th class="n">Qtd.</th><th class="n">Peso</th><th>Rateio</th><th class="n">Recebido</th><th class="n">Por unidade</th><th class="n">Por kg</th></tr>
      ${p.componentes.map(c=>`<tr><td>${esc(c.codigo||'')} ${esc(c.nome||'')}</td><td class="n">${n2(c.qtd,0)}</td><td class="n">${c.peso>0?n2(c.peso,3)+' kg':'—'}</td><td class="small">${c.rateio==='fixo'?'valor fixo':c.rateio==='peso'?'pelo peso':c.rateio==='sem peso'?'<span class="aviso">sem peso: fora do rateio</span>':'pela quantidade'}</td>
        <td class="n">${brl(c.valor)}</td><td class="n">${c.qtd>0?'R$ '+n2(c.valor/c.qtd,4):'—'}</td><td class="n">${c.peso>0&&!c.fixo?brl(c.valor/c.peso):'—'}</td></tr>`).join('')}</table>`}</td></tr>`); });
  $('m_csv').onclick=()=>{
    const cols=['pedido','numero_loja','data','cliente','vendido','comissao','frete','ipi','liquido','mercadoria','item','componente_codigo','componente','quantidade','peso_kg','rateio','recebido','recebido_unidade','recebido_kg'];
    const cel=v=>{ v=v==null?'':String(v); if(/^-?\d+(\.\d+)?$/.test(v)) v=v.replace('.',','); return /[;"\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
    const L=[]; d.pedidos.forEach(p=>(p.componentes.length?p.componentes:[{}]).forEach(c=>L.push([p.numero,p.numero_loja,String(p.data).slice(0,10),p.cliente,p.total,p.comissao,p.frete,p.ipi,p.liquido,p.base,c.item,c.codigo,c.nome,c.qtd,c.peso,c.rateio,c.valor,c.qtd?(c.valor/c.qtd).toFixed(4):'',c.peso&&!c.fixo?(c.valor/c.peso).toFixed(2):''])));
    const csv='﻿'+cols.join(';')+'\n'+L.map(l=>l.map(cel).join(';')).join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=`resultado-${d.canal}-${d.periodo.de}-a-${d.periodo.ate}.csv`.replace(/\s+/g,'-'); a.click(); };
}
async function carregarFixos(){
  $('m_fixos').innerHTML='<span class="small">Carregando…</span>';
  try{ const j=await api('/api/marketplace/fixos');
    const conv=f=>({termo:f.termo??f.codigo??'',valor:f.valor,produtos:f.produtos||(f.produto_id?[{id:f.produto_id,codigo:f.codigo,nome:f.nome}]:null)});
    let L=j.fixos.map(conv), salvo=true;
    const achados=f=>f.produtos==null?'<span class="small">(salve para localizar)</span>':!f.produtos.length?'<span class="small aviso">nenhum produto encontrado</span>':
      `<span class="small">${f.produtos.length} produto(s): ${f.produtos.slice(0,4).map(p=>esc((p.codigo?p.codigo+' – ':'')+p.nome)).join('; ')}${f.produtos.length>4?'…':''}</span>`;
    const desenhar=()=>{ $('m_fixos').innerHTML=`<h2>Itens com valor fixo</h2><p class="small">Componentes que recebem um valor fixo por unidade em vez de entrar no rateio pelo peso (ex.: lacre a R$ 0,18). Informe o <b>código</b> do produto no Bling ou <b>parte do nome</b> (ex.: "KIT LACRE FRONTEC" pega todas as variações).</p>
      <table class="mini" style="max-width:820px"><tr><th>Código ou nome</th><th class="n">Valor por unidade (R$)</th><th>Produtos encontrados</th><th></th></tr>
      ${L.map((f,i)=>`<tr><td><input data-c="${i}" value="${esc(f.termo)}" style="min-width:220px"></td><td><input data-v="${i}" value="${String(f.valor).replace('.',',')}" inputmode="decimal" style="text-align:right;max-width:110px"></td><td>${achados(f)}</td><td><a href="#" class="small" data-r="${i}">remover</a></td></tr>`).join('')}</table>
      <div class="acoes" style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button class="btn btn2 btn-mini" id="mf_add">Adicionar</button>
      ${j.sugestoes.filter(x=>!L.some(f=>f.termo===x.termo||(f.produtos||[]).some(p=>String(p.id)===x.id))).map((x,k)=>`<button class="btn btn2 btn-mini" data-sug="${k}">+ ${esc(x.nome)} a R$ 0,18</button>`).join('')}
      <button class="btn" id="mf_salvar">Salvar e recalcular</button><span class="small" id="mf_st"></span></div>`;
      $('m_fixos').querySelectorAll('[data-c]').forEach(e=>e.oninput=()=>{ L[+e.dataset.c].termo=e.value.trim(); L[+e.dataset.c].produtos=null; });
      $('m_fixos').querySelectorAll('[data-v]').forEach(e=>e.oninput=()=>L[+e.dataset.v].valor=e.value);
      $('m_fixos').querySelectorAll('[data-r]').forEach(e=>e.onclick=ev=>{ ev.preventDefault(); L.splice(+e.dataset.r,1); desenhar(); });
      const sug=j.sugestoes.filter(x=>!L.some(f=>f.termo===x.termo||(f.produtos||[]).some(p=>String(p.id)===x.id)));
      $('m_fixos').querySelectorAll('[data-sug]').forEach(e=>e.onclick=()=>{ const x=sug[+e.dataset.sug]; L.push({termo:x.termo,valor:'0,18',produtos:null}); desenhar(); });
      $('mf_add').onclick=()=>{ L.push({termo:'',valor:'',produtos:null}); desenhar(); };
      $('mf_salvar').onclick=async()=>{ try{ const r=await api('/api/marketplace/fixos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixos:L.map(f=>({termo:f.termo,valor:f.valor}))})});
        L=r.fixos.map(conv); desenhar(); $('mf_st').innerHTML=r.fixos.some(f=>!f.produtos.length)?'<span class="aviso">Salvo, mas algum código ou nome não foi encontrado nos produtos importados.</span>':'<span class="ok">Salvo.</span>'; carregarMkt(); }
        catch(e){ $('mf_st').innerHTML='<span class="err">'+esc(e.message)+'</span>'; } };
    };
    desenhar();
  }catch(e){ $('m_fixos').innerHTML='<span class="small err">'+esc(e.message)+'</span>'; }
}

// ---------- Configurações: empresa remetente ----------
async function carregarConfig(){
  $('c_status').textContent='';
  try{ const c=await api('/api/config'); preencherConfig(c); }catch(e){ $('c_info').innerHTML='<span class="err">'+esc(e.message)+'</span>'; }
}
function preencherConfig(c){
  const L=c.remetentes||[], rm=c.remetente||{};
  $('c_cnpj').innerHTML=L.length?L.map(x=>`<option value="${x.cnpj}" ${x.cnpj===rm.cnpj?'selected':''}>${esc(x.nome||'CNPJ')} – ${fmtCnpj(x.cnpj)}${x.cidade?' ('+esc(x.cidade)+'/'+esc(x.uf)+')':''}</option>`).join(''):'<option value="">Nenhum CNPJ nas credenciais das transportadoras</option>';
  $('c_cep').value=c.cfg&&c.cfg.cep?fmtCep(+c.cfg.cep):'';
  const sel=()=>L.find(x=>x.cnpj===$('c_cnpj').value)||{};
  const info=()=>{ const x=sel(); $('c_cep').placeholder=x.cep?fmtCep(+x.cep)+' (do cadastro do CNPJ)':'92480-000';
    $('c_info').innerHTML=`Em uso: <b>${esc(rm.nome||'—')}</b>, origem ${fmtCep(+rm.cep||0)}${rm.cepPresumido?' (presumida: o cadastro do CNPJ não foi encontrado)':''}${rm.configurado?'':' · escolhido automaticamente (CNPJ de Nova Santa Rita)'}. Deixe o CEP em branco para usar o do cadastro do CNPJ.`; };
  $('c_cnpj').onchange=info; info();
}
$('c_salvar').onclick=async()=>{ $('c_salvar').disabled=true;
  try{ const c=await api('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cnpj:$('c_cnpj').value,cep:$('c_cep').value})});
    preencherConfig(c); $('c_status').innerHTML='<span class="ok">Salvo.</span>'; ONL.res=null; calc(); }
  catch(e){ $('c_status').innerHTML='<span class="err">'+esc(e.message)+'</span>'; } finally{ $('c_salvar').disabled=false; } };

$('tsel').innerHTML=TABELAS.map(t=>`<option value="${t.id}">${t.transportadora}</option>`).join('');
function renderTab(){
  const t=TABELAS.find(x=>x.id===$('tsel').value);
  const nc={tb:D.tbmap.length,tjb:D.tjmap.length,rte:D.rtemap.length,sm:D.smmap.length}[t.mapa]||0;
  let kv=[['Arquivo de origem',t.fonte],['Origem',t.origem],['Vigência',t.vigencia],['Modelo de cálculo',t.modelo==='taxaKg'?'Taxa fixa + peso × R$/kg + % NF':t.modelo==='pctNF'?'Maior entre frete mínimo, % da NF e peso × R$/kg mínimo':t.modelo==='kg'?'R$/kg × peso taxado, com frete mínimo':t.acima==='kg'?`Faixas até ${t.limites.at(-1)} kg; acima, peso × R$/kg`:'Faixas de peso + tonelada'],['Lista de cidades',nc?`${nc} cidades${['tb','rte','sm'].includes(t.mapa)?' com faixa de CEP e prazo':''}`:'não recebida'],['Cubagem',t.cubagem+' kg/m³'],['Pedágio',brl(t.pedagio)+' por fração de 100 kg']];
  if(t.gris&&t.gris.pct) kv.push(['GRIS',t.gris.pct+'% NF'+(t.gris.acimaNF?` (${t.gris.pctAcima}% para NF acima de ${brl(t.gris.acimaNF)})`:'')+(t.gris.porUf?' · '+Object.keys(t.gris.porUf).join(', ')+': '+Object.values(t.gris.porUf)[0]+'%':'')+(t.gris.min?' · mín. '+brl(t.gris.min):'')]);
  (t.especiais||[]).forEach(e=>kv.push([e.nome,e.faixas.map(f=>(f[0]>=1e9?'acima':'até '+f[0]+' kg')+': '+brl(f[1])).join(' · ')]));
  (t.infos||[]).forEach(x=>kv.push(['Observação',x]));
  if(t.isentoCubM3) kv.push(['Isenção de cubagem','até '+t.isentoCubM3.toLocaleString('pt-BR')+' m³']);
  if(t.acrescimoKg) kv.push(['Acréscimo no frete quilo',t.acrescimoKg.map(([l,p])=>`+${p}% a partir de ${l} kg`).join(' · ')]);
  if(t.pedagioUf) kv.push(['Pedágio por UF',Object.entries(t.pedagioUf).map(([u,v])=>u+': '+brl(v)).join(' · ')]);
  if(t.zonaRestricao) kv.push([t.zonaRestricao.nome,'por faixa de peso, '+brl(t.zonaRestricao.faixas[0][1])+' a '+brl(t.zonaRestricao.faixas.at(-1)[1])+' (pelo CEP)']);
  if(t.zonaRisco) kv.push([t.zonaRisco.nome,brl(t.zonaRisco.valor)+' (pelo CEP)']);
  if(t.txcid!==false&&t.mapa==='rte') kv.push(['Taxas de entrega por cidade',Object.keys(D.txcid).length+' cidades']);
  if(t.advalorem) kv.push(['Ad valorem',t.advalorem.pct+'% NF (no frete mínimo, só para NF acima de R$ 1.000)']);
  (t.fixas||[]).forEach(x=>kv.push([x.nome,brl(x.valor)+(x.ufs?' – só '+x.ufs.join(', '):'')+(x.pesoAcima?' – acima de '+x.pesoAcima+' kg':'')]));
  (t.pctFrete||[]).forEach(x=>kv.push([x.nome,x.pct+'% s/ frete'+(x.min?' (mín. '+brl(x.min)+')':'')+(x.uf?' – só '+x.uf:'')]));
  (t.pctSubtotal||[]).forEach(x=>kv.push([x.nome,x.pct+'% s/ subtotal do frete']));
  (t.opcionais||[]).forEach(x=>kv.push([x.nome+' (eventual)',x.porUf?Object.entries(x.porUf).map(([u,v])=>`${u}: ${v[0]}% (mín. ${brl(v[1])})`).join(' · '):x.valor?brl(x.valor):x.pct+'% (mín. '+brl(x.min)+')']));
  let h='<div class="kv">'+kv.map(([a,b])=>`<div>${a}</div><div>${b}</div>`).join('')+'</div><div class="tbl-wrap"><table>';
  if(t.modelo==='pctNF'){ h+='<tr><th>Praça</th><th class="n">Frete mínimo</th><th class="n">% da NF</th><th class="n">Mínimo R$/kg</th><th class="n">Limite NF</th></tr>';
    h+=t.rotas.map(r=>`<tr><td>${r.regiao}</td><td class="n">${brl(r.fmin)}</td><td class="n">${r.pct.toLocaleString('pt-BR')}%</td><td class="n">${brl(r.minKg)}</td><td class="n">${brl(r.limNF)}</td></tr>`).join(''); }
  else if(t.modelo==='taxaKg'){ h+='<tr><th>Praça</th><th>Unidades</th><th class="n">Taxa</th><th class="n">R$/kg</th><th class="n">% NF</th></tr>';
    h+=t.rotas.map(r=>`<tr><td>${r.regiao}</td><td class="small">${r.unidades}</td><td class="n">${brl(r.taxa)}</td><td class="n">${r.kg.toLocaleString('pt-BR',{minimumFractionDigits:3})}</td><td class="n">${r.fvPct.toLocaleString('pt-BR')}%</td></tr>`).join(''); }
  else if(t.modelo==='faixas'){ const kg=t.acima==='kg';
    h+=`<tr><th>Região</th>${t.limites.map(l=>`<th class="n">até ${l} kg</th>`).join('')}<th class="n">${kg?'R$/kg acima':'Tonelada'}</th><th class="n">Frete valor</th>${kg?'<th class="n">TXA</th>':''}</tr>`;
    h+=t.rotas.map(r=>`<tr><td>${r.regiao}</td>${r.faixas.map(v=>`<td class="n">${brl(v)}</td>`).join('')}<td class="n">${brl(kg?r.fpk:r.ton)}</td><td class="n">${r.fvPct.toLocaleString('pt-BR')}%</td>${kg?`<td class="n">${r.txa?brl(r.txa):r.txaKg?brl(r.txaKg)+'/kg':'–'}</td>`:''}</tr>`).join(''); }
  else { h+='<tr><th>UF</th><th>Região</th><th class="n">R$/kg</th><th class="n">Frete mínimo</th><th class="n">Prazo (dias úteis)</th></tr>';
    h+=t.rotas.map(r=>`<tr><td>${r.uf}</td><td>${r.regiao}</td><td class="n">${brl(r.tarifaKg)}</td><td class="n">${brl(r.minimo)}</td><td class="n">${r.prazo}</td></tr>`).join(''); }
  $('tview').innerHTML=h+'</table></div>';
}
$('tsel').onchange=renderTab;
$('js').textContent=JSON.stringify(TABELAS,null,1);
$('cp').onclick=()=>navigator.clipboard.writeText(JSON.stringify(TABELAS,null,1)).then(()=>$('cpok').textContent='Copiado.').catch(()=>$('cpok').textContent='Não foi possível copiar; selecione o texto abaixo.');
// ---------- API: usuário, salvar cotação e histórico ----------
const fmtCep=n=>n?String(n).padStart(8,'0').replace(/(\d{5})(\d{3})/,'$1-$2'):'';
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path,opt){ const r=await fetch(path,opt); let j=null; try{ j=await r.json(); }catch(e){}
  if(!r.ok) throw new Error((j&&j.erro)||('HTTP '+r.status)); return j; }
api('/api/eu').then(async j=>{ API_OK=true; $('usuario').textContent=j.usuario; PODE_MKT=!!(j.permissoes&&j.permissoes.resultadoMarketplace); document.querySelectorAll('#menu .mk').forEach(e=>e.classList.toggle('hide',!PODE_MKT)); calc(); await iniciarBling(); iniciarOnline(); const p=location.hash.slice(1); if(p&&p!=='calc') irPara(p); })
  .catch(()=>{ API_OK=false; });
$('s_btn').onclick=async()=>{
  if(!ULT||!ULT.res.length) return;
  const b=$('s_btn'); b.disabled=true; $('s_status').className='small'; $('s_status').textContent='Salvando…';
  const corpo={cliente:$('s_cliente').value.trim(),pedido:$('s_pedido').value.trim(),observacao:$('s_obs').value.trim(),
    cep:fmtCep(dest.cep),cidade:dest.cidade||'',uf:ULT.uf,peso_real:ULT.peso,peso_taxado:ULT.pt,valor_nf:ULT.nf,
    volumes:+$('qv').value||null,m3:ULT.m3,com_icms:ULT.icms,regra_tonelada:tonMode,versao_app:VERSAO,
    resultados:ULT.res.map(x=>({transportadora:x.t.transportadora,praca:x.r.regiao,fonte_praca:x.rv.txt,total:+x.total.toFixed(2),
      prazo:String(x.rv.prazo||x.r.prazo||''),peso_taxado:x.pT,subtotal:+x.sub.toFixed(2),icms:+x.icms.toFixed(2),
      itens:x.it.map(i=>({n:i.n,v:+i.v.toFixed(2),d:i.d})),
      ...(x.on?{fonte_valor:x.on.fonte,valor_online:x.on.online,valor_tabela:x.on.tabela,praca_tabela:x.on.praca_tabela,cotacao_online:x.on.id,erro_online:x.on.erro}:{})})),
    sem_cotacao:ULT.nao.map(n=>({transportadora:n.t.transportadora,motivo:n.msg}))};
  const esc_=ULT.res[+$('s_transp').value||0];
  corpo.transportadora_escolhida=esc_.t.transportadora; corpo.valor_escolhido=+esc_.total.toFixed(2);
  corpo.valores_manuais=MAN_PEND;
  if(BLING_PED&&corpo.pedido===BLING_PED.numero) corpo[{proposta:'bling_proposta_id',nota:'bling_nota_id'}[BLING_PED.tipo]||'bling_pedido_id']=BLING_PED.id;
  try{ const j=await api('/api/cotacoes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(corpo)});
    $('s_status').className='small ok'; $('s_status').textContent=`Cotação nº ${j.id} salva${j.valores_manuais?` com ${j.valores_manuais} valor(es) manual(is)`:''}.`; SALVA={id:j.id,chave:chaveCalc()}; MAN_GRAV=MAN_PEND.map(m=>({...m})); MAN_PEND=[]; desenharListaPend();
  }catch(e){ $('s_status').className='small err'; $('s_status').textContent='Não foi possível salvar: '+e.message; }
  finally{ b.disabled=false; }
};
$('s_transp').onchange=()=>{ const o=$('s_transp').selectedOptions[0]; $('s_transp').dataset.escolhida=o?o.dataset.n:''; };
$('s_copiar').onclick=async()=>{
  if(!ULT||!ULT.res.length) return;
  const x=ULT.res[+$('s_transp').value||0], v=x.total.toFixed(2).replace('.',',');
  try{ await navigator.clipboard.writeText(v); $('s_status').className='small ok';
    $('s_status').textContent=`Valor ${v} (${x.t.transportadora}) copiado. Cole no campo Frete do pedido no Bling.`; }
  catch(e){ $('s_status').className='small'; $('s_status').textContent=`Valor do frete: ${v} (${x.t.transportadora}). Selecione e copie.`; }
};


// ---------- Valor cotado manualmente (divergências) ----------
let MOTIVOS=['Não identificado','Tabela desatualizada / reajuste','Taxa não prevista (TDE, TDA, agendamento…)','Praça ou cidade diferente','ICMS','Peso ou cubagem diferente','Valor da NF diferente','Desconto ou negociação','Outro'];
const difTxt=(man,calc)=>{ if(!(calc>0)) return '<span class="small">sistema não cotou</span>'; const d=man-calc, pc=d/calc*100;
  return `<span class="${d>0.01?'dif-pos':d<-0.01?'dif-neg':''}">${d>0?'+':''}${brl(d)} (${d>0?'+':''}${pc.toLocaleString('pt-BR',{maximumFractionDigits:1})}%)</span>`; };
// Desenha o formulário; opcoes = [{nome, calc}] ; aoAdicionar(valor) devolve Promise
function formManual(el,opcoes,aoAdicionar){
  el.innerHTML=`<div class="mform">
    <div><label>Transportadora</label><select class="mf_t">${opcoes.map((o,i)=>`<option value="${i}">${esc(o.nome)}${o.calc>0?' – calculado '+brl(o.calc):' – sem cálculo'}</option>`).join('')}</select></div>
    <div><label>Valor informado (R$)</label><input class="mf_v" inputmode="decimal" placeholder="0,00"></div>
    <div><label>Prazo</label><input class="mf_p" maxlength="30" placeholder="dias"></div>
    <div><label>Referência</label><input class="mf_r" maxlength="80" placeholder="nº da cotação, CT-e…"></div>
    <div><label>Motivo provável</label><select class="mf_m">${MOTIVOS.map(m=>`<option>${esc(m)}</option>`).join('')}</select></div>
    <div class="mf_obs"><label>Observação</label><input class="mf_o" maxlength="500" placeholder="ex.: cobrou TDE de R$ 45"></div>
    <div class="mf_acao"><button class="btn btn2 mf_b" type="button">Adicionar</button></div></div>
    <div class="small mf_dif"></div>`;
  const q=c=>el.querySelector(c), val=()=>+String(q('.mf_v').value).replace(/\./g,'').replace(',','.')||0;
  const mostrar=()=>{ const o=opcoes[+q('.mf_t').value]; q('.mf_dif').innerHTML=val()>0&&o?'Diferença para o calculado: '+difTxt(val(),o.calc):''; };
  q('.mf_v').addEventListener('input',mostrar); q('.mf_t').onchange=mostrar;
  q('.mf_b').onclick=async()=>{
    const o=opcoes[+q('.mf_t').value];
    if(!o||!(val()>0)){ q('.mf_dif').innerHTML='<span class="err">Informe a transportadora e o valor.</span>'; return; }
    q('.mf_b').disabled=true;
    try{ await aoAdicionar({transportadora:o.nome,valor_calculado:o.calc||null,valor_manual:val(),prazo_manual:q('.mf_p').value.trim(),
        referencia:q('.mf_r').value.trim(),motivo:q('.mf_m').value,observacao:q('.mf_o').value.trim()});
      ['.mf_v','.mf_p','.mf_r','.mf_o'].forEach(c=>q(c).value=''); q('.mf_dif').innerHTML=''; }
    catch(e){ q('.mf_dif').innerHTML='<span class="err">'+esc(e.message)+'</span>'; }
    finally{ q('.mf_b').disabled=false; }
  };
}
function tabelaManuais(L,remover){
  if(!L.length) return '';
  return `<table class="mini mt"><tr><th>Transportadora</th><th class="n">Calculado</th><th class="n">Informado</th><th class="n">Diferença</th><th>Prazo</th><th>Motivo</th><th>Referência / observação</th><th></th></tr>`+
    L.map((m,i)=>`<tr><td>${esc(m.transportadora)}</td><td class="n">${+m.valor_calculado>0?brl(+m.valor_calculado):'—'}</td><td class="n">${brl(+m.valor_manual)}</td>
      <td class="n">${difTxt(+m.valor_manual,+m.valor_calculado)}</td><td>${esc(m.prazo_manual||'')}</td><td class="small">${esc(m.motivo||'')}</td>
      <td class="small">${esc([m.referencia,m.observacao].filter(Boolean).join(' · '))}${m.usuario?`<br>${esc(m.usuario)}`:''}</td>
      <td>${remover?`<a href="#" class="small m_rem" data-i="${i}">remover</a>`:''}</td></tr>`).join('')+'</table>';
}
let MAN_PEND=[], SALVA=null, MAN_GRAV=[];
const chaveCalc=()=>ULT?JSON.stringify([dest.cep,dest.cidade,ULT.peso,ULT.nf,ULT.res.map(x=>x.t.transportadora+x.total.toFixed(2))]):'';
function opcoesManual(){ return ULT?[...ULT.res.map(x=>({nome:x.t.transportadora,calc:+x.total.toFixed(2)})),...ULT.nao.map(n=>({nome:n.t.transportadora,calc:null}))]:[]; }
function desenharManualCalc(){
  if(!ULT||!ULT.res.length) return;
  const op=opcoesManual(), chave=op.map(o=>o.nome+o.calc).join('|');
  if($('m_form').dataset.chave!==chave){ $('m_form').dataset.chave=chave;
    formManual($('m_form'),op,async m=>{
      if(SALVA&&SALVA.chave===chaveCalc()){ // cotação já salva: grava direto nela
        const r=await api(`/api/cotacoes/${SALVA.id}/manual`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m)});
        MAN_GRAV.push(r); }
      else MAN_PEND.push(m);
      desenharListaPend(); }); }
  if(SALVA&&SALVA.chave!==chaveCalc()){ SALVA=null; MAN_GRAV=[]; }
  // recalcula a diferença das pendentes com o cálculo atual
  MAN_PEND.forEach(m=>{ const o=op.find(x=>x.nome===m.transportadora); m.valor_calculado=o?o.calc:null; });
  desenharListaPend();
}
function desenharListaPend(){
  $('m_lista').innerHTML=(MAN_GRAV.length?tabelaManuais(MAN_GRAV,false)+`<div class="small ok">Gravado na cotação nº ${SALVA.id}.</div>`:'')+
    (MAN_PEND.length?tabelaManuais(MAN_PEND,true)+'<div class="small">Será gravado junto com a cotação ao clicar em "Salvar cotação".</div>':'');
  $('m_lista').querySelectorAll('.m_rem').forEach(a=>a.onclick=e=>{ e.preventDefault(); MAN_PEND.splice(+a.dataset.i,1); desenharListaPend(); });
}

// ---------- Bling: buscar pedido ----------
async function iniciarBling(){
  const q=new URLSearchParams(location.search);
  let msg='';
  if(q.get('bling')==='ok') msg='<span class="ok">Bling conectado com sucesso.</span>';
  if(q.get('bling')==='erro') msg='<span class="err">Não foi possível conectar ao Bling: '+esc(q.get('msg')||'erro desconhecido')+'</span>';
  if(q.get('bling')) history.replaceState(null,'',location.pathname);
  try{ const s=await api('/api/bling/status');
    if(!s.configurado) return;
    $('bling').classList.remove('hide'); document.querySelectorAll('#menu .bl').forEach(e=>e.classList.remove('hide')); BLING_SYNC=s.sync;
    $('b_conectar').classList.toggle('hide',s.conectado);
    $('b_status').innerHTML=msg||(s.conectado?'':'Para buscar pedidos, conecte a calculadora ao Bling (só é preciso uma vez).');
  }catch(e){ /* sem API */ }
}
async function buscarPedidoBling(){
  const n=$('b_num').value.replace(/\D/g,''); if(!n) return;
  $('b_buscar').disabled=true; $('b_status').innerHTML='Buscando no Bling…';
  try{ const p=await api('/api/bling/pedido?numero='+n);
    if(p.tipo==='proposta'&&p.freteAtual==null) p.freteAtual=p.frete;
    if(!(p.pesoBruto>0)&&p.pesoItens>0){ p.pesoBruto=p.pesoItens; p.origemPeso='itens'; }
    if(p.itensSemPeso>0) p.avisoItens=`${p.itensSemPeso} item(ns) sem peso no cadastro do Bling`;
    preencherPedido(p);
  }catch(e){
    $('b_status').innerHTML='<span class="err">'+esc(e.message)+'</span>';
    if(/conect/i.test(e.message)) $('b_conectar').classList.remove('hide');
  }finally{ $('b_buscar').disabled=false; }
}
function preencherPedido(p){
    $('b_num').value=p.numero;
    BLING_PED={tipo:p.tipo||'pedido',id:p.id,numero:String(p.numero)}; $('s_transp').dataset.escolhida='';
    const avisos=[];
    if(p.pesoBruto>0) $('peso').value=p.pesoBruto; else avisos.push('sem peso no Bling (nem no documento nem nos produtos): informe o peso');
    if(p.origemPeso==='itens') avisos.push('peso calculado pelos itens (peso dos produtos e componentes dos kits)');
    if(p.avisoItens) avisos.push(p.avisoItens);
    else if(p.pesoItens>0&&Math.abs(p.pesoItens-p.pesoBruto)>Math.max(1,p.pesoBruto*0.05)) avisos.push(`peso pelos itens é ${p.pesoItens.toLocaleString('pt-BR')} kg, diferente do peso do pedido`);
    const nf=p.valorProdutos||p.valorTotal; if(nf>0) $('nf').value=nf; else avisos.push('valor do pedido zerado: informe o valor da NF');
    if(p.volumes>0) $('qv').value=p.volumes;
    $('s_cliente').value=p.cliente||''; $('s_pedido').value=p.numero; $('doc_dest').value=p.documento||'';
    $('b_status').innerHTML=`<b>${{proposta:'Proposta',nota:'Nota fiscal'}[p.tipo]||'Pedido'} ${esc(p.numero)}</b>${p.tipo==='nota'&&p.transportadora?' · transportadora da NF: '+esc(p.transportadora):''}${p.canal&&p.canal!=='Venda direta'?' · '+canalTag(p.canal):''}${p.cliente?' · '+esc(p.cliente):''}<br>`+
      `Peso ${p.pesoBruto>0?p.pesoBruto.toLocaleString('pt-BR')+' kg':'—'} · ${p.volumes>0?p.volumes+' volume(s) · ':''}NF ${nf>0?brl(nf):'—'}`+
      `${p.freteAtual>0?' · frete já lançado no Bling: '+brl(p.freteAtual):''}`+
      (p.cep?`<br>CEP ${fmtCep(+p.cep)} (${esc(p.origemCep)})`:'')+
      (avisos.length?`<br><span class="aviso">Atenção: ${avisos.join('; ')}.</span>`:'');
    if(p.cep){ $('cep').value=fmtCep(+p.cep); $('cep').dispatchEvent(new Event('input')); }
    else { $('b_status').innerHTML+='<br><span class="aviso">O pedido não tem CEP de entrega: informe o CEP.</span>'; calc(); }
}

// ---------- Dados importados do Bling (pedidos, propostas, notas, produtos) ----------
const dataBR=d=>d?new Date(String(d).length===10?d+'T12:00:00':d).toLocaleDateString('pt-BR'):'—';
const horaBR=d=>d?new Date(d).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const kg=v=>(+v||0)>0?(+v).toLocaleString('pt-BR',{maximumFractionDigits:3})+' kg':'—';
const NOME_REC={pedidos:'Pedidos',propostas:'Propostas',notas:'Notas fiscais',produtos:'Produtos'};
const FILTROS={
  pedidos:[['','Todos'],['sem_cotacao','Sem cotação'],['sem_frete','Sem frete lançado no Bling'],['acima','Frete no Bling acima da cotação']],
  propostas:[['','Todas'],['sem_cotacao','Sem cotação']],
  notas:[['','Todas'],['autorizadas','Autorizadas'],['sem_pedido','Sem pedido ligado']],
  produtos:[['','Todos'],['kits','Só kits (com estrutura)'],['sem_peso','Sem peso cadastrado']]};
const BUSCA={pedidos:'Buscar por nº, nº da loja, cliente, cidade, CEP ou CPF/CNPJ',propostas:'Buscar por nº, cliente, cidade ou CEP',
  notas:'Buscar por nº, cliente, cidade, CEP, transportadora ou chave',produtos:'Buscar por código ou nome'};
let REC='pedidos', LISTA=[], pTimer=null;
const canalTag=c=>{ c=c||'Venda direta'; const k=c==='Venda direta'?'cd':c==='Mercado Livre'?'ml':'mk'; return `<span class="canal canal-${k}">${esc(c)}</span>`; };
const pesoDoc=d=>{ // peso do documento vs. peso calculado pelos itens
  const calc=+d.peso_calculado||0, sem=+d.itens_sem_peso||0;
  let h=calc>0?kg(calc):'<span class="aviso">—</span>';
  if(sem>0) h+=`<br><span class="small aviso">${sem} item(ns) sem peso</span>`;
  return h; };
function mudarRecurso(r){
  REC=r; document.querySelectorAll('#b_sub button').forEach(b=>b.classList.toggle('on',b.dataset.r===r));
  $('p_filtro').innerHTML=FILTROS[r].map(([v,t])=>`<option value="${v}">${t}</option>`).join('');
  $('p_canal').classList.toggle('hide',r!=='pedidos'); $('p_busca').placeholder=BUSCA[r]; $('p_busca').value='';
  carregarBling();
}
document.querySelectorAll('#b_sub button').forEach(b=>b.onclick=()=>mudarRecurso(b.dataset.r));
$('p_busca').addEventListener('input',()=>{ clearTimeout(pTimer); pTimer=setTimeout(carregarBling,400); });
$('p_filtro').onchange=()=>carregarBling(); $('p_canal').onchange=()=>carregarBling();
$('p_sync').onclick=async()=>{
  const b=$('p_sync'); b.disabled=true; $('p_status').textContent='Sincronizando com o Bling…';
  try{ const r=await api('/api/bling/sincronizar',{method:'POST'}); BLING_SYNC=null; await carregarBling(); if(r.emAndamento) $('p_status').innerHTML='<span class="aviso">'+esc(r.mensagem)+'</span> '+$('p_status').innerHTML; }
  catch(e){ $('p_status').innerHTML='<span class="err">Erro ao sincronizar: '+esc(e.message)+'</span>'; }
  finally{ b.disabled=false; }
};
function textoSync(){
  if(!BLING_SYNC) return 'Ainda não houve sincronização. A importação automática roda a cada 5 minutos.';
  const rs=BLING_SYNC.recursos||[];
  return `Última sincronização: ${horaBR(BLING_SYNC.ultima_execucao)}. `+(rs.length?rs.map(x=>`<b>${esc(NOME_REC[x.recurso]||x.recurso)}</b>: ${esc(x.mensagem||'—')}${x.ultimo_completo?'':' <span class="aviso">(importação inicial em andamento)</span>'}`).join(' · '):esc(BLING_SYNC.mensagem||''))+
    ' A importação automática roda a cada 5 minutos.';
}
async function carregarBling(){
  const r=REC; $('p_status').textContent='Carregando…'; $('p_det').innerHTML='';
  try{
    const q=new URLSearchParams({busca:$('p_busca').value.trim(),filtro:$('p_filtro').value,limite:'300'});
    if(r==='pedidos'&&$('p_canal').value) q.set('canal',$('p_canal').value);
    const [j,s]=await Promise.all([api(`/api/bling/${r}?`+q),api('/api/bling/status').catch(()=>null)]);
    if(r!==REC) return;
    if(s&&s.sync) BLING_SYNC=s.sync;
    LISTA=j[r]; const n=LISTA.length;
    $('p_status').innerHTML=`${n} registro(s)${n===300?' (mostrando os 300 mais recentes)':''}. Clique numa linha para ver os itens. ${textoSync()}`;
    $('p_tab').innerHTML=n?RENDER[r].cab+LISTA.map((x,i)=>`<tr class="lin" data-i="${i}">${RENDER[r].lin(x,i)}</tr>`).join(''):'';
    $('p_tab').querySelectorAll('tr.lin').forEach(tr=>tr.onclick=e=>{ if(e.target.closest('button')) return; detalheItens(r,LISTA[+tr.dataset.i],tr); });
    $('p_tab').querySelectorAll('button[data-cotar]').forEach(b=>b.onclick=()=>cotarDoc(r,LISTA[+b.dataset.cotar]));
  }catch(e){ $('p_status').innerHTML='<span class="err">Erro ao carregar: '+esc(e.message)+'</span>'; $('p_tab').innerHTML=''; }
}
const cotCel=x=>{ const cot=x.cotacao_id?(+(x.valor_escolhido??x.melhor_valor)):null;
  return cot!=null?brl(cot)+`<br><span class="small">${esc(x.transportadora_escolhida||x.melhor_transportadora||'')}</span>`:'<span class="small">sem cotação</span>'; };
const destCel=x=>x.cidade?esc(x.cidade)+'/'+esc(x.uf):'<span class="aviso">sem CEP</span>';
const RENDER={
  pedidos:{cab:'<tr><th>Nº</th><th>Data</th><th>Canal</th><th>Situação</th><th>Cliente</th><th>Destino</th><th class="n">Peso no pedido</th><th class="n">Peso pelos itens</th><th class="n">Valor</th><th class="n">Frete no Bling</th><th class="n">Cotação</th><th class="n">Diferença</th><th></th></tr>',
    lin:(p,i)=>{ const cot=p.cotacao_id?(+(p.valor_escolhido??p.melhor_valor)):null, fb=+p.frete_bling||0, dif=(cot!=null&&fb>0)?fb-cot:null, cm=+p.custo_frete_marketplace||0;
      return `<td>${esc(p.numero)}${p.numero_loja?`<br><span class="small">loja ${esc(p.numero_loja)}</span>`:''}</td><td>${dataBR(p.data)}</td><td>${canalTag(p.canal)}</td>
      <td class="small">${esc(p.situacao||(p.situacao_id!=null?'Situação '+p.situacao_id:'—'))}</td><td>${esc(p.cliente||'')}</td><td>${destCel(p)}</td>
      <td class="n">${kg(p.peso_bruto)}</td><td class="n">${pesoDoc(p)}</td><td class="n">${brl(+(p.valor_produtos||p.valor_total||0))}</td>
      <td class="n">${fb>0?brl(fb):'<span class="small">não lançado</span>'}${p.transportadora_bling?`<br><span class="small">${esc(p.transportadora_bling)}</span>`:''}${cm>0?`<br><span class="small">custo frete marketplace: ${brl(cm)}</span>`:''}</td>
      <td class="n">${cotCel(p)}</td><td class="n ${dif>0.01?'dif-pos':dif<-0.01?'dif-neg':''}">${dif!=null?(dif>0?'+':'')+brl(dif):'—'}</td>
      <td><button class="btn btn-mini" data-cotar="${i}">Cotar</button></td>`; }},
  propostas:{cab:'<tr><th>Nº</th><th>Data</th><th>Situação</th><th>Cliente</th><th>Destino</th><th class="n">Peso pelos itens</th><th class="n">Valor</th><th class="n">Frete na proposta</th><th class="n">Cotação</th><th></th></tr>',
    lin:(p,i)=>`<td>${esc(p.numero)}</td><td>${dataBR(p.data)}</td><td class="small">${esc(p.situacao||'—')}</td><td>${esc(p.cliente||'')}</td><td>${destCel(p)}</td>
      <td class="n">${pesoDoc(p)}</td><td class="n">${brl(+(p.valor_produtos||p.valor_total||0))}</td><td class="n">${+p.frete>0?brl(+p.frete):'—'}</td>
      <td class="n">${cotCel(p)}</td><td><button class="btn btn-mini" data-cotar="${i}">Cotar</button></td>`},
  notas:{cab:'<tr><th>NF</th><th>Emissão</th><th>Pedido</th><th>Cliente</th><th>Destino</th><th>Transportadora</th><th class="n">Volumes</th><th class="n">Peso na NF</th><th class="n">Peso pelos itens</th><th class="n">Valor da NF</th><th class="n">Frete na NF</th></tr>',
    lin:n=>`<td>${esc(n.numero)}${n.serie?`<span class="small">/${esc(n.serie)}</span>`:''}</td><td>${dataBR(n.data_emissao)}</td>
      <td>${n.pedido_numero?esc(n.pedido_numero)+'<br>'+canalTag(n.canal):'<span class="small">—</span>'}</td><td>${esc(n.cliente||'')}</td><td>${destCel(n)}</td>
      <td class="small">${esc(n.transportadora||'—')}</td><td class="n">${n.volumes||'—'}</td><td class="n">${kg(n.peso_bruto)}</td><td class="n">${pesoDoc(n)}</td>
      <td class="n">${brl(+n.valor_nota||0)}</td><td class="n">${+n.valor_frete>0?brl(+n.valor_frete):'—'}</td>`},
  produtos:{cab:'<tr><th>Código</th><th>Produto</th><th>Tipo</th><th class="n">Preço</th><th class="n">Peso bruto (cadastro)</th><th class="n">Peso usado</th><th class="n">Componentes</th></tr>',
    lin:p=>`<td>${esc(p.codigo||'')}</td><td>${esc(p.nome||'')}${p.situacao==='I'?' <span class="small">(inativo)</span>':''}</td>
      <td class="small">${+p.n_componentes>0?'Kit':p.formato==='V'?'Com variações':'Simples'}</td><td class="n">${p.preco!=null?brl(+p.preco):'—'}</td>
      <td class="n">${kg(p.peso_bruto)}</td><td class="n">${+p.peso_unitario>0?kg(p.peso_unitario)+(p.origem_peso==='componentes'?'<br><span class="small">soma dos componentes</span>':''):'<span class="aviso">sem peso</span>'}</td>
      <td class="n">${+p.n_componentes||'—'}</td>`}};
async function detalheItens(tipoLista,x,tr){
  const tipo={pedidos:'pedido',propostas:'proposta',notas:'nota',produtos:'produto'}[tipoLista];
  $('p_tab').querySelectorAll('tr.sel').forEach(t=>t.classList.remove('sel')); tr.classList.add('sel');
  $('p_det').innerHTML='<div class="card small">Carregando itens…</div>';
  try{ const j=await api(`/api/bling/itens?tipo=${tipo}&id=${x.id}`);
    const titulo=tipo==='produto'?`Produto ${esc(x.codigo||'')} – ${esc(x.nome||'')}`:`${{pedido:'Pedido',proposta:'Proposta',nota:'NF'}[tipo]} ${esc(x.numero)}${x.cliente?' · '+esc(x.cliente):''}`;
    let tot=0;
    const linhas=j.itens.map(i=>{
      const pu=+i.peso_unitario||0, pt=pu*(+i.quantidade||0); tot+=pt;
      const comp=i.componentes.length?`<tr class="comp"><td></td><td colspan="6"><table class="mini"><tr><th>Componente</th><th class="n">Qtd. por kit</th><th class="n">Qtd. total</th><th class="n">Peso unit.</th><th class="n">Peso total</th><th class="n">Preço unit.</th></tr>`+
        i.componentes.map(c=>`<tr><td>${esc(c.codigo||'')} ${esc(c.nome||'(produto '+c.componente_id+' ainda não importado)')}</td><td class="n">${(+c.quantidade).toLocaleString('pt-BR')}</td>
          <td class="n">${(+c.quantidade*(+i.quantidade||0)).toLocaleString('pt-BR')}</td><td class="n">${kg(c.peso_bruto)}</td>
          <td class="n">${kg((+c.peso_bruto||0)*(+c.quantidade)*(+i.quantidade||0))}</td><td class="n">${c.preco!=null?brl(+c.preco):'—'}</td></tr>`).join('')+'</table></td></tr>':'';
      return `<tr><td>${esc(i.codigo||'')}</td><td>${esc(i.descricao||i.nome||'')}${i.componentes.length?' <span class="canal canal-mk">kit</span>':''}${!i.pid?' <span class="small aviso">produto não encontrado no cadastro</span>':''}</td>
        <td class="n">${(+i.quantidade).toLocaleString('pt-BR')} ${esc(i.unidade||'')}</td><td class="n">${i.valor!=null?brl(+i.valor):'—'}</td>
        <td class="n">${pu>0?kg(pu):'<span class="aviso">sem peso</span>'}</td><td class="n">${pt>0?kg(pt):'—'}</td><td class="n">${i.valor_total!=null?brl(+i.valor_total):brl((+i.valor||0)*(+i.quantidade||0))}</td></tr>`+comp; }).join('');
    $('p_det').innerHTML=`<div class="card"><h2>${titulo}</h2>
      ${j.itens.length?`<table><tr><th>Código</th><th>Descrição</th><th class="n">Qtd.</th><th class="n">Valor unit.</th><th class="n">Peso unit.</th><th class="n">Peso total</th><th class="n">Valor total</th></tr>${linhas}
      ${tipo!=='produto'?`<tr><td></td><td><b>Total</b></td><td></td><td></td><td></td><td class="n"><b>${kg(tot)}</b></td><td></td></tr>`:''}</table>`:'<p class="small">Sem itens importados.</p>'}</div>`;
    $('p_det').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){ $('p_det').innerHTML='<div class="card small err">Erro: '+esc(e.message)+'</div>'; }
}
function cotarDoc(r,p){
  irPara('calc',false);
  const pesoPedido=+p.peso_bruto||0, pesoItens=+p.peso_calculado||0;
  preencherPedido({tipo:r==='propostas'?'proposta':'pedido',id:p.id,numero:p.numero,cliente:p.cliente,documento:p.documento,cep:p.cep,origemCep:p.origem_cep,
    pesoBruto:pesoPedido||pesoItens||null,origemPeso:pesoPedido?'pedido':pesoItens?'itens':'',pesoItens:pesoItens||null,
    volumes:+p.volumes||null,valorProdutos:+p.valor_produtos||null,valorTotal:+p.valor_total||null,freteAtual:+(p.frete_bling||p.frete)||null,canal:p.canal});
  window.scrollTo({top:0,behavior:'smooth'});
}
$('b_buscar').onclick=buscarPedidoBling;
$('b_num').addEventListener('keydown',e=>{ if(e.key==='Enter') buscarPedidoBling(); });

let hTimer=null;
$('h_busca').addEventListener('input',()=>{ clearTimeout(hTimer); hTimer=setTimeout(carregarHistorico,400); });
$('h_atualizar').onclick=carregarHistorico; $('h_manual').onchange=carregarHistorico;
async function carregarHistorico(){
  $('h_det').innerHTML=''; $('h_div').innerHTML='';
  if(!API_OK){ $('h_status').textContent='O histórico só funciona no site publicado (com login).'; $('h_tab').innerHTML=''; return; }
  $('h_status').textContent='Carregando…';
  try{ const j=await api('/api/cotacoes?limite=200&busca='+encodeURIComponent($('h_busca').value.trim())+($('h_manual').checked?'&manual=1':''));
    const L=j.cotacoes;
    $('h_status').textContent=L.length?`${L.length} cotação(ões)${L.length===200?' (mostrando as 200 mais recentes)':''}. Clique numa linha para ver o detalhe.`:'Nenhuma cotação encontrada.';
    $('h_tab').innerHTML=L.length?'<tr><th>Nº</th><th>Data</th><th>Usuário</th><th>Cliente / pedido</th><th>Destino</th><th class="n">Peso (kg)</th><th class="n">NF</th><th>Melhor opção</th><th class="n">Valor</th><th>Prazo</th><th class="n">Valor manual</th></tr>'+
      L.map(c=>`<tr class="lin" data-id="${c.id}"><td>${c.id}</td><td>${new Date(c.criado_em).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}</td><td class="small">${esc(c.usuario)}</td>
        <td>${esc(c.cliente||'')}${c.pedido?` <span class="small">#${esc(c.pedido)}</span>`:''}</td><td>${esc(c.cidade||'')}/${esc(c.uf||'')} <span class="small">${esc(c.cep||'')}</span></td>
        <td class="n">${(+c.peso_taxado).toLocaleString('pt-BR')}</td><td class="n">${brl(+c.valor_nf)}</td><td>${esc(c.melhor_transportadora)}${c.transportadora_escolhida&&c.transportadora_escolhida!==c.melhor_transportadora?`<br><span class="small">escolhida: ${esc(c.transportadora_escolhida)} (${brl(+c.valor_escolhido)})</span>`:''}</td>
        <td class="n">${brl(+c.melhor_valor)}</td><td>${c.melhor_prazo?fp(c.melhor_prazo):'—'}</td>
        <td class="n small">${(c.manuais||[]).map(m=>`${esc(m.transportadora)}: ${brl(+m.valor_manual)}<br>${difTxt(+m.valor_manual,+m.valor_calculado)}`).join('<br>')||'—'}</td></tr>`).join(''):'';
    $('h_tab').querySelectorAll('tr.lin').forEach(tr=>tr.onclick=()=>detalheHistorico(tr.dataset.id));
  }catch(e){ $('h_status').textContent='Erro ao carregar o histórico: '+e.message; }
}
const confirmarRemocao=()=>confirm('Remover este valor manual?');
async function detalheHistorico(id){
  $('h_div').innerHTML='';
  if(!$('h_det').innerHTML) $('h_det').innerHTML='<div class="card small">Carregando…</div>';
  try{ const c=await api('/api/cotacoes/'+id);
    const rs=c.resultados||[], nc=c.sem_cotacao||[];
    $('h_det').innerHTML=`<div class="card"><h2>Cotação nº ${c.id} · ${new Date(c.criado_em).toLocaleString('pt-BR')}</h2>
      <div class="kv"><div>Usuário</div><div>${esc(c.usuario)}</div><div>Cliente / pedido</div><div>${esc(c.cliente||'—')} ${c.pedido?'#'+esc(c.pedido):''}</div>
      <div>Destino</div><div>${esc(c.cidade)}/${esc(c.uf)} ${esc(c.cep||'')}</div>
      <div>Carga</div><div>${(+c.peso_real).toLocaleString('pt-BR')} kg real · ${(+c.peso_taxado).toLocaleString('pt-BR')} kg taxado · NF ${brl(+c.valor_nf)}${c.volumes?' · '+c.volumes+' volume(s)':''}</div>
      <div>Regras</div><div>${c.com_icms?'com ICMS':'sem ICMS'} · tonelada: ${c.regra_tonelada==='tot'?'peso total':'excedente'}</div>
      ${c.transportadora_escolhida?`<div>Escolhida</div><div>${esc(c.transportadora_escolhida)} – ${brl(+c.valor_escolhido)}</div>`:''}
      ${c.bling_pedido_id?`<div>Pedido no Bling</div><div>ID ${esc(c.bling_pedido_id)}</div>`:''}
      ${c.observacao?`<div>Observação</div><div>${esc(c.observacao)}</div>`:''}</div>
      <table><tr><th>#</th><th>Transportadora</th><th>Praça</th><th>Prazo</th><th class="n">Total</th></tr>
      ${rs.map((r,k)=>`<tr><td>${k+1}</td><td>${esc(r.transportadora)}</td><td class="small">${esc(r.praca)}</td><td>${r.prazo?fp(r.prazo):'—'}</td><td class="n">${brl(+r.total)}</td></tr>`).join('')}</table>
      ${nc.length?`<p class="small">Sem cotação: ${nc.map(n=>esc(n.transportadora)).join(', ')}</p>`:''}
      <div class="manual"><div class="manual-tit">Valores cotados manualmente</div><div id="hm_lista">${tabelaManuais(c.valores_manuais||[],true)||'<p class="small">Nenhum valor manual registrado.</p>'}</div><div id="hm_form"></div></div></div>`;
    if(c.motivos) MOTIVOS=c.motivos;
    const L=c.valores_manuais||[];
    const ligar=()=>$('hm_lista').querySelectorAll('.m_rem').forEach(a=>a.onclick=async e=>{ e.preventDefault();
      if(!confirmarRemocao()) return; await api('/api/manuais/'+L[+a.dataset.i].id,{method:'DELETE'}); detalheHistorico(id); });
    ligar();
    formManual($('hm_form'),[...rs.map(r=>({nome:r.transportadora,calc:+r.total})),...nc.map(n=>({nome:n.transportadora,calc:null}))],async m=>{
      await api(`/api/cotacoes/${id}/manual`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m)}); await detalheHistorico(id); });
    $('h_det').scrollIntoView({behavior:'smooth'});
  }catch(e){ $('h_det').innerHTML='<div class="card small err">Erro: '+esc(e.message)+'</div>'; }
}

async function analiseDivergencias(){
  $('h_det').innerHTML=''; $('h_div').innerHTML='<div class="card small">Carregando…</div>';
  try{ const d=await api('/api/divergencias');
    const pc=v=>v==null?'—':`${+v>0?'+':''}${(+v).toLocaleString('pt-BR',{maximumFractionDigits:1})}%`;
    const res=(tit,L)=>L.length?`<h3>${tit}</h3><table class="mini"><tr><th>Grupo</th><th class="n">Casos</th><th class="n">Diferença média</th><th class="n">Média %</th><th class="n">Média absoluta %</th><th class="n">Menor / maior %</th><th class="n">Acima / abaixo</th></tr>`+
      L.map(r=>`<tr><td>${esc(r.grupo)}</td><td class="n">${r.n}</td><td class="n">${brl(+r.media_dif)}</td><td class="n">${pc(r.media_pct)}</td><td class="n">${pc(r.media_abs_pct)}</td>
        <td class="n">${pc(r.min_pct)} / ${pc(r.max_pct)}</td><td class="n">${r.acima} / ${r.abaixo}</td></tr>`).join('')+'</table>':'';
    const L=d.linhas;
    $('h_div').innerHTML=`<div class="card"><div class="hist-top"><h2 style="margin:0">Análise de divergências</h2><button class="btn btn2" id="d_csv">Baixar planilha (CSV)</button></div>
      ${L.length?`<p class="small">${L.length} valor(es) manual(is) comparado(s) com o calculado. Diferença positiva = a transportadora cobrou mais que o sistema calculou.</p>
      ${res('Por transportadora',d.por_transportadora)}${res('Por motivo informado',d.por_motivo)}${res('Por transportadora e UF',d.por_uf)}${res('Por transportadora e faixa de peso',d.por_peso)}
      <h3>Casos</h3><div class="tbl-wrap"><table class="mini"><tr><th>Data</th><th>Cotação</th><th>Transportadora</th><th>Destino</th><th>Praça</th><th class="n">Peso</th><th class="n">NF</th><th class="n">Calculado</th><th class="n">Informado</th><th class="n">Diferença</th><th>Motivo</th><th>Obs.</th></tr>
      ${L.map(m=>`<tr class="lin" data-id="${m.cotacao_id}"><td>${dataBR(m.criado_em)}</td><td>${m.cotacao_id}</td><td>${esc(m.transportadora)}</td><td>${esc(m.cidade||'')}/${esc(m.uf||'')}</td><td class="small">${esc(m.praca||'')}</td>
        <td class="n">${kg(m.peso_real)}</td><td class="n">${brl(+m.valor_nf)}</td><td class="n">${brl(+m.valor_calculado)}</td><td class="n">${brl(+m.valor_manual)}</td>
        <td class="n">${difTxt(+m.valor_manual,+m.valor_calculado)}</td><td class="small">${esc(m.motivo||'')}</td><td class="small">${esc([m.referencia,m.observacao].filter(Boolean).join(' · '))}</td></tr>`).join('')}</table></div>`
      :'<p class="small">Ainda não há valores manuais registrados. Registre no painel "Salvar cotação" ou no detalhe de uma cotação do histórico.</p>'}
      ${d.online&&d.online.linhas.length?`<h3>Cotação online × tabela (${d.online.linhas.length} comparações em cotações salvas)</h3>
        <p class="small">Diferença positiva = a transportadora (online) cobra mais do que a nossa tabela calcula. Uso do valor online × tabela por falha da API: ${d.online.fontes.map(f=>`${esc(f.transportadora)} ${f.online} × ${f.tabela}`).join(' · ')}.</p>
        ${res('Por transportadora',d.online.por_transportadora.map(g=>({...g,media_abs_pct:null,acima:'',abaixo:''})))}${res('Por transportadora e UF',d.online.por_uf.map(g=>({...g,media_abs_pct:null,acima:'',abaixo:''})))}${res('Por transportadora, UF e praça da tabela',d.online.por_praca.map(g=>({...g,media_abs_pct:null,acima:'',abaixo:''})))}
        <div class="tbl-wrap"><table class="mini"><tr><th>Data</th><th>Cotação</th><th>Transportadora</th><th>Destino</th><th>Praça (tabela)</th><th class="n">Peso</th><th class="n">NF</th><th class="n">Tabela</th><th class="n">Online</th><th class="n">Diferença</th><th>Nº cotação</th></tr>
        ${d.online.linhas.map(m=>`<tr class="lin" data-id="${m.cotacao_id}"><td>${dataBR(m.criado_em)}</td><td>${m.cotacao_id}</td><td>${esc(m.transportadora||'')}</td><td>${esc(m.cidade||'')}/${esc(m.uf||'')}</td><td class="small">${esc(m.praca||'')}</td>
          <td class="n">${kg(m.peso_real)}</td><td class="n">${brl(+m.valor_nf)}</td><td class="n">${brl(+m.tabela)}</td><td class="n">${brl(+m.online)}</td><td class="n">${difTxt(+m.online,+m.tabela)}</td><td class="small">${esc(m.cotacao_online||'')}</td></tr>`).join('')}</table></div>`:''}
      ${d.sem_calculo.length?`<h3>Transportadoras que o sistema não cotou (${d.sem_calculo.length})</h3><table class="mini"><tr><th>Data</th><th>Transportadora</th><th>Destino</th><th class="n">Peso</th><th class="n">Informado</th><th>Obs.</th></tr>`+
        d.sem_calculo.map(m=>`<tr><td>${dataBR(m.criado_em)}</td><td>${esc(m.transportadora)}</td><td>${esc(m.cidade||'')}/${esc(m.uf||'')}</td><td class="n">${kg(m.peso_real)}</td><td class="n">${brl(+m.valor_manual)}</td><td class="small">${esc(m.observacao||'')}</td></tr>`).join('')+'</table>':''}</div>`;
    $('h_div').querySelectorAll('tr.lin').forEach(tr=>tr.onclick=()=>{ irPara('hist'); detalheHistorico(tr.dataset.id); });
    const b=$('d_csv'); if(b) b.onclick=()=>{
      const cols=['cotacao_id','criado_em','usuario','transportadora','cidade','uf','cep','praca','peso_real','peso_taxado','valor_nf','volumes','com_icms','valor_calculado','valor_manual','diferenca','diferenca_pct','prazo_manual','motivo','referencia','observacao','cliente','pedido'];
      const cel=v=>{ v=v==null?'':String(v); if(/^-?\d+(\.\d+)?$/.test(v)) v=v.replace('.',','); return /[;"\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
      const csv='﻿'+cols.join(';')+'\n'+L.map(m=>cols.map(c=>cel(m[c])).join(';')).join('\n');
      const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='divergencias-frete.csv'; a.click(); };
  }catch(e){ $('h_div').innerHTML='<div class="card small err">Erro: '+esc(e.message)+'</div>'; }
}

renderTab(); setDest({uf:'SP',cidade:'CAMPINAS'}); irPara(location.hash.slice(1)||'calc',false);
}
