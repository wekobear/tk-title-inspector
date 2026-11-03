import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {parseCSV,parsePasted,parseImport,preflightXlsx,resultsCSV} from '../src/files.js';
import {inspect,SAMPLE_INPUT} from '../src/engine.js';
test('CSV quotes, BOM, multiline and physical row numbers preserved',()=>{
  const r=parseCSV('\uFEFFtitle_original,brand_name\r\n"Bike, folded","MERACH"\r\n"First\nSecond",""\r\n"Last",""\r\n');
  assert.deepEqual(r.rows.map(r=>r.rowNumber),[2,3,5]);assert.equal(r.rows[0].input.title,'Bike, folded');assert.equal(r.rows[1].input.title,'First\nSecond');assert.equal(r.rows[0].input.market,'unknown');
});
test('CSV row-level column and enum failures stay visible; duplicate title alias rejected',()=>{
  assert(parseCSV('title_original,market\nBike,CA').rows[0].error);
  assert(parseCSV('title_original,market\nBike').rows[0].error);
  assert.throws(()=>parseCSV('title,title_original\nA,B'),/重复/);
  assert.throws(()=>parseCSV('wrong\nA'),/缺少/);
  assert.throws(()=>parseCSV('title\n"unfinished'),/格式错误/);
});
test('one hundred rows accepted; 101 not truncated; blank lines preserve physical identity',()=>{
  assert.equal(parsePasted(Array(100).fill('Bike').join('\n'),SAMPLE_INPUT).rows.length,100);
  assert.throws(()=>parsePasted(Array(101).fill('Bike').join('\n')),/100/);
  assert.throws(()=>parseCSV('title\n'+Array(101).fill('Bike').join('\n')),/100/);
  assert.deepEqual(parsePasted('Bike\n\nBike').rows.map(x=>x.rowNumber),[1,3]);
});
test('CSV treats formulas as text; safe export neutralizes spreadsheet execution',()=>{
  const title='=HYPERLINK("https://example.com")';const result=inspect({title});const out=resultsCSV([{result}]);
  assert(out.includes("'=HYPERLINK"));assert(out.includes('草稿'));assert.equal(result.title,title);
});
test('file limits and wrong extensions fail early',async()=>{
  await assert.rejects(parseImport({size:6*1024*1024,name:'x.csv'}),/5MB/);await assert.rejects(parseImport({size:1,name:'x.xls'}),/xlsx/);
});
const zip=(extras={},sheets='<sheet name="Sheet1"/>')=>zipSync({'xl/workbook.xml':strToU8(`<workbook><sheets>${sheets}</sheets></workbook>`),...extras});
test('XLSX preflight refuses formulas, external relationships and multiple sheets',()=>{
  assert.doesNotThrow(()=>preflightXlsx(zip()));
  assert.throws(()=>preflightXlsx(zip({'xl/worksheets/sheet1.xml':strToU8('<worksheet><f>SUM(A1)</f></worksheet>')})),/公式/);
  assert.throws(()=>preflightXlsx(zip({'xl/_rels/workbook.xml.rels':strToU8('<Relationship TargetMode="External"/>')})),/外部链接/);
  assert.throws(()=>preflightXlsx(zip({},'<sheet/><sheet/>')),/一个工作表/);
  assert.throws(()=>preflightXlsx(new Uint8Array([1,2,3])));
});
