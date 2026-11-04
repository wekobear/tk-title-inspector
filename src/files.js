import Papa from 'papaparse';
import { unzipSync, strFromU8 } from 'fflate';
import { DEFAULT_INPUT } from './engine.js';

export const MAX_ROWS=100, MAX_BYTES=5*1024*1024;
const fields={title_original:'title',title:'title',market:'market',language:'language',category:'category',brand_status:'brandStatus',brand:'brand',brand_name:'brand',product_type:'productType',features:'features',facts_source:'factsSource',facts_complete:'factsComplete'};
const headers=['title_original','market','language','category','brand_status','brand_name','product_type','features','facts_source','facts_complete'];
function normalizeRows(table, fileName) {
  if(!table.length)throw new Error('文件为空，请下载并填写模板。');
  const cols=table[0].cells.map(v=>String(v??'').replace(/^\uFEFF/,'').trim().toLowerCase());
  if(!cols.some(c=>fields[c]==='title'))throw new Error('缺少 title_original 列，请使用下载模板。');
  const mapped=cols.filter(c=>fields[c]).map(c=>fields[c]);
  if(new Set(mapped).size!==mapped.length)throw new Error('列名重复或存在重复别名，请只保留一列。');
  const unknown=cols.filter(c=>!fields[c]);
  if(unknown.length)throw new Error(`无法识别列：${unknown.join('、')}。请使用模板列名，避免遗漏资料。`);
  const data=table.slice(1).filter(r=>r.cells.some(v=>v!==null&&v!==undefined&&v!==''));
  if(!data.length)throw new Error('没有可检测的商品行。');
  if(data.length>MAX_ROWS)throw new Error('每批最多100条；请拆分文件后导入，未截断任何记录。');
  return {fileName,rows:data.map(({cells,rowNumber})=>{
    // Missing scope must never silently inherit US/en from the single-title form.
    const input={...DEFAULT_INPUT,market:'unknown',language:'unknown',category:'unknown'};
    let error=cells.length!==cols.length?'列数与表头不一致，请检查空单元格或分隔符。':null;
    cols.forEach((c,i)=>{
      const key=fields[c],value=cells[i];
      if(key==='factsComplete') {
        const str=String(value??'').trim().toLowerCase();
        if(!['','true','false','1','0','是','否'].includes(str))error='facts_complete 仅支持 true/false、1/0、是/否。';
        input[key]=['true','1','是'].includes(str);
      }else if(value!==null&&value!==undefined){
        if(typeof value!=='string')error=`第${i+1}列必须为文本，请保留原文格式。`;
        input[key]=String(value);
      }
    });
    if(!input.market)input.market='unknown';if(!input.language)input.language='unknown';if(!input.category)input.category='unknown';if(!input.brandStatus)input.brandStatus='unknown';
    if(!['US','unknown'].includes(input.market))error='当前仅支持 US 或 unknown 市场，请勿套用其他市场规则。';
    if(!['en','unknown'].includes(input.language))error='当前仅支持 en 或 unknown 语言。';
    if(!['fitness','other','unknown'].includes(input.category))error='category 仅支持 fitness、other 或 unknown。';
    if(!['branded','unbranded','unknown'].includes(input.brandStatus))error='brand_status 仅支持 branded、unbranded 或 unknown。';
    if(Object.values(input).some(v=>typeof v==='string'&&Array.from(v).length>5000))error='单元格超过本工具5000字符保护上限。';
    return {rowNumber,input,error};
  })};
}
export function parseCSV(text,fileName='粘贴 CSV') {
  const table=[];let cursor=0, rowNumber=1;const errors=[];
  Papa.parse(text.replace(/^\uFEFF/,''),{dynamicTyping:false,skipEmptyLines:false,step(result){
    const current=result.meta.cursor;
    table.push({cells:result.data,rowNumber});
    rowNumber+=(text.replace(/^\uFEFF/,'').slice(cursor,current).match(/\r\n|\r|\n/g)||[]).length;
    cursor=current;errors.push(...result.errors.filter(e=>e.code!=='UndetectableDelimiter'));
  }});
  if(errors.length)throw new Error(`CSV 格式错误：${errors[0].message}`);
  return normalizeRows(table,fileName);
}
export function preflightXlsx(bytes) {
  let total=0,count=0;
  const archive=unzipSync(bytes,{filter(file){
    total+=file.originalSize;count++;
    if(total>20*1024*1024||count>300||file.originalSize>10*1024*1024)throw new Error('Excel 解压后内容过大，请仅保留待检查的工作表。');
    if(/vbaProject|externalLinks/i.test(file.name))throw new Error('不支持包含宏或外部链接的 Excel，请导出为纯值文件。');
    return /\.(xml|rels)$/i.test(file.name);
  }});
  if(!archive['xl/workbook.xml'])throw new Error('文件不是有效的 XLSX 工作簿。');
  for(const [name,data] of Object.entries(archive)){
    const xml=strFromU8(data);
    if(/<(?:[\w]+:)?f(?:\s|>|\/)/.test(xml)||(/\.rels$/i.test(name)&&/TargetMode\s*=\s*["']External["']/i.test(xml)))throw new Error('Excel 中包含公式或外部链接，请复制并粘贴为纯值后重新导入。');
  }
  const sheetCount=(strFromU8(archive['xl/workbook.xml']).match(/<(?:\w+:)?sheet\b/g)||[]).length;
  if(sheetCount!==1)throw new Error('请使用仅含一个工作表的 Excel，避免遗漏其他工作表记录。');
}
export async function parseImport(file){
  if(!file||file.size>MAX_BYTES)throw new Error('每个文件最多5MB。');
  if(/\.csv$/i.test(file.name))return parseCSV(await file.text(),file.name);
  if(!/\.xlsx$/i.test(file.name))throw new Error('仅支持 .csv 或 .xlsx 文件。');
  const buffer=await file.arrayBuffer();
  try{preflightXlsx(new Uint8Array(buffer));}catch(e){throw new Error(e.message?.includes('Excel')||e.message?.includes('XLSX')?e.message:'无法读取 XLSX 文件，请确认文件未损坏且未加密。');}
  const {readSheet}=await import('read-excel-file/browser');
  let data;try{data=await readSheet(new Blob([buffer]));}catch{throw new Error('无法解析 Excel，请确认文件未加密且格式有效。');}
  const width=data[0]?.length||0;
  return normalizeRows(data.map((cells,i)=>({cells:Array.from({length:Math.max(width,cells.length)},(_,j)=>cells[j]??''),rowNumber:i+1})),file.name);
}
export function parsePasted(text,baseInput=DEFAULT_INPUT){
  if(text.length>MAX_BYTES)throw new Error('粘贴内容过大。');
  const rows=text.split(/\r\n|\n|\r/).map((title,i)=>({rowNumber:i+1,input:{...baseInput,title},error:null})).filter(r=>r.input.title!=='');
  if(!rows.length)throw new Error('请至少输入一条标题。');
  if(rows.length>MAX_ROWS)throw new Error('每批最多100条，请拆分后检测。');
  return {fileName:'逐行粘贴',rows};
}
function download(content,name,type='text/csv;charset=utf-8'){
  const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const csv=rows=>'\uFEFF'+Papa.unparse(rows,{quotes:true,newline:'\r\n',escapeFormulae:/^[\s\uFEFF]*[=+\-@\t\r]/});
export function downloadTemplate(){download(csv([headers,['MERACH Indoor Cycling Bike with LCD Display','US','en','fitness','branded','MERACH','Indoor Cycling Bike','LCD Display','请替换为真实资料来源','false']]),'TK标题检查-导入模板.csv');}
export function resultsCSV(records){return csv([['源行号','检查时间','市场','语言','原标题','字符数','原文结果','问题明细','资料及覆盖限制','候选标题','候选结果','人工复核','复核时间','规则版本','自定义规则集版本','命中来源','候选内置规则版本','候选自定义规则集版本'],...records.map(r=>[r.rowNumber??'',r.result.createdAt,r.result.input.market,r.result.input.language,r.result.title,r.result.length,r.result.error?'输入失败':'待人工核验（草稿）',r.result.error||r.result.issues.map(i=>`${i.name}：${i.message}`).join('；'),r.result.missing.join('；'),r.candidate??'',r.candidateResult?(r.candidateResult.error?'输入失败':`草稿；待核验${r.candidateResult.counts.review}项，建议${r.candidateResult.counts.suggestion}条`):'未复检',r.reviewed?'已记录人工复核（草稿，非发布）':'未复核',r.reviewedAt??'',r.result.ruleVersion,r.result.customRuleVersion??'旧记录',r.result.issues.map(i=>`${i.name}：${i.sourceType==='CUSTOM'?'自定义':i.sourceTitle}`).join('；'),r.candidateResult?.ruleVersion??'',r.candidateResult?.customRuleVersion??''])]);}
export function exportResults(records,filename='TK标题检查-结果.csv'){download(resultsCSV(records),filename);}
