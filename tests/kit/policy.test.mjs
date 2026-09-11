import {test} from 'node:test';
import assert from 'node:assert/strict';
import {revenueSummary,budgetDecision,transition,reconcileUnknown,scheduleDecision,validateKnowledgeReferences} from '../../src/domain/policy.mjs';
test('unknown fees never produce confirmed profit',()=>assert.equal(revenueSummary({grossYen:9800}).profitYen,null));
test('profit deducts refunds, fees and operating costs',()=>assert.equal(revenueSummary({grossYen:392000,refundsYen:0,feesYen:78400,operatingYen:10000}).profitYen,303600));
test('reject invalid yen and aggregate overflow',()=>{
 assert.throws(()=>revenueSummary({grossYen:1.5}));
 assert.throws(()=>revenueSummary({grossYen:100,refundsYen:101}));
 assert.throws(()=>budgetDecision({capYen:10000,spentYen:Number.MAX_SAFE_INTEGER,reservedYen:1,estimateYen:1}));
});
test('reservations count against budget',()=>assert.equal(budgetDecision({capYen:10000,spentYen:8000,reservedYen:1500,estimateYen:501}).allowed,false));
test('unknown pricing blocks paid work, exact budget boundary allowed',()=>{
 assert.equal(budgetDecision({capYen:10000,spentYen:8000,reservedYen:1000,estimateYen:1000}).allowed,true);
 assert.equal(budgetDecision({capYen:10000,spentYen:0,reservedYen:0,estimateYen:0,pricingKnown:false}).allowed,false);
});
test('unapproved and unknown posts cannot skip to publishing',()=>{
 assert.throws(()=>transition('DRAFT','PUBLISHING'));
 assert.throws(()=>transition('UNKNOWN','SCHEDULED'));
 assert.equal(transition('PUBLISHING','UNKNOWN'),'UNKNOWN');
});
test('unknown result remains quarantined unless reconciliation is conclusive',()=>{
 assert.equal(reconcileUnknown({outcome:'published'}).status,'UNKNOWN');
 assert.equal(reconcileUnknown({outcome:'published',externalPostId:'p123'}).status,'PUBLISHED');
 assert.equal(reconcileUnknown({outcome:'confirmed_not_published'}).status,'DRAFT');
});
const now=2000000000000;
test('scheduler defaults stopped',()=>assert.equal(scheduleDecision({nowMs:now,dueMs:now}).reason,'STOPPED'));
test('missed reservations expire rather than catch up',()=>assert.equal(scheduleDecision({nowMs:now,dueMs:now-86400001,enabled:true}).reason,'EXPIRED'));
test('rolling cap and spacing block sending',()=>{
 assert.equal(scheduleDecision({nowMs:now,dueMs:now,enabled:true,publishedAtMs:[now-100,now-200,now-300]}).reason,'DAILY_CAP');
 assert.equal(scheduleDecision({nowMs:now,dueMs:now,enabled:true,publishedAtMs:[now-7199999]}).reason,'MIN_GAP');
 assert.equal(scheduleDecision({nowMs:now,dueMs:now,enabled:true,publishedAtMs:[now-7200000]}).allowed,true);
});
test('invalid timestamps fail closed',()=>assert.throws(()=>scheduleDecision({nowMs:now,dueMs:now,enabled:true,publishedAtMs:[now+1]})));
test('unknown, duplicate or unapproved knowledge is rejected',()=>{
 const k=[{id:'a',approved:true},{id:'b',approved:false}];
 assert.throws(()=>validateKnowledgeReferences(['b'],k));
 assert.throws(()=>validateKnowledgeReferences(['c'],k));
 assert.throws(()=>validateKnowledgeReferences(['a','a'],k));
 assert.equal(validateKnowledgeReferences(['a'],k).length,1);
});
