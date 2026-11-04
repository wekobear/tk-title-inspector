const KEY='tk-title-inspector.history.v1';
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string');
const validRevision = value => value === undefined || (Number.isSafeInteger(value) && value > 0);
const isResult = r => r && (r.customRuleVersion === undefined || (typeof r.customRuleVersion === 'string' && r.customRuleVersion.length > 0)) && ['id','title','createdAt','ruleVersion'].every(k => typeof r[k] === 'string')
  && ['INVALID_INPUT','REVIEW_REQUIRED'].includes(r.status)
  && Number.isFinite(r.length) && (r.error === null || typeof r.error === 'string')
  && r.input && ['title','market','language','category','brandStatus','brand','productType','features','factsSource'].every(k => typeof r.input[k] === 'string')
  && typeof r.input.factsComplete === 'boolean' && strings(r.missing)
  && r.counts && Number.isFinite(r.counts.review) && Number.isFinite(r.counts.suggestion)
  && Array.isArray(r.issues) && r.issues.every(i => i && ['id','ruleId','name','message','sourceType','sourceTitle','sourceUrl'].every(k => typeof i[k] === 'string')
    && validRevision(i.revision) && ['REVIEW','SUGGESTION'].includes(i.severity) && Array.isArray(i.spans)
    && i.spans.every(s => Array.isArray(s) && s.length === 2 && s.every(Number.isInteger) && s[0] >= 0 && s[1] >= s[0] && s[1] <= r.length))
  && Array.isArray(r.coverage) && r.coverage.every(c => c && validRevision(c.revision) && ['ruleId','name','state','reason'].every(k => typeof c[k] === 'string'));
const isRecord = r => r && isResult(r.result) && (r.candidate == null || typeof r.candidate === 'string')
  && (r.candidateResult == null || isResult(r.candidateResult)) && (r.checkedIds == null || strings(r.checkedIds))
  && (r.reviewed == null || typeof r.reviewed === 'boolean');
export function loadHistory(){
  try{const raw=localStorage.getItem(KEY);if(!raw)return {records:[],error:null};const data=JSON.parse(raw);if(!Array.isArray(data)||!data.every(isRecord))throw new Error('invalid');return {records:data,error:null};}
  catch{return {records:[],error:'无法读取本机历史，原始数据未覆盖。请导出当前记录并检查浏览器存储。'};}
}
export function saveHistory(records){
  try{if(records.length>500)return {ok:false,error:'本机历史已达500条，本次新增记录仅在当前页面保留，请导出备份。'};if(!records.every(isRecord))throw new Error('invalid');
    const existing=localStorage.getItem(KEY);if(existing){const parsed=JSON.parse(existing);if(!Array.isArray(parsed)||!parsed.every(isRecord))throw new Error('invalid');}
    localStorage.setItem(KEY,JSON.stringify(records));return {ok:true,error:null};
  }catch{return {ok:false,error:'历史保存失败（浏览器限制、空间不足或已有数据损坏）。当前结果仍可导出，请勿直接关闭页面。'};}
}
export function upsertRecord(records,record){const index=records.findIndex(r=>r.result.id===record.result.id);return index<0?[structuredClone(record),...records]:records.map((r,i)=>i===index?structuredClone(record):r);}
