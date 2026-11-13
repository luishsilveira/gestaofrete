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
let tonMode='exc'; let override={}; let ULT=null; let API_OK=false; let BLING_PED=null; let BLING_SYNC=null; const VERSAO='1.3';
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
  if(!res){ try{ const j=await buscaJSON(`https://brasilapi.com.br/api/cep/v2/${cep8}`);
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
  if(r&&r.inexistente){ dest={uf:ufc,cidade:'',invalido:true}; $('cid').value=''; calc(); return; }
  if(r&&r.uf){ setDest({uf:r.uf,cidade:norm(r.cidade),cep:n,ibge:r.ibge,fonteCep:r.fonte},'cep'); return; }
  // reserva: listas das transportadoras
  let best=null; const chk=(c,uf,a,b)=>{ if(uf!==ufc||ufDoCep(a)!==uf||ufDoCep(b)!==uf) return; if(n>=a&&n<=b&&(!best||b-a<best.w)) best={c,uf,w:b-a}; };
  D.rtemap.forEach(x=>{ for(let i=0;i<x[5].length;i+=2) chk(x[0],x[1],x[5][i],x[5][i+1]); });
  D.tbmap.forEach(x=>chk(x[0],x[1],x[3],x[4]));
  D.smmap.forEach(x=>chk(x[0],x[1],x[3],x[4]));
  if(best) setDest({uf:best.uf,cidade:best.c,cep:n},'cep');
  else { setDest({uf:ufc,cidade:'',cep:n,semLista:true},'cep'); } });

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
  $('destinfo').innerHTML=dest.cidade?`Destino: <b>${dest.cidade} / ${uf}</b>${dest.cep?' · CEP '+String(dest.cep).padStart(8,'0').replace(/(\d{5})(\d{3})/,'$1-$2'):''}${dest.fonteCep?` <span class="small">(cidade confirmada pelos Correios via ${dest.fonteCep})</span>`:(dest.cep?' <span class="small">(cidade pelas listas das transportadoras; consulta aos Correios indisponível)</span>':'')}`:(dest.semLista?`CEP ${String(dest.cep).padStart(8,'0').replace(/(\d{5})(\d{3})/,'$1-$2')} é de <b>${UFNOME[uf]||uf}</b>, mas a cidade não está nas listas das transportadoras. Digite o nome da cidade acima.`:`Destino: <b>${UFNOME[uf]}</b> (sem cidade: escolha a praça de cada transportadora)`);
  const op={tde:$('o_tde').checked,tda:$('o_tda').checked,trt:$('o_trt').checked,ag:$('o_ag').checked,pal:$('o_pal').checked,int:false,icms:$('icms').checked};
  $('icmsinfo').textContent=op.icms?`Alíquota aplicada RS → ${uf}: ${aliqICMS(uf)}%`:'Valores sem ICMS';
  const res=[], nao=[];
  TABELAS.forEach(t=>{ const rv=resolver(t);
    if(rv.erro){ nao.push({t,msg:rv.erro}); return; }
    const r=t.rotas[rv.i];
    if(t.id==='tjb') op.int=/interior/i.test(r.regiao);
    const pT=ptDe(t); res.push({t,r,rv,pT,...cotar(t,r,pT,nf,uf,op,rv)}); });
  res.sort((a,b)=>a.total-b.total);
  ULT={uf,peso,nf,pt,m3,icms:op.icms,res,nao};
  $('salvar').classList.toggle('hide',!res.length||!API_OK);
  { const sel=$('s_transp'), ant=sel.value;
    sel.innerHTML=res.map((x,k)=>`<option value="${k}" data-n="${x.t.transportadora}">${x.t.transportadora} – ${brl(x.total)}${k?'':' (menor preço)'}</option>`).join('');
    const k=res.findIndex(x=>x.t.transportadora===(sel.dataset.escolhida||'')); sel.value=String(k>=0?k:0); }
  if(res.length) $('s_status').textContent='';
  const simples=$('simples').checked;
  $('out').classList.toggle('simple',simples); $('avisos').classList.toggle('hide',simples);
  if(simples){
    let h=res.map((x,k)=>{ const prazo=x.rv.prazo||x.r.prazo;
      return `<div class="r ${k?'':'best'}"><div class="rh"><div class="pos">${k+1}</div>
      <div class="nm"><b>${x.t.transportadora} ${k?'':'<span class="tag">Melhor opção</span>'}</b>${x.rv.fonte==='man'?`<span>praça ${x.r.regiao} a confirmar</span>`:''}</div>
      <div class="prz">${prazo?fp(prazo):'não informado'}<small>prazo</small></div>
      <div class="val">${brl(x.total)}<small>${k?'+'+brl(x.total-res[0].total):'menor preço'}</small></div></div></div>`;}).join('');
    if(!res.length) h+='<div class="na">Nenhuma tabela atende esse destino.</div>';
    if(nao.length) h+=`<div class="na">Sem cotação: ${nao.map(n=>n.t.transportadora).join(', ')}</div>`;
    $('out').innerHTML=h; return;
  }
  let h=res.map((x,k)=>{
    const dif=k?` <small>+${brl(x.total-res[0].total)} (${((x.total/res[0].total-1)*100).toFixed(1)}%)</small>`:'<small>menor preço</small>';
    const prazo=x.rv.prazo||x.r.prazo;
    const bcls={lista:'b-lista',cap:'b-cap',man:'b-man'}[x.rv.fonte];
    return `<div class="r ${k?'':'best'}"><div class="rh"><div class="pos">${k+1}</div>
      <div class="nm"><b>${x.t.transportadora} ${k?'':'<span class="tag">Melhor opção</span>'}</b><span>${x.r.regiao}<span class="badge ${bcls}">${x.rv.txt}</span>${prazo?' · prazo '+fp(prazo):''}${x.rv.freq?' · saídas '+x.rv.freq:''}</span></div>
      <div class="val">${brl(x.total)}${dif}</div></div>
      <div class="det">${x.rv.op&&x.rv.op.length>1?`<label>Praça usada no cálculo</label><select data-t="${x.t.id}">${x.rv.op.map(o=>`<option value="${o.i}" ${o.i==x.rv.i?'selected':''}>${o.r.regiao}</option>`).join('')}</select>`:''}
      ${x.pT!==pt?`<div class="small" style="margin:8px 0">Peso taxado nesta transportadora: <b>${x.pT.toLocaleString('pt-BR')} kg</b> (isenta de cubagem até ${x.t.isentoCubM3.toLocaleString('pt-BR')} m³)</div>`:''}
      <table><tr><th>Componente</th><th>Base</th><th class="n">Valor</th></tr>
      ${x.it.map(i=>`<tr><td>${i.n}</td><td class="small">${i.d}</td><td class="n">${brl(i.v)}</td></tr>`).join('')}
      <tr><td>Subtotal</td><td></td><td class="n">${brl(x.sub)}</td></tr>
      ${x.icms?`<tr><td>ICMS</td><td class="small">${x.al}% por dentro</td><td class="n">${brl(x.icms)}</td></tr>`:''}
      <tr class="tot"><td>Total</td><td></td><td class="n">${brl(x.total)}</td></tr></table></div></div>`;}).join('');
  if(!res.length) h+='<div class="na">Nenhuma tabela atende esse destino.</div>';
  if(nao.length) h+=`<div class="na">Sem cotação: ${nao.map(n=>`<b>${n.t.transportadora}</b> – ${n.msg}`).join('<br>')}</div>`;
  $('out').innerHTML=h;
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
['simples','peso','nf','m3','c','l','a','qv','icms','dep','o_tde','o_tda','o_trt','o_ag','o_pal'].forEach(id=>$(id).addEventListener('input',calc));
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('on',x===b));['calc','tab','ped','hist','json'].forEach(s=>$(s).classList.toggle('hide',s!==b.dataset.t)); if(b.dataset.t==='hist') carregarHistorico(); if(b.dataset.t==='ped') carregarPedidos();});

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
api('/api/eu').then(j=>{ API_OK=true; $('subt').textContent+=` · usuário: ${j.usuario}`; calc(); iniciarBling(); })
  .catch(()=>{ API_OK=false; });
