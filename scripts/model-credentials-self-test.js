import assert from 'node:assert/strict';
import { resolveModelCredential } from '../src/model-credentials.js';
const ai = { provider:'xiaomi', baseUrl:'https://api.xiaomimimo.com/v1', args:['-p','sample'], apiKeyEnv:'XIAOMI_API_KEY' };
const fixture = { env:{HERMES_HOME:'/fixture'}, stat:()=>({isFile:()=>true,size:100,mode:0o100600,uid:process.getuid()}),
  read:()=>JSON.stringify({credential_pool:{xiaomi:[{auth_type:'api_key',access_token:'fake-fixture-only-value',base_url:ai.baseUrl}]}}) };
assert.equal(resolveModelCredential(ai,fixture),'fake-fixture-only-value');
assert.equal(resolveModelCredential({...ai,args:[]},fixture),null);
assert.equal(resolveModelCredential({...ai,baseUrl:'https://other.example/v1'},fixture),null);
assert.equal(resolveModelCredential({...ai,baseUrl:'https://api.xiaomimimo.com/other'},fixture),null);
assert.equal(resolveModelCredential({...ai,provider:'custom'},fixture),null);
assert.equal(resolveModelCredential(ai,{...fixture,env:{XIAOMI_API_KEY:'explicit-fixture'}}),'explicit-fixture');
assert.equal(resolveModelCredential(ai,{...fixture,stat:()=>({isFile:()=>false})}),null);
assert.equal(resolveModelCredential(ai,{...fixture,stat:()=>({isFile:()=>true,size:100,mode:0o100644,uid:process.getuid()})}),null);
assert.throws(()=>resolveModelCredential({...ai,credentialSource:'keychain'}, {...fixture,getApiSecret:()=>null}),{code:'MODEL_CREDENTIAL_UNAVAILABLE'});
assert.equal(resolveModelCredential({...ai,credentialSource:'keychain'}, {...fixture,getApiSecret:()=> 'keychain-fixture'}),'keychain-fixture');
assert.equal(resolveModelCredential(ai,{...fixture,read:()=>'{broken'}),null);
console.log('model credential selection: 11 assertions PASS');
