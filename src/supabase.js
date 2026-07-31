export const __table = { rows: [], failNext: null };
export function __reset(rows = []) { __table.rows = rows.map(r=>({...r})); __table.failNext = null; }
const NN=["crc_client_id","client_display_name","ai_initialized","current_round","processing_state","process_complete","credit_hero_access_state"];
const PS=["ready","processing","waiting","blocked","complete"], AS=["active","inactive","unknown"];
function val(r){for(const c of NN)if(r[c]==null)return `null value in column "${c}" violates not-null constraint`;
if(!Number.isInteger(r.current_round)||r.current_round<1||r.current_round>6)return 'new row violates check constraint "client_state_current_round_check"';
if(!PS.includes(r.processing_state))return 'new row violates check constraint "client_state_processing_state_check"';
if(!AS.includes(r.credit_hero_access_state))return 'new row violates check constraint "client_state_credit_hero_access_state_check"';
if(r.negative_items_remaining!=null&&r.negative_items_remaining<0)return 'new row violates check constraint "client_state_negative_items_check"';return null;}
function q(kind,payload,opts){const f=[];let sel=false;const api={
eq(c,v){f.push([c,v]);return api;},in(c,v){f.push([c,v,"in"]);return api;},order(){return api;},limit(){return api;},select(){sel=true;return api;},
is(c,v){f.push([c,v,"is"]);return api;},not(c,op,v){f.push([c,v,"not_"+op]);return api;},
match(r){return f.every(x=>{
  if(x[2]==="in")return x[1].includes(r[x[0]]);
  if(x[2]==="is")return x[1]===null?(r[x[0]]==null):(r[x[0]]===x[1]);
  if(x[2]==="not_is")return x[1]===true?(r[x[0]]!==true):(r[x[0]]!==x[1]);
  return String(r[x[0]])===String(x[1]);
});},
async maybeSingle(){return api.__run(true);},then(res,rej){return api.__run(false).then(res,rej);},
async __run(single){if(__table.failNext){const m=__table.failNext;__table.failNext=null;return{data:null,error:{message:m}};}
if(kind==="upsert"){const ex=__table.rows.some(r=>String(r.crc_client_id)===String(payload.crc_client_id));
if(ex){if(opts&&opts.ignoreDuplicates)return{data:sel?[]:null,error:null};return{data:null,error:{message:"duplicate key value violates unique constraint"}};}
const v=val(payload);if(v)return{data:null,error:{message:v}};
__table.rows.push({...payload,updated_at:new Date().toISOString(),manual_review_active:payload.manual_review_active===true});return{data:sel?[{...payload}]:null,error:null};}
if(kind==="update"){const t=__table.rows.find(api.match);if(!t)return{data:single?null:[],error:null};
const v=val({...t,...payload});if(v)return{data:null,error:{message:v}};Object.assign(t,payload);return{data:single?{...t}:[{...t}],error:null};}
const found=__table.rows.filter(api.match);return{data:single?(found.length?{...found[0]}:null):found,error:null};}};return api;}
export function getSupabase(){return{from(){return{upsert:(p,o)=>q("upsert",p,o),update:p=>q("update",p),insert:p=>q("upsert",p,{ignoreDuplicates:false}),select:()=>q("select")};}};}
