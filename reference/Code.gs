/** AnyWare AI launch v1. Google Apps Script V8. No secrets in this file.
 * All administrator functions end in _ and cannot be invoked via google.script.run.
 * SeedContent.gs must be installed alongside this file.
 */
const TABLES_={Posts:['id','due','category','topic','text','status','container_id','post_id','updated','error','views','likes','replies','reposts','quotes','source_id'],Subscribers:['email','status','confirm_hash','confirm_expires','unsubscribe_token','confirmed_at','step','mail_state','updated','source','consent_version'],Facts:['id','text','approved'],Reports:['created','kind','body'],Sales:['order_id','product','amount','purchased_at','source']};
function props_(){return PropertiesService.getScriptProperties();}
function cfg_(k,d){const v=props_().getProperty(k);return v===null?d:v;}
function enabled_(k){return cfg_(k,'false')==='true';}
function require_(k){const v=cfg_(k,'');if(!v)throw new Error('Missing setting: '+k);return v;}
function setup_(){
  const p=props_();let id=p.getProperty('SHEET_ID');
  if(!id){id=SpreadsheetApp.create('AnyWare AI自動化・運用管理').getId();p.setProperty('SHEET_ID',id);}
  const book=SpreadsheetApp.openById(id);book.setSpreadsheetTimeZone('Asia/Tokyo');
  Object.keys(TABLES_).forEach(n=>{let s=book.getSheetByName(n);if(!s)s=book.insertSheet(n);if(!s.getLastRow()){s.appendRow(TABLES_[n]);s.setFrozenRows(1);}});
  const defaults={RUN_ENABLED:'false',MAIL_ENABLED:'false',GENERATE_ENABLED:'false',AUTO_APPROVE_GENERATED:'false',THREADS_API_VERSION:'v1.0',BRAND:'AnyWare',CONSENT_VERSION:'v1',MAX_CONFIRM_PER_HOUR:'20'};
  Object.keys(defaults).forEach(k=>{if(p.getProperty(k)===null)p.setProperty(k,defaults[k]);});
  if(!p.getProperty('FORM_SECRET'))p.setProperty('FORM_SECRET',Utilities.getUuid()+Utilities.getUuid());
  if(rows_('Posts').length===0)SEED_POSTS.forEach(x=>append_('Posts',[x.id,'',x.category,x.topic,x.text,'DRAFT','','','','','','','','','','F'+String(((Number(x.id.slice(1))-1)/3|0)+1).padStart(2,'0')]));
  if(rows_('Facts').length===0)SEED_FACTS.forEach((x,i)=>append_('Facts',['F'+String(i+1).padStart(2,'0'),x,true]));
  console.log('Setup complete. Open the management sheet from Drive. No posting or email started.');
}
function sheet_(n){return SpreadsheetApp.openById(require_('SHEET_ID')).getSheetByName(n);}
function rows_(n){const s=sheet_(n);return s.getLastRow()<2?[]:s.getRange(2,1,s.getLastRow()-1,TABLES_[n].length).getValues();}
function cellValue_(v){return typeof v==='string'&&/^[=+\-@]/.test(v)?"'"+v:v;}
function append_(n,a){sheet_(n).appendRow(a.map(cellValue_));}
function save_(n,index,a){sheet_(n).getRange(index+2,1,1,a.length).setValues([a.map(cellValue_)]);SpreadsheetApp.flush();}
function locked_(f){const l=LockService.getScriptLock();if(!l.tryLock(1500))throw new Error('Busy; try later');try{return f();}finally{l.releaseLock();}}
function iso_(){return new Date().toISOString();}
function report_(kind,body){append_('Reports',[iso_(),kind,String(body).slice(0,30000)]);}
function validUrl_(u,host){try{const m=String(u).match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/);return !!m&&(!host||m[1]===host);}catch(e){return false;}}
function publicBase_(){const u=require_('WEB_APP_URL');if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u))throw new Error('Invalid WEB_APP_URL');return u;}
function checkReady_(){
  ['SHEET_ID','WEB_APP_URL','SENDER_CONTACT','SENDER_ADDRESS','THREADS_USER_ID','THREADS_ACCESS_TOKEN'].forEach(require_);
  publicBase_();['STARTER_URL','MAIN_URL'].forEach(k=>{if(!validUrl_(require_(k),'note.com'))throw new Error('Set real note article URL: '+k);});
  if(!validUrl_(require_('LANDING_URL')))throw new Error('Set public LANDING_URL');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(require_('SENDER_CONTACT')))throw new Error('Invalid contact');
  graph_('me',{fields:'id,username'},'get');console.log('Settings and Threads identity checked. Purchase and email delivery still require live smoke test.');
}
function installTriggers_(){
  checkReady_();ScriptApp.getProjectTriggers().filter(t=>['tick_','daily_'].includes(t.getHandlerFunction())).forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick_').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('daily_').timeBased().atHour(6).everyDays(1).inTimezone('Asia/Tokyo').create();
  console.log('Triggers installed; RUN_ENABLED and MAIL_ENABLED still control delivery.');
}
function stopAll_(){props_().setProperties({RUN_ENABLED:'false',MAIL_ENABLED:'false',GENERATE_ENABLED:'false'});}
function approveSeedAndSchedule_(){locked_(()=>{
  const r=rows_('Posts'),day=Utilities.formatDate(new Date(Date.now()+86400000),'Asia/Tokyo','yyyy-MM-dd');
  // Interleave topics so the same theme is not posted three times in a row.
  for(let d=0;d<30;d++)for(let k=0;k<3;k++){
    const topic=(d+k*10)%30,id='P'+String(topic*3+k+1).padStart(3,'0'),ix=r.findIndex(x=>x[0]===id);
    if(ix<0||r[ix][5]!=='DRAFT')continue;
    const due=new Date(new Date(day+'T'+['08:10','12:20','20:30'][k]+':00+09:00').getTime()+d*86400000);
    r[ix][1]=due.toISOString();r[ix][5]='APPROVED';save_('Posts',ix,r[ix]);
  }
});}
function graph_(path,params,method){
  if(!/^[A-Za-z0-9_./]+$/.test(path)||!/^v\d+\.\d+$/.test(cfg_('THREADS_API_VERSION','v1.0')))throw new Error('Bad graph path');
  const base='https://graph.threads.net/'+cfg_('THREADS_API_VERSION','v1.0')+'/'+path;
  const opts={method:method||'get',headers:{Authorization:'Bearer '+require_('THREADS_ACCESS_TOKEN')},muteHttpExceptions:true};
  let url=base;if(opts.method==='get'){url+='?'+Object.keys(params).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(params[k])).join('&');}else opts.payload=params;
  const response=UrlFetchApp.fetch(url,opts),code=response.getResponseCode();
  let data;try{data=JSON.parse(response.getContentText());}catch(e){throw new Error('Threads non-JSON HTTP '+code);}
  if(code>=300||data.error)throw new Error('Threads HTTP '+code+' code '+String(data.error&&data.error.code||'unknown'));
  return data;
}
function validPost_(text){return typeof text==='string'&&Array.from(text).length>0&&Array.from(text).length<=450&&!/[{}]|https?:\/\//.test(text)&&!/(私が|弊社では|実際に作った|売上\d|万円稼|必ず稼|絶対に)/.test(text);}
function tick_(){
  if(enabled_('RUN_ENABLED'))try{locked_(publishOne_);}catch(e){report_('publisher','Run failed; inspect settings or Posts status.');}
  if(enabled_('MAIL_ENABLED'))try{locked_(mailBatch_);}catch(e){report_('mail','Run failed; inspect Subscribers status.');}
}
function publishOne_(){
  const r=rows_('Posts'),now=Date.now();
  // Any interrupted mutation is ambiguous: quarantine it, never republish blindly.
  r.forEach((x,i)=>{if(['CREATING','PUBLISHING'].includes(x[5])&&now-new Date(x[8]).getTime()>10*60000){x[5]='UNKNOWN';x[9]='Interrupted request; reconcile in Threads before resetting.';save_('Posts',i,x);}});
  const candidates=r.map((x,i)=>({x,i})).filter(o=>['APPROVED','CONTAINER'].includes(o.x[5])&&o.x[1]&&new Date(o.x[1]).getTime()<=now).sort((a,b)=>new Date(a.x[1])-new Date(b.x[1]));
  if(!candidates.length)return;const {x,i}=candidates[0];
  if(!validPost_(x[4])){x[5]='REVIEW';x[9]='Invalid or ungrounded content';save_('Posts',i,x);return;}
  if(r.some(y=>y!==x&&y[5]==='PUBLISHED'&&y[4]===x[4])){x[5]='DUPLICATE';save_('Posts',i,x);return;}
  if(now-new Date(x[1]).getTime()>86400000&&x[5]==='APPROVED'){x[5]='EXPIRED';x[9]='Missed slot; reschedule manually.';save_('Posts',i,x);return;}
  const recent=r.filter(y=>y[5]==='PUBLISHED'&&now-new Date(y[8]).getTime()<86400000);
  if(recent.length>=3||recent.some(y=>now-new Date(y[8]).getTime()<2*3600000))return;
  if(x[5]==='APPROVED'){
    x[5]='CREATING';x[8]=iso_();save_('Posts',i,x);
    try{const d=graph_(require_('THREADS_USER_ID')+'/threads',{media_type:'TEXT',text:x[4]},'post');if(!d.id)throw new Error('No container');x[6]=d.id;x[5]='CONTAINER';x[8]=iso_();save_('Posts',i,x);}catch(e){x[5]='UNKNOWN';x[9]='Container create uncertain; inspect account before retry';save_('Posts',i,x);}return;
  }
  if(now-new Date(x[8]).getTime()<60000)return;
  let status;try{status=graph_(String(x[6]),{fields:'status,error_message'},'get').status;}catch(e){x[9]='Container status unavailable; no publish attempted';save_('Posts',i,x);return;}
  if(status==='IN_PROGRESS')return;
  if(status!=='FINISHED'){x[5]='REVIEW';x[9]='Container status: '+String(status);save_('Posts',i,x);return;}
  x[5]='PUBLISHING';x[8]=iso_();save_('Posts',i,x);
  try{const d=graph_(require_('THREADS_USER_ID')+'/threads_publish',{creation_id:x[6]},'post');if(!d.id)throw new Error('Missing post id');x[7]=d.id;x[5]='PUBLISHED';x[9]='';x[8]=iso_();save_('Posts',i,x);}catch(e){x[5]='UNKNOWN';x[9]='Publication uncertain; check Threads before resetting';save_('Posts',i,x);}
}
function daily_(){
  if(!enabled_('RUN_ENABLED'))return;
  locked_(()=>{collectInsights_();refreshToken_();if(enabled_('GENERATE_ENABLED'))generateDrafts_();summary_();});
}
function collectInsights_(){
  rows_('Posts').forEach((x,i)=>{if(x[5]!=='PUBLISHED'||Date.now()-new Date(x[8]).getTime()>30*86400000)return;
    try{const d=graph_(String(x[7])+'/insights',{metric:'views,likes,replies,reposts,quotes'},'get');
      ['views','likes','replies','reposts','quotes'].forEach((m,j)=>{const found=(d.data||[]).find(v=>v.name===m);x[10+j]=found&&found.values&&found.values.length?found.values[0].value:'';});save_('Posts',i,x);
    }catch(e){/* Missing metrics remain empty, not zero. */}
  });
}
function refreshToken_(){
  const expires=Number(cfg_('THREADS_TOKEN_EXPIRES_AT','0'));if(!expires){report_('token','Set THREADS_TOKEN_EXPIRES_AT (epoch ms) after OAuth exchange.');return;}
  if(expires-Date.now()>10*86400000)return;
  try{const token=require_('THREADS_ACCESS_TOKEN'),r=UrlFetchApp.fetch('https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token='+encodeURIComponent(token),{muteHttpExceptions:true});const d=JSON.parse(r.getContentText());if(r.getResponseCode()>=300||!d.access_token||!d.expires_in)throw new Error('Refresh failed');props_().setProperties({THREADS_ACCESS_TOKEN:d.access_token,THREADS_TOKEN_EXPIRES_AT:String(Date.now()+Number(d.expires_in)*1000)});}catch(e){report_('token','Token refresh failed; reconnect account. No token was logged.');}
}
function generateDrafts_(){
  const posts=rows_('Posts');if(posts.filter(x=>['DRAFT','APPROVED','CONTAINER'].includes(x[5])).length>=12)return;
  const day=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd');if(cfg_('LAST_GENERATION_DAY','')===day)return;
  const facts=rows_('Facts').filter(x=>x[2]===true||x[2]==='TRUE');if(!facts.length)return;
  const ranked=posts.filter(x=>x[5]==='PUBLISHED'&&Number(x[10])>=100).sort((a,b)=>engagement_(b)-engagement_(a)).slice(0,3).map(x=>({topic:x[3],text:x[4]}));
  const prompt='Create exactly 3 different Japanese Threads posts as JSON array [{source_id,topic,text}]. Use only these approved general how-to facts. No invented experience, customers, earnings, statistics, guarantees, current product specifications, links, or first-person claims. Each <=350 Unicode characters. Rephrase helpfully, do not duplicate recent posts. Facts='+JSON.stringify(facts.map(x=>({id:x[0],text:x[1]})))+'; high engagement themes (do not claim sales causality)='+JSON.stringify(ranked)+'; recent='+JSON.stringify(posts.slice(-20).map(x=>x[4]));
  props_().setProperty('LAST_GENERATION_DAY',day);
  try{const r=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{method:'post',contentType:'application/json',headers:{'x-api-key':require_('ANTHROPIC_API_KEY'),'anthropic-version':'2023-06-01'},payload:JSON.stringify({model:require_('ANTHROPIC_MODEL'),max_tokens:1800,messages:[{role:'user',content:prompt}]}),muteHttpExceptions:true});if(r.getResponseCode()>=300)throw new Error('AI HTTP '+r.getResponseCode());
    const raw=JSON.parse(r.getContentText()).content.filter(x=>x.type==='text').map(x=>x.text).join('');const data=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));if(!Array.isArray(data)||data.length!==3)throw new Error('Invalid AI response');
    data.forEach((x,i)=>{if(!facts.some(f=>f[0]===x.source_id)||!validPost_(x.text)||posts.some(p=>p[4]===x.text))return;
      const auto=enabled_('AUTO_APPROVE_GENERATED'),future=posts.filter(p=>p[1]).reduce((m,p)=>Math.max(m,new Date(p[1]).getTime()||0),Date.now());
      append_('Posts',['G'+Utilities.getUuid(),new Date(Math.max(Date.now(),future)+(i+1)*8*3600000).toISOString(),'howto',String(x.topic).slice(0,80),x.text,auto?'APPROVED':'DRAFT','','',iso_(),'','','','','','',x.source_id]);
    });
  }catch(e){report_('generation','Generation failed or invalid. Check API/model settings; retry on next day.');}
}
function engagement_(r){const v=Number(r[10]);return v>0?[11,12,13,14].reduce((a,i)=>a+(Number(r[i])||0),0)/v:0;}
function summary_(){const p=rows_('Posts'),s=rows_('Subscribers'),sales=rows_('Sales');report_('daily',JSON.stringify({published:p.filter(x=>x[5]==='PUBLISHED').length,needs_review:p.filter(x=>['UNKNOWN','REVIEW','EXPIRED'].includes(x[5])).length,active_subscribers:s.filter(x=>x[1]==='ACTIVE').length,sales_recorded:sales.length,revenue_recorded:sales.reduce((n,x)=>n+(Number(x[2])||0),0),attribution:'Sales entered by operator; no automatic note purchaser matching',next_product_candidates:p.filter(x=>Number(x[10])>=100).sort((a,b)=>engagement_(b)-engagement_(a)).slice(0,3).map(x=>x[3])}));}
function esc_(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function html_(title,body){return HtmlService.createHtmlOutput('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><base target="_top"><title>'+esc_(title)+'</title><style>body{max-width:700px;margin:48px auto;padding:20px;font:17px/1.8 sans-serif;color:#142139}input,button{font:inherit;padding:12px;max-width:100%;box-sizing:border-box}input[type=email]{width:100%}button{background:#172dff;color:white;border:0;border-radius:6px;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.trap{display:none}</style></head><body><h1>'+esc_(title)+'</h1>'+body+'</body></html>');}
function hash_(s){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s)).map(b=>(b+256).toString(16).slice(-2)).join('');}
function sign_(v){return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(v,require_('FORM_SECRET')));}
function challenge_(){const x=String(Date.now());return x+'.'+sign_(x);}
function validChallenge_(s){const a=String(s||'').split('.'),age=Date.now()-Number(a[0]);return a.length===2&&age>=2000&&age<3600000&&a[1]===sign_(a[0]);}
function doGet(e){const p=(e&&e.parameter)||{};
  if(p.action==='free')return html_('無料チェックシート','<pre>'+esc_(FREE_TEXT)+'</pre>');
  if(p.action==='confirm'||p.action==='unsubscribe')return html_(p.action==='confirm'?'メール登録の確認':'配信停止','<form method="post" action="'+esc_(publicBase_())+'"><input type="hidden" name="action" value="'+esc_(p.action)+'"><input type="hidden" name="token" value="'+esc_(String(p.token||''))+'"><button type="submit">'+(p.action==='confirm'?'登録を確定する':'配信を停止する')+'</button></form>');
  if(!enabled_('MAIL_ENABLED'))return html_('登録受付の準備中','<p>無料チェックシートは今すぐ読めます。</p><a href="'+esc_(publicBase_())+'?action=free">無料シートを読む</a>');
  return html_('無料シートをメールで受け取る','<p>Web制作のチェックシートと、制作のヒント・関連商品の案内（全5通）をお送りします。いつでも配信停止できます。</p><form method="post" action="'+esc_(publicBase_())+'"><input type="hidden" name="action" value="subscribe"><input type="hidden" name="challenge" value="'+esc_(challenge_())+'"><input type="hidden" name="source" value="'+esc_(String(p.utm_content||p.source||'profile').slice(0,80))+'"><div class="trap"><input name="company_site" tabindex="-1" autocomplete="off"></div><label>メールアドレス<input required type="email" name="email" maxlength="254" autocomplete="email"></label><p><label><input required type="checkbox" name="consent" value="yes">特典と商品案内メールの受信に同意します</label></p><button>確認メールを送る</button></form><p>運営：'+esc_(cfg_('BRAND','AnyWare'))+'<br>連絡先：'+esc_(require_('SENDER_CONTACT'))+'</p><p>入力されたメールアドレス・登録経路・同意情報は特典と案内の配信、停止管理に使用します。Googleのサービスで保存し、第三者への販売は行いません。削除依頼は上記連絡先へお送りください。</p>');
}
function doPost(e){try{const p=(e&&e.parameter)||{};return locked_(()=>{
  if(p.action==='unsubscribe'){const r=rows_('Subscribers'),i=r.findIndex(x=>x[4]===p.token&&p.token);if(i>=0){r[i][1]='UNSUBSCRIBED';r[i][8]=iso_();save_('Subscribers',i,r[i]);}return html_('配信停止','<p>該当する登録がある場合、配信を停止しました。</p>');}
  if(p.action==='confirm')return confirm_(p.token);
  if(p.action==='subscribe')return subscribe_(p);
  return html_('操作を確認してください','<p>登録ページから操作してください。</p>');
});}catch(e){return html_('現在処理できません','<p>少し時間をおいて登録ページからお試しください。繰り返し発生する場合は運営へご連絡ください。</p>');}}
function subscribe_(p){
  if(!enabled_('MAIL_ENABLED')||p.consent!=='yes'||p.company_site||!validChallenge_(p.challenge))throw new Error('Invalid submission');
  const email=String(p.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('Invalid email');
  const r=rows_('Subscribers'),ix=r.findIndex(x=>x[0]===email),hour=Utilities.formatDate(new Date(),'UTC','yyyy-MM-dd-HH'),key='CONFIRM_COUNT';
  const counter=JSON.parse(cfg_(key,'{"hour":"","count":0}'));if(counter.hour!==hour){counter.hour=hour;counter.count=0;}
  const result=()=>html_('メールをご確認ください','<p>受付可能なアドレスには確認メールをお送りしました。メール内のリンクを開き、登録を確定してください。</p>');
  if(ix>=0&&(r[ix][1]==='ACTIVE'||Date.now()-new Date(r[ix][8]).getTime()<86400000))return result();
  if(counter.count>=Number(cfg_('MAX_CONFIRM_PER_HOUR','20'))||MailApp.getRemainingDailyQuota()<10)throw new Error('Quota');
  const token=Utilities.getUuid()+Utilities.getUuid(),row=[email,'PENDING',hash_(token),new Date(Date.now()+86400000).toISOString(),Utilities.getUuid()+Utilities.getUuid(),'',0,'IDLE',iso_(),String(p.source||'').slice(0,80),cfg_('CONSENT_VERSION','v1')];
  counter.count++;props_().setProperty(key,JSON.stringify(counter));if(ix>=0)save_('Subscribers',ix,row);else append_('Subscribers',row);
  // Reserve before sending; an uncertain response does not cause repeated confirmations.
  MailApp.sendEmail({to:email,subject:'メール登録を確認してください',body:'以下を開いて登録を確定してください。リンクは24時間有効です。\n'+publicBase_()+'?action=confirm&token='+encodeURIComponent(token)+'\n\n心当たりがない場合は操作不要です。\n'+senderFooter_(),name:cfg_('BRAND','AnyWare'),replyTo:require_('SENDER_CONTACT')});return result();
}
function confirm_(token){const r=rows_('Subscribers'),i=r.findIndex(x=>x[2]===hash_(String(token||''))&&x[1]==='PENDING');if(i<0||Date.now()>new Date(r[i][3]).getTime())return html_('確認リンクの有効期限切れ','<p>登録ページから再度お申し込みください。</p>');r[i][1]='ACTIVE';r[i][2]='';r[i][5]=iso_();r[i][8]=iso_();save_('Subscribers',i,r[i]);return html_('登録が完了しました','<p>無料シートはこちらで読めます。メールでも順次お送りします。</p><a href="'+esc_(publicBase_())+'?action=free">無料シートを読む</a>');}
function senderFooter_(){return cfg_('BRAND','AnyWare')+'\n'+require_('SENDER_ADDRESS')+'\nお問い合わせ：'+require_('SENDER_CONTACT');}
function mailBatch_(){
  const r=rows_('Subscribers');let sent=0;r.forEach((x,i)=>{
    if(x[1]!=='ACTIVE'||sent>=10)return;
    if(x[7]==='SENDING'&&Date.now()-new Date(x[8]).getTime()>10*60000){x[7]='UNKNOWN';save_('Subscribers',i,x);return;}
    if(x[7]!=='IDLE')return;const step=Number(x[6]),m=EMAIL_SEQUENCE[step];if(!m||Date.now()-new Date(x[5]).getTime()<m.day*86400000||MailApp.getRemainingDailyQuota()<10)return;
    let body=m.body;const replacements={FREE_URL:publicBase_()+'?action=free',STARTER_URL:cfg_('STARTER_URL',''),MAIN_URL:cfg_('MAIN_URL','')};
    if(Object.keys(replacements).some(k=>body.includes('{{'+k+'}}')&&!validUrl_(replacements[k])))return;
    Object.keys(replacements).forEach(k=>{body=body.split('{{'+k+'}}').join(replacements[k]);});
    body+='\n\n'+senderFooter_()+'\n配信停止：'+publicBase_()+'?action=unsubscribe&token='+encodeURIComponent(x[4]);
    x[7]='SENDING';x[8]=iso_();save_('Subscribers',i,x);
    try{MailApp.sendEmail({to:x[0],subject:m.subject,body:body,name:cfg_('BRAND','AnyWare'),replyTo:require_('SENDER_CONTACT')});x[6]=step+1;x[7]='IDLE';x[8]=iso_();save_('Subscribers',i,x);sent++;}catch(e){x[7]='UNKNOWN';save_('Subscribers',i,x);}
  });
  // Remove unconfirmed addresses after 7 days. Keep opt-out records to avoid accidental resends.
  for(let i=r.length-1;i>=0;i--)if(r[i][1]==='PENDING'&&Date.now()-new Date(r[i][8]).getTime()>7*86400000)sheet_('Subscribers').deleteRow(i+2);
}
