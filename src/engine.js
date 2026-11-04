import { EMPTY_SET, validateSet, evaluateRule } from './custom-rules.js';
export const RULE_VERSION = 'US-draft-2026.11.03';
const policy = 'https://seller-us.tiktok.com/university/essay?knowledge_id=3196690250417921';
const guide = 'https://seller-us.tiktok.com/university/essay?knowledge_id=7073362639816491';
const optimize = 'https://seller-us.tiktok.com/university/essay?knowledge_id=1664446336747310';
const defs = [
  ['T01','标题过长','OFFICIAL_RECOMMENDATION',optimize,'超过150字符时提示精简；官方优化建议，不是发布硬限制。','auto'],
  ['T02','标题过短','OFFICIAL_RECOMMENDATION',guide,'少于25字符时提示信息可能不足；25字符边界与发布限制尚未实测。','auto'],
  ['T03','营销与主观表达','PLATFORM_REQUIREMENT',policy,'识别部分促销和主观短语；上下文及事实由人工核验，不自动判定平台处罚。','auto'],
  ['T04','整句大写','PLATFORM_REQUIREMENT',policy,'排除所填品牌及常见缩写后检查整句大写；至少2词为内部匹配条件。','auto'],
  ['T05','特殊符号','OFFICIAL_RECOMMENDATION',guide,'提示指导页中列出的部分装饰性符号；保留正常标点、单位和品牌例外。','auto'],
  ['T06','管道分隔符','OFFICIAL_RECOMMENDATION',guide,'官方指导建议避免管道符；没有算法截断或必然降权的依据。','auto'],
  ['T07','多余空白','INTERNAL_HEURISTIC','', '检查首尾、连续空格及不可见字符；内部格式建议，原文不自动修改。','auto'],
  ['T08','重复词','INTERNAL_HEURISTIC',guide,'非停用词重复3次提示人工检查，为内部启发式；不是平台通用次数上限。','auto'],
  ['T09','关键词堆砌','INTERNAL_HEURISTIC','', '没有“12个关键词”官方阈值，此自动规则未启用；相关性需人工判断。','disabled'],
  ['T10','品牌名称','PLATFORM_REQUIREMENT',guide,'对照输入品牌做完整词边界匹配，无法核验授权真伪；不要求固定前置。','auto'],
  ['T11','品类与事实完整性','PLATFORM_REQUIREMENT',policy,'检查所填英文产品类型是否出现；功能、数量、认证及其他事实必须人工核验。','manual'],
];
export const RULES = defs.map(([id,name,sourceType,sourceUrl,description,mode]) => ({id,name,sourceType,sourceUrl,description,mode,scope:id==='T07'?'全部市场（仅格式）':'美国 / 英语（研究草稿）',sourceTitle: sourceType==='INTERNAL_HEURISTIC'?'内部启发式（非平台阈值）':sourceUrl===policy?'Product Listing Policy':sourceUrl===optimize?'Optimizing Product Titles':'Product Listing: What You Need to Know'}));
export const LEXICON = {promotions:['best seller','bestseller','trending item','free shipping','new release','low stock','100% satisfaction guaranteed','TikTok exclusive'],abbreviations:['LCD','LED','USB','HD','HDMI','DC','AC','ABS','PVC','UV','RGB','MP3','MP4','IPX4','IPX5','IPX6','IPX7']};
export const DEFAULT_INPUT = {title:'',market:'US',language:'en',category:'fitness',brandStatus:'unknown',brand:'',productType:'',features:'',factsSource:'',factsComplete:false};
export const SAMPLE_INPUT = {...DEFAULT_INPUT,title:'MERACH  Indoor Cycling Bike with LCD Display | BEST SELLER',brandStatus:'branded',brand:'MERACH',productType:'Indoor Cycling Bike',features:'LCD Display',factsSource:'演示资料，仅用于体验'};
const cpLen = s => Array.from(s).length;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const hasScope = x => x.market==='US' && x.language==='en';
const hasCategory = x => ['fitness','other'].includes(x.category);
const uuid = () => globalThis.crypto.randomUUID();
// NFC matching with grapheme-aware mapping back to the original code-point offsets.
function matchingText(title) {
  let text='', map=[], offset=0;
  for (const {segment} of new Intl.Segmenter('en',{granularity:'grapheme'}).segment(title)) {
    const normalized=segment.normalize('NFC'), end=offset+cpLen(segment);
    for(let i=0;i<normalized.length;i++) map.push([offset,end]);
    text+=normalized; offset=end;
  }
  return {text,map};
}
function matches(model, pattern) {
  return [...model.text.matchAll(pattern)].map(m=>({value:m[0],span:[model.map[m.index]?.[0]??0,model.map[m.index+m[0].length-1]?.[1]??0]}));
}
function phrasePattern(s, insensitive=true) {return new RegExp(`(?<![\\p{L}\\p{N}])${esc(s.normalize('NFC'))}(?![\\p{L}\\p{N}])`,insensitive?'giu':'gu');}
function missingFacts(x) {
  const list=[];
  if(!hasScope(x)) list.push('未选择受支持的美国 / 英语范围');
  if(!hasCategory(x)) list.push('尚未指定商品类目');
  if(x.brandStatus==='unknown') list.push('品牌状态未确认');
  if(x.brandStatus==='branded'&&!x.brand.trim()) list.push('缺少品牌名称');
  if(!x.productType.trim()) list.push('缺少产品类型');
  if(!x.factsSource.trim()) list.push('缺少商品事实来源');
  if(!x.factsComplete) list.push('未确认已提供完整商品事实');
  return list;
}
export function inspect(data={}, customRuleSet=EMPTY_SET) {
  if (!validateSet(customRuleSet)) throw new Error('自定义规则集无效');
  const x={...DEFAULT_INPUT,...data};
  for(const key of ['title','market','language','category','brandStatus','brand','productType','features','factsSource']) x[key]=typeof x[key]==='string'?x[key]:'';
  x.factsComplete=x.factsComplete===true;
  const length=cpLen(x.title), issues=[], coverage=[];
  const error=!x.title.trim()?'标题不能为空':length>5000?'标题超过本工具5000字符保护上限（不是平台限制）':!['unknown','branded','unbranded'].includes(x.brandStatus)?'品牌状态无效':null;
  const model=matchingText(x.title);
  const add=(id,severity,message,hits=[])=>{
    const r=RULES.find(r=>r.id===id);
    issues.push({id:`${id}-${issues.length}`,ruleId:id,name:r.name,severity,message,spans:hits.map(h=>h.span),sourceType:r.sourceType,sourceTitle:r.sourceTitle,sourceUrl:r.sourceUrl});
  };
  for(const rule of RULES) {
    const c={ruleId:rule.id,name:rule.name,state:'EXECUTED',reason:'已执行当前版本的有限匹配'};
    coverage.push(c);
    if(error){c.state='SKIPPED';c.reason='输入无效';continue;}
    if(rule.mode==='disabled'){c.state='DISABLED';c.reason=rule.description;continue;}
    if((customRuleSet.builtinDisabled ?? []).includes(rule.id)){c.state='DISABLED';c.reason='用户已停用此内置规则';continue;}
    if(rule.id!=='T07'&&!hasScope(x)){c.state='SKIPPED';c.reason='当前市场或语言不在研究规则范围内';continue;}
    switch(rule.id) {
      case 'T01': if(length>150)add(rule.id,'SUGGESTION',`${length}字符，超过官方40–150字符优化建议；不代表超过发布上限。`);break;
      case 'T02': if(length<25)add(rule.id,'SUGGESTION','不足25字符，请检查是否完整描述商品；发布字段下限尚未核实。');break;
      case 'T03': {
        const hits=LEXICON.promotions.flatMap(p=>matches(model,phrasePattern(p)));
        hits.push(...matches(model,/(?<![\p{L}\p{N}])\d+(?:\.\d+)?%\s*off(?![\p{L}\p{N}])/giu));
        if(hits.length)add(rule.id,'REVIEW','发现促销或主观表述，请按官方政策核验并修改；不自动删除商品事实。',hits);
        const claims=matches(model,/(?<![\p{L}\p{N}])(?:FDA\s+approved|cure[sd]?|guaranteed\s+weight\s+loss)(?![\p{L}\p{N}])/giu);
        if(claims.length)add(rule.id,'REVIEW','发现认证或效果声明，请人工核验依据及市场适用性。',claims);
        const links=matches(model,/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu);
        if(links.length)add(rule.id,'REVIEW','发现网址或邮箱，请检查是否包含站外引流信息。',links);
        break;
      }
      case 'T04': {
        if(x.brandStatus==='unknown'||(x.brandStatus==='branded'&&!x.brand.trim())){c.state='SKIPPED';c.reason='品牌资料不足，避免误报品牌大写';break;}
        let remaining=model.text;
        const excluded=[...LEXICON.abbreviations,...(x.brandStatus==='branded'?[x.brand.trim()]:[])];
        for(const word of excluded)remaining=remaining.replace(phrasePattern(word,false),' ');
        const words=remaining.match(/\p{L}+/gu)?.filter(w=>w.toLowerCase()!==w.toUpperCase())??[];
        if(words.length>=2&&words.every(w=>w===w.toUpperCase()))add(rule.id,'SUGGESTION','除已填写品牌与常见缩写外，其余文字全部大写，请检查大小写。');
        break;
      }
      case 'T05': {
        const brandHits=x.brandStatus==='branded'&&x.brand.trim()?matches(model,phrasePattern(x.brand.trim(),false)):[];
        const hits=matches(model,/[~!*$_{}#<>;^¬¦?]/gu).filter(h=>!brandHits.some(b=>h.span[0]>=b.span[0]&&h.span[1]<=b.span[1]));
        if(hits.length)add(rule.id,'SUGGESTION','发现指导页建议避免的符号，请检查是否有必要的品牌或规格含义。',hits);
        break;
      }
      case 'T06': {const hits=matches(model,/[|｜]/gu);if(hits.length)add(rule.id,'SUGGESTION','建议检查管道分隔方式；不代表算法截断或降权。',hits);break;}
      case 'T07': {
        const hits=matches(model,/ {2,}|^ +| +$|[\t\r\n\u200B-\u200D\uFEFF]/gu);
        if(hits.length)add(rule.id,'SUGGESTION','发现多余空白或不可见字符；整理空格只会修改候选，不覆盖原文。',hits);break;
      }
      case 'T08': {
        const ignore=new Set(['a','an','the','and','or','of','for','to','with','in','on','at','by',...x.brand.toLowerCase().split(/\s+/),...LEXICON.abbreviations.map(s=>s.toLowerCase())]);
        const groups=new Map();
        for(const h of matches(model,/\p{L}[\p{L}\p{N}]*/gu)) {const key=h.value.toLowerCase();if(!ignore.has(key)&&key.length>1)groups.set(key,[...(groups.get(key)||[]),h]);}
        const repeated=[...groups.values()].filter(g=>g.length>=3).flat();
        if(repeated.length)add(rule.id,'SUGGESTION','非停用词重复3次或以上，建议检查冗余（内部启发式，非平台阈值）。',repeated);break;
      }
      case 'T10': {
        if(x.brandStatus==='unknown'||(x.brandStatus==='branded'&&!x.brand.trim())){c.state='SKIPPED';c.reason='需要填写品牌状态和规范名称';break;}
        if(x.brandStatus==='unbranded'){c.reason='已声明无品牌，不强加品牌名称；声明真实性需人工核验';break;}
        const hits=matches(model,phrasePattern(x.brand.trim()));
        if(!hits.length)add(rule.id,'REVIEW','未匹配到填写的品牌名称，请核验拼写与商品事实。');
        else if(hits.some(h=>h.value!==x.brand.trim().normalize('NFC')))add(rule.id,'REVIEW','品牌大小写与填写的规范名称不同，请核对品牌原貌。',hits);
        c.reason='已比对填写的品牌名称；授权与真伪未自动验证';break;
      }
      case 'T11': {
        c.state='MANUAL_PENDING';c.reason='仅匹配所填产品类型；功能、规格、数量、授权及未填事实仍需人工核验';
        if(!x.productType.trim()||!hasCategory(x))break;
        if(!matches(model,phrasePattern(x.productType.trim())).length)add(rule.id,'REVIEW','标题未匹配所填英文产品类型，请核验同义表达或补齐必要信息。');
        break;
      }
    }
  }
  for (const rule of customRuleSet.rules) {
    const outcome=error?{state:'SKIPPED',reason:'输入无效'}:!rule.enabled?{state:'DISABLED',reason:'规则已停用'}:evaluateRule(rule,x);
    coverage.push({ruleId:rule.id,name:rule.name,state:outcome.state,reason:outcome.reason||'已执行自定义规则',sourceType:'CUSTOM',revision:rule.revision});
    if(outcome.hit) issues.push({id:`${rule.id}-${issues.length}`,ruleId:rule.id,name:rule.name,severity:rule.severity,message:rule.message,spans:outcome.spans,sourceType:'CUSTOM',sourceTitle:'自定义规则（非平台政策）',sourceUrl:'',revision:rule.revision});
  }
  return {customRuleVersion:customRuleSet.version,id:uuid(),createdAt:new Date().toISOString(),title:x.title,input:structuredClone(x),ruleVersion:RULE_VERSION,status:error?'INVALID_INPUT':'REVIEW_REQUIRED',issues,coverage,length,counts:{review:issues.filter(i=>i.severity==='REVIEW').length,suggestion:issues.filter(i=>i.severity==='SUGGESTION').length},missing:[...missingFacts(x),'研究规则尚未发布为生产规则包，结果始终保留草稿标识'],error};
}
export function suggestFormatting(title){return title.replace(/ +/g,' ').replace(/^ +| +$/g,'');}
export function reviewRequirements(input){
  const r=[{id:'scope',label:'已核对当前美国 / 英语市场与商品类目'}];
  if(input.brandStatus==='branded')r.push({id:'brand',label:`已核对品牌 ${input.brand||'（未填写）'} 的规范名称与使用授权`});
  if(input.brandStatus==='unbranded')r.push({id:'brand',label:'已核对商品确实无品牌，不以无品牌规避品牌信息'});
  r.push({id:'type',label:`已核对产品类型：${input.productType||'（未填写）'}`});
  for(const [i,feature] of input.features.split('\n').map(x=>x.trim()).filter(Boolean).entries())r.push({id:`feature-${i}`,label:`已核对商品事实：${feature}`});
  r.push({id:'claims',label:'已逐项核对候选中的全部数量、规格、材质、功能和认证，未增加无依据内容或遗漏必要信息'}, {id:'limits',label:'已处理建议并理解当前仅为个人草稿复核记录，不代表平台审核或已发布'});
  return r;
}
export function canRecordReview({result,candidateResult,candidate,checkedIds=[],currentCustomVersion=EMPTY_SET.version}){
  if(result?.ruleVersion!==RULE_VERSION || candidateResult?.ruleVersion!==RULE_VERSION || result?.customRuleVersion!==currentCustomVersion || candidateResult?.customRuleVersion!==currentCustomVersion)return false;
  if(!result||!candidateResult||result.error||candidateResult.error||candidateResult.title!==candidate||!candidate.trim())return false;
  const {title:_,...base}=result.input, {title:__,...next}=candidateResult.input;
  if(JSON.stringify(base)!==JSON.stringify(next)||missingFacts(result.input).length||candidateResult.counts.review>0)return false;
  return reviewRequirements(result.input).every(r=>checkedIds.includes(r.id));
}
