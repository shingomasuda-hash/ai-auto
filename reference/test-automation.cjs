const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
let tables={},properties={},sent=[],calls=[],graphImpl=()=>({}),quota=100;
const ctx={console,Date,JSON,Math,String,Number,Array,Object,RegExp,encodeURIComponent,
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>properties[k]=v,setProperties:o=>Object.assign(properties,o)})},
 Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()],computeHmacSha256Signature:(s,k)=>[...crypto.createHmac('sha256',k).update(s).digest()],base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url'),formatDate:()=>new Date().toISOString().slice(0,13)},
 HtmlService:{createHtmlOutput:s=>s},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
 MailApp:{getRemainingDailyQuota:()=>quota,sendEmail:o=>sent.push(o)},SpreadsheetApp:{flush:()=>{}},
 EMAIL_SEQUENCE:[{day:0,subject:'free',body:'{{FREE_URL}}'},{day:3,subject:'sale',body:'{{STARTER_URL}}'}],FREE_TEXT:'free',SEED_POSTS:[],SEED_FACTS:[]};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+'/Code.gs','utf8'),ctx);
ctx.rows_=n=>(tables[n]||[]).map(r=>[...r]);ctx.save_=(n,i,r)=>tables[n][i]=[...r];ctx.append_=(n,r)=>(tables[n]??=[]).push([...r]);ctx.graph_=(...a)=>{calls.push(a);return graphImpl(...a);};ctx.sheet_=()=>({deleteRow:()=>{}});ctx.report_=()=>{};
function reset(){tables={Posts:[],Subscribers:[]};properties={WEB_APP_URL:'https://script.google.com/macros/s/test/exec',FORM_SECRET:'test',SENDER_CONTACT:'owner@example.test',SENDER_ADDRESS:'Test address',THREADS_USER_ID:'me',MAIL_ENABLED:'true'};sent=[];calls=[];quota=100;graphImpl=()=>({});}
function post(state='APPROVED'){return ['p',new Date(Date.now()-60000).toISOString(),'howto','topic','素材を確認してください。',state,'container','',new Date(Date.now()-120000).toISOString(),'','','','','','','F01'];}
function subscriber(){return ['reader@example.test','ACTIVE','','','unsub',new Date(Date.now()-86400000).toISOString(),0,'IDLE',new Date().toISOString(),'profile','v1'];}
let count=0;function test(name,f){reset();f();count++;console.log('PASS '+name);}
test('blocks long and ungrounded generated text',()=>{assert(ctx.validPost_('入力を確認してください'));assert(!ctx.validPost_('あ'.repeat(451)));assert(!ctx.validPost_('実際に作ったサイトです'));assert(!ctx.validPost_('https://example.com'));});
test('approved creates container without publishing',()=>{tables.Posts=[post()];graphImpl=()=>({id:'c1'});ctx.publishOne_();assert.equal(tables.Posts[0][5],'CONTAINER');assert.equal(calls.length,1);});
test('ready container publishes once',()=>{tables.Posts=[post('CONTAINER')];graphImpl=p=>p==='container'?{status:'FINISHED'}:{id:'published'};ctx.publishOne_();ctx.publishOne_();assert.equal(tables.Posts[0][5],'PUBLISHED');assert.equal(calls.length,2);});
test('ambiguous publication is quarantined, never retried',()=>{tables.Posts=[post('CONTAINER')];graphImpl=p=>{if(p==='container')return {status:'FINISHED'};throw Error('timeout');};ctx.publishOne_();ctx.publishOne_();assert.equal(tables.Posts[0][5],'UNKNOWN');assert.equal(calls.length,2);});
test('stale in-flight publication is quarantined',()=>{const p=post('PUBLISHING');p[8]=new Date(Date.now()-20*60000).toISOString();tables.Posts=[p];ctx.publishOne_();assert.equal(tables.Posts[0][5],'UNKNOWN');assert.equal(calls.length,0);});
test('duplicates are not republished',()=>{const a=post(),b=post('PUBLISHED');b[8]=new Date(Date.now()-3*3600000).toISOString();tables.Posts=[a,b];ctx.publishOne_();assert.equal(tables.Posts[0][5],'DUPLICATE');});
test('missed days expire instead of bulk catchup',()=>{const p=post();p[1]=new Date(Date.now()-2*86400000).toISOString();tables.Posts=[p];ctx.publishOne_();assert.equal(tables.Posts[0][5],'EXPIRED');});
test('daily publication cap',()=>{tables.Posts=[post(),...Array.from({length:3},(_,i)=>{const p=post('PUBLISHED');p[4]='previous '+i;p[8]=new Date(Date.now()-(i+3)*3600000).toISOString();return p;})];ctx.publishOne_();assert.equal(calls.length,0);});
test('email requires confirmed active state',()=>{const s=subscriber();s[1]='PENDING';tables.Subscribers=[s];ctx.mailBatch_();assert.equal(sent.length,0);});
test('email step sent once with opt-out footer',()=>{tables.Subscribers=[subscriber()];ctx.mailBatch_();ctx.mailBatch_();assert.equal(sent.length,1);assert(sent[0].body.includes('action=unsubscribe'));assert.equal(tables.Subscribers[0][6],1);});
test('quota leaves state untouched',()=>{quota=0;tables.Subscribers=[subscriber()];ctx.mailBatch_();assert.equal(sent.length,0);assert.equal(tables.Subscribers[0][6],0);});
test('unknown mail delivery does not auto-retry',()=>{const s=subscriber();s[7]='SENDING';s[8]=new Date(Date.now()-20*60000).toISOString();tables.Subscribers=[s];ctx.mailBatch_();ctx.mailBatch_();assert.equal(sent.length,0);assert.equal(tables.Subscribers[0][7],'UNKNOWN');});
test('unsubscribe prevents all subsequent marketing',()=>{tables.Subscribers=[subscriber()];ctx.doPost({parameter:{action:'unsubscribe',token:'unsub'}});ctx.mailBatch_();assert.equal(tables.Subscribers[0][1],'UNSUBSCRIBED');assert.equal(sent.length,0);});
test('confirmation is single use and time bounded',()=>{const s=subscriber();s[1]='PENDING';s[2]=ctx.hash_('token');s[3]=new Date(Date.now()+60000).toISOString();tables.Subscribers=[s];ctx.confirm_('token');assert.equal(tables.Subscribers[0][1],'ACTIVE');assert.equal(tables.Subscribers[0][2],'');});
test('signed form challenge detects tampering',()=>{const v=String(Date.now()-3000);assert(ctx.validChallenge_(v+'.'+ctx.sign_(v)));assert(!ctx.validChallenge_(v+'.wrong'));});
console.log(count+' tests passed. All external services mocked; no live delivery tested.');
