import http from 'node:http';
import {URL} from 'node:url';

const PORT=Number(process.env.PORT||10000);
const GATE=process.env.NODE_ENV==='test'&&process.env.WHAPI_TEST_GATE?process.env.WHAPI_TEST_GATE:'https://gate.whapi.cloud';
const tools=[
{name:'whapi_check_channel',description:'Read-only check of existing WHAPI.Cloud commercial channel authentication.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
{name:'whapi_list_stories',description:'Read recent Whapi WhatsApp Status stories, for reconciliation before retries.',inputSchema:{type:'object',properties:{count:{type:'integer',minimum:1,maximum:100,default:20},offset:{type:'integer',minimum:0,default:0},from_me:{type:'boolean',default:true}},additionalProperties:false}},
{name:'whapi_get_story',description:'Verify an existing Whapi WhatsApp Status by provider message ID.',inputSchema:{type:'object',properties:{message_id:{type:'string',minLength:4,maxLength:160}},required:['message_id'],additionalProperties:false}},
{name:'whapi_publish_status_media',description:'REAL WhatsApp Status media post (not chat message). Requires explicit confirm_publish=true, HTTPS JPEG, and unique idempotency_key. Do not call a second time after an ambiguous timeout until provider reconciliation. No scheduling in this tool.',inputSchema:{type:'object',properties:{media_url:{type:'string',format:'uri',minLength:12,maxLength:4096},caption:{type:'string',maxLength:1000},idempotency_key:{type:'string',minLength:12,maxLength:160},confirm_publish:{type:'boolean',const:true}},required:['media_url','idempotency_key','confirm_publish'],additionalProperties:false}}
];
const inProcess=new Map();
const rpc=(id,result)=>({jsonrpc:'2.0',id,result});
const rpcErr=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const result=(data,isError=false)=>({content:[{type:'text',text:JSON.stringify(data)}],isError});
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
function token(req){const m=/^Bearer ([^\s]{10,500})$/.exec(req.headers.authorization||'');return m?m[1]:null}
async function callWhapi(token,path,method='GET',body){
 const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),23000);
 try{
  const response=await fetch(GATE+path,{method,redirect:'error',headers:{Authorization:'Bearer '+token,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:ctrl.signal});
  let data; const raw=await response.text();try{data=JSON.parse(raw)}catch{data={error:raw.slice(0,160)}}
  if(!response.ok)return {ok:false,status:response.status,error:String(data.error||data.message||data.description||'Whapi rejected request').slice(0,180)};
  return {ok:true,status:response.status,data}
 }catch(e){return {ok:false,status:503,error:e.name==='AbortError'?'Whapi timeout':'Whapi unavailable'}}
 finally{clearTimeout(timer)}
}
async function execute(name,args,auth){
 if(!auth)return result({ok:false,error:'CHANNEL_TOKEN_NOT_CONNECTED',hint:'Connect your existing Whapi token as the Composio custom toolkit API_KEY Bearer credential, never in the URL.'},true);
 const a=args&&typeof args==='object'&&!Array.isArray(args)?args:{};
 if(name==='whapi_check_channel')return result(await callWhapi(auth,'/health'));
 if(name==='whapi_list_stories'){
  const count=Number.isInteger(a.count)?a.count:20,offset=Number.isInteger(a.offset)?a.offset:0;
  if(count<1||count>100||offset<0)return result({error:'INVALID_PAGINATION'},true);
  return result(await callWhapi(auth,'/stories?count='+count+'&offset='+offset+'&from_me='+(a.from_me===false?'false':'true')));
 }
 if(name==='whapi_get_story'){
  if(typeof a.message_id!=='string'||!/^[A-Za-z0-9._-]{4,160}$/.test(a.message_id))return result({error:'INVALID_STORY_ID'},true);
  return result(await callWhapi(auth,'/stories/'+encodeURIComponent(a.message_id)));
 }
 if(name==='whapi_publish_status_media'){
  if(a.confirm_publish!==true)return result({error:'EXPLICIT_CONFIRM_PUBLISH_REQUIRED'},true);
  if(typeof a.idempotency_key!=='string'||!/^[A-Za-z0-9:_.-]{12,160}$/.test(a.idempotency_key))return result({error:'INVALID_IDEMPOTENCY_KEY'},true);
  let url;try{url=new URL(a.media_url)}catch{return result({error:'INVALID_MEDIA_URL'},true)}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hostname==='localhost'||url.hostname.endsWith('.local')||/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname))return result({error:'PUBLIC_HTTPS_MEDIA_REQUIRED'},true);
  if(a.caption!==undefined&&(typeof a.caption!=='string'||a.caption.length>1000))return result({error:'INVALID_CAPTION'},true);
  const key=a.idempotency_key;
  if(inProcess.has(key))return result({error:'DUPLICATE_OR_UNCERTAIN_RETRY',receipt:inProcess.get(key)},true);
  inProcess.set(key,{status:'IN_PROGRESS',time:new Date().toISOString()});
  const output=await callWhapi(auth,'/stories/send/media','POST',{media:url.toString(),mime_type:'image/jpeg',...(a.caption?{caption:a.caption}:{})});
  if(output.ok){
   const receipt={status:'ACCEPTED_BY_WHAPI',response:output.data,time:new Date().toISOString()};
   inProcess.set(key,receipt);
   return result({ok:true,receipt,warning:'Persist receipt externally; verify status through whapi_get_story. Acceptance is not a view confirmation.'});
  }
  inProcess.set(key,{status:output.status===503?'UNCERTAIN':'FAILED_RECONCILE',http_status:output.status,time:new Date().toISOString()});
  return result({ok:false,error:output.error,status:output.status,warning:'Reconcile via whapi_list_stories before any retry; in-memory deduplication does not survive restarts.'},true)
 }
 return result({error:'UNKNOWN_TOOL'},true);
}
async function parse(req){let size=0,buf=[];for await(const c of req){size+=c.length;if(size>1048576)throw Error('TOO_LARGE');buf.push(c)}return JSON.parse(Buffer.concat(buf).toString())}
const server=http.createServer(async(req,res)=>{
 const path=(req.url||'').split('?')[0];
 if(req.method==='GET'&&path==='/health')return reply(res,200,{ok:true,service:'sami-whapi-composio-mcp',tools:tools.length,token_stored:false});
 if(path!=='/mcp')return reply(res,404,{error:'Not found'});
 if(req.method!=='POST')return reply(res,405,{error:'POST required'});
 let q;try{q=await parse(req)}catch(e){return reply(res,e.message==='TOO_LARGE'?413:400,rpcErr(null,-32700,'Invalid JSON'))}
 if(Array.isArray(q)||!q||q.jsonrpc!=='2.0')return reply(res,400,rpcErr(null,-32600,'Invalid MCP JSON-RPC'));
 if(q.method==='notifications/initialized'||q.method?.startsWith('notifications/')){res.writeHead(202);return res.end()}
 if(q.method==='initialize')return reply(res,200,rpc(q.id,{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'sami-whapi-composio-mcp',version:'0.1.0'}}));
 if(q.method==='ping')return reply(res,200,rpc(q.id,{}));
 if(q.method==='tools/list')return reply(res,200,rpc(q.id,{tools}));
 if(q.method==='tools/call'){
  const name=q.params?.name;
  if(!tools.some(x=>x.name===name))return reply(res,200,rpcErr(q.id,-32601,'Unknown MCP tool'));
  try{return reply(res,200,rpc(q.id,await execute(name,q.params?.arguments,token(req))))}
  catch{return reply(res,200,rpc(q.id,result({error:'MCP_INTERNAL_ERROR'},true)))}
 }
 return reply(res,200,rpcErr(q.id??null,-32601,'MCP method not found'))
});
if(process.env.NODE_ENV!=='test'||process.env.RUN_TEST_SERVER==='1')server.listen(PORT,'0.0.0.0',()=>process.stdout.write('MCP bridge listening on '+PORT+'\n'));
export {server,tools,execute};
