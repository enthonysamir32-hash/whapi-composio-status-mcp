import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
let mock,proc,url;
before(async()=>{
 mock=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(!req.headers.authorization){res.statusCode=401;return res.end(JSON.stringify({error:'NO_TOKEN'}))}
  if(req.url==='/health')return res.end(JSON.stringify({status:{text:'AUTH'}}));
  if(req.url.startsWith('/stories?'))return res.end(JSON.stringify({stories:[]}));
  if(req.url.startsWith('/stories/')&&req.method==='GET')return res.end(JSON.stringify({id:req.url.split('/').at(-1)}));
  if(req.url==='/stories/send/media'&&req.method==='POST'){
   let s='';req.on('data',x=>s+=x);return req.on('end',()=>res.end(JSON.stringify({id:'test-story-1000',...JSON.parse(s)})))
  }
  res.statusCode=404;res.end(JSON.stringify({error:'NOT_FOUND'}));
 });
 await new Promise(ok=>mock.listen(0,'127.0.0.1',ok));
 const port=33000+Math.floor(Math.random()*10000);
 url='http://127.0.0.1:'+port;
 const serverPath=new URL('../server.mjs',import.meta.url).pathname;
 proc=spawn(process.execPath,[serverPath],{env:{...process.env,PORT:String(port),NODE_ENV:'test',RUN_TEST_SERVER:'1',WHAPI_TEST_GATE:'http://127.0.0.1:'+mock.address().port}});
 let active=false;
 for(let i=0;i<70;i++){try{if((await fetch(url+'/health')).ok){active=true;break}}catch{}await delay(50)}
 assert.ok(active,'bridge did not start');
});
after(async()=>{proc?.kill();await new Promise(ok=>mock.close(ok))});
async function rpc(method,params={},bearer){
 const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
 if(bearer)headers.Authorization='Bearer '+bearer;
 const r=await fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 return {status:r.status,data:await r.json()};
}
test('MCP handshake and tool discovery without credentials',async()=>{
 const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'smoke',version:'1'}});
 assert.equal(init.data.result.protocolVersion,'2025-06-18');
 assert.equal((await rpc('tools/list')).data.result.tools.length,4);
});
test('token required for Whapi calls',async()=>{
 const r=await rpc('tools/call',{name:'whapi_check_channel',arguments:{}});
 assert.equal(r.data.result.isError,true);
});
test('existing authorized Whapi token passes through to health',async()=>{
 const r=await rpc('tools/call',{name:'whapi_check_channel',arguments:{}},'TEST_TOKEN_123456789');
 assert.equal(r.data.result.isError,false);
 assert.match(r.data.result.content[0].text,/AUTH/);
});
test('Status publication fails without explicit confirmation',async()=>{
 const a={media_url:'https://example.com/bench.jpg',idempotency_key:'SAMI-20261125-1'};
 const r=await rpc('tools/call',{name:'whapi_publish_status_media',arguments:a},'TEST_TOKEN_123456789');
 assert.equal(r.data.result.isError,true);
 assert.match(r.data.result.content[0].text,/CONFIRM/);
});
test('Status media calls WHAPI once and prevents in-process repeat',async()=>{
 const a={media_url:'https://example.com/bench.jpg',idempotency_key:'SAMI-20261125-1',confirm_publish:true};
 const one=await rpc('tools/call',{name:'whapi_publish_status_media',arguments:a},'TEST_TOKEN_123456789');
 assert.equal(one.data.result.isError,false);
 assert.match(one.data.result.content[0].text,/ACCEPTED_BY_WHAPI/);
 const two=await rpc('tools/call',{name:'whapi_publish_status_media',arguments:a},'TEST_TOKEN_123456789');
 assert.equal(two.data.result.isError,true);
 assert.match(two.data.result.content[0].text,/DUPLICATE/);
});
test('Story list and exact story verification',async()=>{
 const auth='TEST_TOKEN_123456789';
 const list=await rpc('tools/call',{name:'whapi_list_stories',arguments:{}},auth);
 assert.equal(list.data.result.isError,false);
 const get=await rpc('tools/call',{name:'whapi_get_story',arguments:{message_id:'story-1234'}},auth);
 assert.equal(get.data.result.isError,false);
});