$('s_btn').onclick=async()=>{
  if(!ULT||!ULT.res.length) return;
  const b=$('s_btn'); b.disabled=true; $('s_status').className='small'; $('s_status').textContent='Salvando…';
  const corpo={cliente:$('s_cliente').value.trim(),pedido:$('s_pedido').value.trim(),observacao:$('s_obs').value.trim(),
    cep:fmtCep(dest.cep),cidade:dest.cidade||'',uf:ULT.uf,peso_real:ULT.peso,peso_taxado:ULT.pt,valor_nf:ULT.nf,
    volumes:+$('qv').value||null,m3:ULT.m3,com_icms:ULT.icms,regra_tonelada:tonMode,versao_app:VERSAO,
    resultados:ULT.res.map(x=>({transportadora:x.t.transportadora,praca:x.r.regiao,fonte_praca:x.rv.txt,total:+x.total.toFixed(2),
      prazo:String(x.rv.prazo||x.r.prazo||''),peso_taxado:x.pT,subtotal:+x.sub.toFixed(2),icms:+x.icms.toFixed(2),
      itens:x.it.map(i=>({n:i.n,v:+i.v.toFixed(2),d:i.d}))})),
    sem_cotacao:ULT.nao.map(n=>({transportadora:n.t.transportadora,motivo:n.msg}))};
  const esc_=ULT.res[+$('s_transp').value||0];
  corpo.transportadora_escolhida=esc_.t.transportadora; corpo.valor_escolhido=+esc_.total.toFixed(2);
  if(BLING_PED&&corpo.pedido===BLING_PED.numero) corpo.bling_pedido_id=BLING_PED.id;
  try{ const j=await api('/api/cotacoes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(corpo)});
    $('s_status').className='small ok'; $('s_status').textContent=`Cotação nº ${j.id} salva.`;
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

// ---------- Bling: buscar pedido ----------
async function iniciarBling(){
  const q=new URLSearchParams(location.search);
  let msg='';
  if(q.get('bling')==='ok') msg='<span class="ok">Bling conectado com sucesso.</span>';
  if(q.get('bling')==='erro') msg='<span class="err">Não foi possível conectar ao Bling: '+esc(q.get('msg')||'erro desconhecido')+'</span>';
  if(q.get('bling')) history.replaceState(null,'',location.pathname);
  try{ const s=await api('/api/bling/status');
    if(!s.configurado) return;
    $('bling').classList.remove('hide'); $('tab_ped').classList.remove('hide'); BLING_SYNC=s.sync;
    $('b_conectar').classList.toggle('hide',s.conectado);
    $('b_status').innerHTML=msg||(s.conectado?'':'Para buscar pedidos, conecte a calculadora ao Bling (só é preciso uma vez).');
  }catch(e){ /* sem API */ }
}
async function buscarPedidoBling(){
  const n=$('b_num').value.replace(/\D/g,''); if(!n) return;
  $('b_buscar').disabled=true; $('b_status').innerHTML='Buscando pedido no Bling…';
  try{ const p=await api('/api/bling/pedido?numero='+n);
    preencherPedido(p);
  }catch(e){
    $('b_status').innerHTML='<span class="err">'+esc(e.message)+'</span>';
    if(/conect/i.test(e.message)) $('b_conectar').classList.remove('hide');
  }finally{ $('b_buscar').disabled=false; }
}
function preencherPedido(p){
    $('b_num').value=p.numero;
    BLING_PED={id:p.id,numero:p.numero}; $('s_transp').dataset.escolhida='';
    const avisos=[];
    if(p.pesoBruto>0) $('peso').value=p.pesoBruto; else avisos.push('o pedido não tem peso bruto no Bling: informe o peso');
    const nf=p.valorProdutos||p.valorTotal; if(nf>0) $('nf').value=nf; else avisos.push('valor do pedido zerado: informe o valor da NF');
    if(p.volumes>0) $('qv').value=p.volumes;
    $('s_cliente').value=p.cliente||''; $('s_pedido').value=p.numero;
    $('b_status').innerHTML=`<b>Pedido ${esc(p.numero)}</b>${p.cliente?' · '+esc(p.cliente):''}<br>`+
      `Peso ${p.pesoBruto>0?p.pesoBruto.toLocaleString('pt-BR')+' kg':'—'} · ${p.volumes>0?p.volumes+' volume(s) · ':''}NF ${nf>0?brl(nf):'—'}`+
      `${p.freteAtual>0?' · frete já lançado no Bling: '+brl(p.freteAtual):''}`+
      (p.cep?`<br>CEP ${fmtCep(+p.cep)} (${esc(p.origemCep)})`:'')+
      (avisos.length?`<br><span class="aviso">Atenção: ${avisos.join('; ')}.</span>`:'');
    if(p.cep){ $('cep').value=fmtCep(+p.cep); $('cep').dispatchEvent(new Event('input')); }
    else { $('b_status').innerHTML+='<br><span class="aviso">O pedido não tem CEP de entrega: informe o CEP.</span>'; calc(); }
}

// ---------- Pedidos importados do Bling ----------
const dataBR=d=>d?new Date(String(d).length===10?d+'T12:00:00':d).toLocaleDateString('pt-BR'):'—';
const horaBR=d=>d?new Date(d).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
let PEDIDOS=[]; let pTimer=null;
$('p_busca').addEventListener('input',()=>{ clearTimeout(pTimer); pTimer=setTimeout(carregarPedidos,400); });
$('p_filtro').onchange=carregarPedidos;
$('p_sync').onclick=async()=>{
  const b=$('p_sync'); b.disabled=true; $('p_status').textContent='Sincronizando com o Bling…';
  try{ const r=await api('/api/bling/sincronizar',{method:'POST'}); BLING_SYNC={ultima_execucao:new Date().toISOString(),mensagem:r.mensagem}; await carregarPedidos(); }
  catch(e){ $('p_status').innerHTML='<span class="err">Erro ao sincronizar: '+esc(e.message)+'</span>'; }
  finally{ b.disabled=false; }
};
async function carregarPedidos(){
  $('p_status').textContent='Carregando…';
  try{
    const q=new URLSearchParams({busca:$('p_busca').value.trim(),filtro:$('p_filtro').value,limite:'300'});
    const [j,s]=await Promise.all([api('/api/bling/pedidos?'+q),api('/api/bling/status').catch(()=>null)]);
    if(s&&s.sync) BLING_SYNC=s.sync;
    PEDIDOS=j.pedidos;
    const sync=BLING_SYNC?`Última sincronização: ${horaBR(BLING_SYNC.ultima_execucao)} – ${esc(BLING_SYNC.mensagem||'')} A importação automática roda a cada 5 minutos.`:'Ainda não houve sincronização. A importação automática roda a cada 5 minutos.';
    $('p_status').innerHTML=`${PEDIDOS.length} pedido(s)${PEDIDOS.length===300?' (mostrando os 300 mais recentes)':''}. ${sync}`;
    $('p_tab').innerHTML=PEDIDOS.length?'<tr><th>Nº</th><th>Data</th><th>Situação</th><th>Cliente</th><th>Destino</th><th class="n">Peso</th><th class="n">Valor</th><th class="n">Frete no Bling</th><th class="n">Cotação</th><th class="n">Diferença</th><th></th></tr>'+
      PEDIDOS.map((p,i)=>{
        const cot=p.cotacao_id?(+(p.valor_escolhido??p.melhor_valor)):null, fb=+p.frete_bling||0;
        const dif=(cot!=null&&fb>0)?fb-cot:null;
        return `<tr><td>${esc(p.numero)}</td><td>${dataBR(p.data)}</td><td class="small">${esc(p.situacao||(p.situacao_id!=null?'Situação '+p.situacao_id:'—'))}</td>
        <td>${esc(p.cliente||'')}</td><td>${p.cidade?esc(p.cidade)+'/'+esc(p.uf):'<span class="aviso">sem CEP</span>'}</td>
        <td class="n">${p.peso_bruto>0?(+p.peso_bruto).toLocaleString('pt-BR')+' kg':'<span class="aviso">—</span>'}</td>
        <td class="n">${brl(+(p.valor_produtos||p.valor_total||0))}</td>
        <td class="n">${fb>0?brl(fb):'<span class="small">não lançado</span>'}${p.transportadora_bling?`<br><span class="small">${esc(p.transportadora_bling)}</span>`:''}</td>
        <td class="n">${cot!=null?brl(cot)+`<br><span class="small">${esc(p.transportadora_escolhida||p.melhor_transportadora||'')}</span>`:'<span class="small">sem cotação</span>'}</td>
        <td class="n ${dif>0.01?'dif-pos':dif<-0.01?'dif-neg':''}">${dif!=null?(dif>0?'+':'')+brl(dif):'—'}</td>
        <td><button class="btn btn-mini" data-i="${i}">Cotar</button></td></tr>`;}).join(''):'';
    $('p_tab').querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>cotarPedido(PEDIDOS[+b.dataset.i]));
  }catch(e){ $('p_status').innerHTML='<span class="err">Erro ao carregar os pedidos: '+esc(e.message)+'</span>'; }
}
function cotarPedido(p){
  document.querySelector('nav button[data-t=calc]').click();
  preencherPedido({id:p.id,numero:p.numero,cliente:p.cliente,cep:p.cep,origemCep:p.origem_cep,pesoBruto:+p.peso_bruto||null,
    volumes:+p.volumes||null,valorProdutos:+p.valor_produtos||null,valorTotal:+p.valor_total||null,freteAtual:+p.frete_bling||null});
  window.scrollTo({top:0,behavior:'smooth'});
}
$('b_buscar').onclick=buscarPedidoBling;
$('b_num').addEventListener('keydown',e=>{ if(e.key==='Enter') buscarPedidoBling(); });

let hTimer=null;
$('h_busca').addEventListener('input',()=>{ clearTimeout(hTimer); hTimer=setTimeout(carregarHistorico,400); });
$('h_atualizar').onclick=carregarHistorico;
async function carregarHistorico(){
  $('h_det').innerHTML='';
  if(!API_OK){ $('h_status').textContent='O histórico só funciona no site publicado (com login).'; $('h_tab').innerHTML=''; return; }
  $('h_status').textContent='Carregando…';
  try{ const j=await api('/api/cotacoes?limite=200&busca='+encodeURIComponent($('h_busca').value.trim()));
    const L=j.cotacoes;
    $('h_status').textContent=L.length?`${L.length} cotação(ões)${L.length===200?' (mostrando as 200 mais recentes)':''}. Clique numa linha para ver o detalhe.`:'Nenhuma cotação encontrada.';
    $('h_tab').innerHTML=L.length?'<tr><th>Nº</th><th>Data</th><th>Usuário</th><th>Cliente / pedido</th><th>Destino</th><th class="n">Peso (kg)</th><th class="n">NF</th><th>Melhor opção</th><th class="n">Valor</th><th>Prazo</th></tr>'+
      L.map(c=>`<tr class="lin" data-id="${c.id}"><td>${c.id}</td><td>${new Date(c.criado_em).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}</td><td class="small">${esc(c.usuario)}</td>
        <td>${esc(c.cliente||'')}${c.pedido?` <span class="small">#${esc(c.pedido)}</span>`:''}</td><td>${esc(c.cidade||'')}/${esc(c.uf||'')} <span class="small">${esc(c.cep||'')}</span></td>
        <td class="n">${(+c.peso_taxado).toLocaleString('pt-BR')}</td><td class="n">${brl(+c.valor_nf)}</td><td>${esc(c.melhor_transportadora)}${c.transportadora_escolhida&&c.transportadora_escolhida!==c.melhor_transportadora?`<br><span class="small">escolhida: ${esc(c.transportadora_escolhida)} (${brl(+c.valor_escolhido)})</span>`:''}</td>
        <td class="n">${brl(+c.melhor_valor)}</td><td>${c.melhor_prazo?fp(c.melhor_prazo):'—'}</td></tr>`).join(''):'';
    $('h_tab').querySelectorAll('tr.lin').forEach(tr=>tr.onclick=()=>detalheHistorico(tr.dataset.id));
  }catch(e){ $('h_status').textContent='Erro ao carregar o histórico: '+e.message; }
}
async function detalheHistorico(id){
  $('h_det').innerHTML='<div class="card small">Carregando…</div>';
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
      ${nc.length?`<p class="small">Sem cotação: ${nc.map(n=>esc(n.transportadora)).join(', ')}</p>`:''}</div>`;
    $('h_det').scrollIntoView({behavior:'smooth'});
  }catch(e){ $('h_det').innerHTML='<div class="card small err">Erro: '+esc(e.message)+'</div>'; }
}

renderTab(); setDest({uf:'SP',cidade:'CAMPINAS'});
}
