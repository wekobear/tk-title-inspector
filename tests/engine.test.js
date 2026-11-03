import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect,SAMPLE_INPUT,suggestFormatting,reviewRequirements,canRecordReview,RULES} from '../src/engine.js';
const clean={...SAMPLE_INPUT,title:'MERACH Indoor Cycling Bike with LCD Display',factsComplete:true};
test('sample detects actual marketing, spaces and separator; does not invent brand uppercase issue',()=>{
  const r=inspect(SAMPLE_INPUT);assert.deepEqual(r.issues.map(i=>i.ruleId).sort(),['T03','T06','T07']);assert.equal(r.length,Array.from(SAMPLE_INPUT.title).length);assert.equal(r.coverage.length,11);
  assert.equal(RULES.length,11);assert.equal(r.status,'REVIEW_REQUIRED');
});
test('unicode spans map NFC matching and emoji back to original text',()=>{
  const title='🚲 Cafe\u0301 Bike BEST SELLER';const r=inspect({...SAMPLE_INPUT,title,brand:'Café',productType:'Bike'});
  const issue=r.issues.find(i=>i.ruleId==='T03');assert.equal(Array.from(title).slice(...issue.spans[0]).join(''),'BEST SELLER');assert(!r.issues.some(i=>i.ruleId==='T10'));
});
test('phrase boundaries do not flag free weights, embedded best seller substrings or numeric features',()=>{
  const r=inspect({...clean,title:'MERACH Indoor Cycling Bike Free Weights bestsellerish 20% Resistance'});assert(!r.issues.some(i=>i.ruleId==='T03'));
});
test('unknown scope runs only generic whitespace and never silently applies US rules',()=>{
  const r=inspect({...SAMPLE_INPUT,market:'unknown'});assert.deepEqual(r.issues.map(i=>i.ruleId),['T07']);assert.equal(r.coverage.find(c=>c.ruleId==='T03').state,'SKIPPED');
});
test('clean title remains draft, manual facts are not automatic approval',()=>{
  const r=inspect(clean);assert.equal(r.issues.length,0);assert.equal(r.status,'REVIEW_REQUIRED');assert.equal(r.coverage.find(c=>c.ruleId==='T11').state,'MANUAL_PENDING');assert.equal(r.coverage.find(c=>c.ruleId==='T09').state,'DISABLED');
});
test('length recommendations never introduce hard blockers',()=>{
  for(const length of [24,25,80,150,151,200,255,256]){
    const r=inspect({...clean,title:'a'.repeat(length)});assert.equal(r.length,length);assert.equal(r.issues.some(i=>i.ruleId==='T01'),length>150);assert.equal(r.issues.some(i=>i.ruleId==='T02'),length<25);assert(!r.issues.some(i=>i.severity==='BLOCKER'));
  }
});
test('empty and protection limit are input errors',()=>{
  assert.equal(inspect({title:' \t '}).status,'INVALID_INPUT');assert.equal(inspect({title:'😀'.repeat(5001)}).status,'INVALID_INPUT');assert.equal(inspect({title:'x',brandStatus:'made-up'}).status,'INVALID_INPUT');
});
test('brand is matched on boundaries and exact canonical case',()=>{
  assert(inspect({...clean,title:'MERACHX Indoor Cycling Bike'}).issues.some(i=>i.ruleId==='T10'));
  assert(inspect({...clean,title:'Merach Indoor Cycling Bike'}).issues.some(i=>i.ruleId==='T10'));
  assert(!inspect({...clean,brandStatus:'unbranded',brand:'',title:'Indoor Cycling Bike with LCD Display'}).issues.some(i=>i.ruleId==='T10'));
});
test('uppercase heuristics preserve approved acronyms but flag full sentence',()=>{
  assert(!inspect(clean).issues.some(i=>i.ruleId==='T04'));assert(inspect({...clean,title:'MERACH INDOOR CYCLING BIKE LCD'}).issues.some(i=>i.ruleId==='T04'));
});
test('format cleaning does not remove claims, change brand, or normalize non-ASCII whitespace',()=>{
  assert.equal(suggestFormatting('  MERACH  Bike | BEST SELLER  '),'MERACH Bike | BEST SELLER');assert.equal(suggestFormatting('A\u00a0B\tC'),'A\u00a0B\tC');
});
test('review gate requires facts, exact latest candidate and every confirmation; edits revoke eligibility',()=>{
  const result=inspect(clean),candidate=clean.title,candidateResult=inspect(clean),checkedIds=reviewRequirements(clean).map(r=>r.id);
  const args={result,candidate,candidateResult,checkedIds};assert(canRecordReview(args));assert(!canRecordReview({...args,checkedIds:checkedIds.slice(1)}));assert(!canRecordReview({...args,candidate:candidate+' x'}));assert(!canRecordReview({...args,result:inspect({...clean,factsComplete:false})}));assert(!canRecordReview({...args,candidateResult:inspect({...clean,brand:'Other'})}));
  const bad=inspect({...clean,title:clean.title+' FREE SHIPPING'});assert(!canRecordReview({...args,candidate:bad.title,candidateResult:bad}));
});
