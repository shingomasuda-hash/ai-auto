/** Pure policies only. Persistence, locks, authentication and API adapters are NOT implemented here. */
function money(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name}: nonnegative safe integer required`);
  return value;
}
function sumMoney(values) {
  return values.reduce((a,b)=>money(a + money(b,'amount'),'total'),0);
}
export function revenueSummary({grossYen, refundsYen=0, feesYen=null, operatingYen=0}) {
  [grossYen,refundsYen,operatingYen].forEach(v=>money(v,'amount'));
  if (refundsYen>grossYen) throw new RangeError('Refunds exceed selected gross revenue');
  if (feesYen===null) return {netSalesYen:grossYen-refundsYen, profitYen:null, feesKnown:false};
  const costs=sumMoney([money(feesYen,'feesYen'),operatingYen]);
  return {netSalesYen:grossYen-refundsYen,profitYen:grossYen-refundsYen-costs,feesKnown:true};
}
/** Call inside the SAME DB transaction that creates a reservation. No concurrency guarantee by itself. */
export function budgetDecision({capYen,spentYen,reservedYen,estimateYen,pricingKnown=true}) {
  const cap=money(capYen,'cap');
  const current=sumMoney([spentYen,reservedYen]);
  const projected=sumMoney([current,estimateYen]);
  if (typeof pricingKnown!=='boolean') throw new TypeError('pricingKnown must be boolean');
  return {allowed:pricingKnown && projected<=cap, projectedYen:projected,
    remainingYen:Math.max(0,cap-current), warning:projected>=cap*.8,
    reason:!pricingKnown?'PRICING_UNKNOWN':projected>cap?'BUDGET_EXCEEDED':'WITHIN_BUDGET'};
}
const NEXT={
  DRAFT:['APPROVED'],APPROVED:['DRAFT','SCHEDULED'],SCHEDULED:['DRAFT','CLAIMED','EXPIRED'],
  CLAIMED:['PUBLISHING','SCHEDULED','FAILED','EXPIRED'],PUBLISHING:['PUBLISHED','UNKNOWN','FAILED'],
  FAILED:['DRAFT'],UNKNOWN:[],EXPIRED:['DRAFT'],PUBLISHED:[]
};
export function transition(from,to) {
  if (!NEXT[from]?.includes(to)) throw new Error(`Forbidden transition ${from} -> ${to}`);
  return to;
}
/** Only after an authenticated operator/provider reconciliation supplies evidence. */
export function reconcileUnknown({outcome,externalPostId}) {
  if (outcome==='published' && typeof externalPostId==='string' && externalPostId.trim())
    return {status:'PUBLISHED',externalPostId:externalPostId.trim()};
  if (outcome==='confirmed_not_published') return {status:'DRAFT',externalPostId:null};
  return {status:'UNKNOWN',externalPostId:null};
}
function time(value,name) {
  if(!Number.isSafeInteger(value) || value<0)throw new TypeError(`${name}: epoch milliseconds required`);
  return value;
}
export function scheduleDecision({nowMs,dueMs,publishedAtMs=[],enabled=false,maxPer24h=3,minGapMs=7200000,expiryMs=86400000}) {
  time(nowMs,'now');time(dueMs,'due');
  if(typeof enabled!=='boolean')throw new TypeError('enabled must be boolean');
  if(!Number.isSafeInteger(maxPer24h)||maxPer24h<1)throw new RangeError('maxPer24h');
  money(minGapMs,'minGapMs');money(expiryMs,'expiryMs');
  if(!Array.isArray(publishedAtMs))throw new TypeError('timestamps array required');
  publishedAtMs.forEach(v=>{time(v,'published');if(v>nowMs)throw new RangeError('Future publication timestamp');});
  if(!enabled)return {allowed:false,reason:'STOPPED'};
  if(dueMs>nowMs)return {allowed:false,reason:'NOT_DUE'};
  if(nowMs-dueMs>expiryMs)return {allowed:false,reason:'EXPIRED'};
  const recent=publishedAtMs.filter(v=>nowMs-v<86400000);
  if(recent.length>=maxPer24h)return {allowed:false,reason:'DAILY_CAP'};
  if(recent.some(v=>nowMs-v<minGapMs))return {allowed:false,reason:'MIN_GAP'};
  return {allowed:true,reason:'READY'};
}
/** Verifies references, not factual truth. Human review and claim validation are still required. */
export function validateKnowledgeReferences(ids,knowledge) {
  if(!Array.isArray(ids)||ids.length===0||new Set(ids).size!==ids.length)throw new Error('Unique nonempty references required');
  if(!Array.isArray(knowledge))throw new TypeError('knowledge array required');
  const byId=new Map(knowledge.map(k=>[k.id,k]));
  if(byId.size!==knowledge.length)throw new Error('Duplicate knowledge IDs');
  return ids.map(id=>{
    const k=byId.get(id);
    if(!k||k.approved!==true)throw new Error(`Unapproved knowledge reference: ${id}`);
    return k;
  });
}
