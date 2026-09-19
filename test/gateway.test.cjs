const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(new URL('../server.js', `file://${__filename}`), 'utf8').replace(/^import .*;\n/gm, '').replace('import.meta.url', '"file:///app/server.js"');
function setup(env = {}, fetchImpl = async () => ({ok:true,status:200,json:async()=>({result:{response:'OK'}})})) {
  const routes = {}; const calls = [];
  const express = () => ({use(){},get(p,f){routes[p]=f},post(p,f){routes[p]=f},listen(){}});
  express.json = express.static = () => {};
  const context = {express, fs:{existsSync:()=>false,mkdirSync(){}},path:require('node:path'),fileURLToPath:require('node:url').fileURLToPath,
    Database:class {exec(){} prepare(){return {run(){}}}},process:{env:{CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'secret',AI_GATEWAY_ID:'test-gateway',...env}},console,
    fetch:async(...args)=>{calls.push(args);return fetchImpl(...args)}};
  vm.runInNewContext(source,context); return {routes,calls};
}
function response(){return {statusCode:200,status(n){this.statusCode=n;return this},json(d){this.data=d;return this}}}
const request = {body:{messages:[{role:'user',content:'Hello'}]}};
test('Gateway header and universal payload, no direct model endpoint', async()=>{
  const {routes,calls}=setup();const res=response();await routes['/api/chat'](request,res);
  assert.equal(res.data.reply,'OK');assert.equal(calls.length,1);assert.equal(calls[0][0],'https://api.cloudflare.com/client/v4/accounts/account/ai/run');
  assert.equal(calls[0][1].headers['cf-aig-gateway-id'],'test-gateway');
  assert.equal(JSON.parse(calls[0][1].body).input.max_tokens,1024);
});
test('429 stops without retry or fallback',async()=>{
 const {routes,calls}=setup({},async()=>({ok:false,status:429}));const res=response();await routes['/api/chat'](request,res);
 assert.equal(res.statusCode,429);assert.equal(calls.length,1);
});
test('Missing gateway refuses startup',()=>assert.throws(()=>setup({AI_GATEWAY_ID:''}),/AI_GATEWAY_ID/));
test('Oversized input is rejected before inference',async()=>{
 const {routes,calls}=setup();const res=response();await routes['/api/chat']({body:{messages:[{role:'user',content:'a'.repeat(16001)}]}},res);
 assert.equal(res.statusCode,400);assert.equal(calls.length,0);
});
test('Concurrent request is rejected, lock released after completion',async()=>{
 let release;const pending=new Promise(r=>release=r);
 const {routes,calls}=setup({},async()=>{await pending;return {ok:true,status:200,json:async()=>({result:{response:'OK'}})}});
 const first=routes['/api/chat'](request,response());const second=response();await routes['/api/chat'](request,second);
 assert.equal(second.statusCode,429);assert.equal(calls.length,1);release();await first;
 const third=response();await routes['/api/chat'](request,third);assert.equal(third.statusCode,200);
});
