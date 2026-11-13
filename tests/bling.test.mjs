import { pedirToken, tokenValido, buscarPedido, BLING } from '../src/bling.js';
const env={BLING_CLIENT_ID:'cid',BLING_CLIENT_SECRET:'sec'};
const log=[]; let ok=0, fail=0;
const t=(nome,cond)=>{ cond?ok++:fail++; console.log((cond?'OK  ':'FALHA ')+nome); };
// 1) pedido de token
let req;
const fTok=async(url,opt)=>{ req={url,opt}; return {ok:true,status:200,json:async()=>({access_token:'A1',refresh_token:'R1',expires_in:21600})}; };
const tk=await pedirToken(env,{grant_type:'authorization_code',code:'XYZ'},fTok);
t('token url', req.url===BLING.tokenUrl);
t('basic auth', req.opt.headers.authorization==='Basic '+btoa('cid:sec'));
t('corpo form', req.opt.body==='grant_type=authorization_code&code=XYZ');
t('expira ~6h', Math.abs(tk.expira_em-Date.now()-21600e3)<5000);
// erro do Bling
try{ await pedirToken(env,{grant_type:'x'},async()=>({ok:false,status:400,json:async()=>({error:{type:'invalid_grant',description:'code expirado'}})})); t('erro token',false);}catch(e){ t('erro token msg: '+e.message, /code expirado/.test(e.message)); }
// 2) tokenValido com banco falso
function fakeDb(row){ const q=[]; return {q, row, async query(sql,p){ q.push(sql.trim().split(/\s+/).slice(0,3).join(' '));
  if(/^SELECT access_token, expira_em/.test(sql.trim())) return {rows:this.row?[this.row]:[]};
  if(/FOR UPDATE/.test(sql)) return {rows:[this.row]};
  if(/^INSERT INTO bling_tokens/.test(sql.trim())){ this.row={access_token:p[0],refresh_token:p[1],expira_em:p[2]}; return {rows:[]}; }
  return {rows:[]}; } }; }
let db=fakeDb({access_token:'VIVO',refresh_token:'R0',expira_em:new Date(Date.now()+3600e3)});
t('token válido sem renovar', await tokenValido(env,db,fTok)==='VIVO' && db.q.length===1);
db=fakeDb({access_token:'VELHO',refresh_token:'R0',expira_em:new Date(Date.now()-1000)});
let corpoRefresh;
const tk2=await tokenValido(env,db,async(u,o)=>{ corpoRefresh=o.body; return {ok:true,status:200,json:async()=>({access_token:'NOVO',refresh_token:'R2',expires_in:21600})}; });
t('renovou token', tk2==='NOVO' && /refresh_token=R0/.test(corpoRefresh) && db.row.refresh_token==='R2');
t('transação BEGIN/COMMIT', db.q.includes('BEGIN') && db.q.includes('COMMIT'));
db=fakeDb(null);
try{ await tokenValido(env,db,fTok); t('sem conexão',false);}catch(e){ t('sem conexão → '+e.codigo, e.codigo==='desconectado' && e.status===409); }
// 3) buscarPedido
const pedidoDet={data:{id:999,numero:1234,data:'2026-11-12',contato:{id:55,nome:'Irisvan Cavalcante'},totalProdutos:3283.35,total:3283.35,
  transporte:{frete:0,pesoBruto:190,quantidadeVolumes:10,etiqueta:{cep:'65.901-307',municipio:'Imperatriz',uf:'MA'}}}};
const chamadas=[];
const fApi=(det,contato)=>async(url)=>{ chamadas.push(url.replace(BLING.apiBase,''));
  if(url.includes('/pedidos/vendas?')) return {ok:true,status:200,json:async()=>({data:[{id:111,numero:12340},{id:999,numero:1234}]})};
  if(url.includes('/pedidos/vendas/999')) return {ok:true,status:200,json:async()=>det};
  if(url.includes('/contatos/55')) return {ok:true,status:200,json:async()=>contato};
  return {ok:false,status:404,json:async()=>({})}; };
let p=await buscarPedido('TK','1234',fApi(pedidoDet));
t('pedido certo (ignora 12340)', p.id===999 && p.numero==='1234');
t('cep etiqueta', p.cep==='65901307' && p.uf==='MA' && p.origemCep==='etiqueta de transporte');
t('peso/volumes/valor', p.pesoBruto===190 && p.volumes===10 && p.valorProdutos===3283.35 && p.cliente==='Irisvan Cavalcante');
const semEt=JSON.parse(JSON.stringify(pedidoDet)); semEt.data.transporte.etiqueta={};
p=await buscarPedido('TK','1234',fApi(semEt,{data:{endereco:{geral:{cep:'57400-000',municipio:'Pão de Açúcar',uf:'AL'}}}}));
t('cep do cadastro do cliente', p.cep==='57400000' && p.origemCep==='cadastro do cliente');
try{ await buscarPedido('TK','777',fApi(pedidoDet)); t('não encontrado',false);}catch(e){ t('não encontrado → '+e.message, e.status===404); }
try{ await buscarPedido('TK','1234',async()=>({ok:false,status:401,json:async()=>({})})); t('401',false);}catch(e){ t('401 → desconectado', e.codigo==='desconectado'); }
console.log(`\n${ok} ok, ${fail} falhas`); process.exit(fail?1:0);
