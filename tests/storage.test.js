import test from 'node:test';
import assert from 'node:assert/strict';
import {loadHistory,saveHistory,upsertRecord} from '../src/storage.js';
import {inspect,SAMPLE_INPUT} from '../src/engine.js';
test('history survives readback; review update preserves original result without duplicates',()=>{
  let value=null;globalThis.localStorage={getItem:()=>value,setItem:(_,v)=>{value=v;}};
  const record={result:inspect(SAMPLE_INPUT)};let records=upsertRecord([],record);assert(saveHistory(records).ok);assert.equal(loadHistory().records.length,1);
  records=upsertRecord(records,{...record,candidate:'different',reviewed:true});assert.equal(records.length,1);assert.equal(records[0].result.title,SAMPLE_INPUT.title);assert.equal(record.candidate,undefined);
});
test('corrupt storage cannot be overwritten and quota failure is visible',()=>{
  let value='{broken';globalThis.localStorage={getItem:()=>value,setItem:(_,v)=>{value=v;}};
  assert(loadHistory().error);assert(!saveHistory([{result:inspect(SAMPLE_INPUT)}]).ok);assert.equal(value,'{broken');
  globalThis.localStorage={getItem:()=>null,setItem:()=>{throw new Error('QuotaExceeded');}};assert(!saveHistory([{result:inspect(SAMPLE_INPUT)}]).ok);
  assert(!saveHistory(Array(501).fill({result:inspect(SAMPLE_INPUT)})).ok);
});
test('structurally damaged records are rejected before rendering or export',()=>{
  for(const damage of [r=>delete r.result.missing,r=>r.result.issues[0].spans=null,r=>r.candidateResult={title:'incomplete'}]){
    const record={result:inspect(SAMPLE_INPUT)};damage(record);const value=JSON.stringify([record]);
    globalThis.localStorage={getItem:()=>value,setItem:()=>assert.fail('must preserve damaged data')};
    assert(loadHistory().error);assert(!saveHistory([{result:inspect(SAMPLE_INPUT)}]).ok);
  }
});
