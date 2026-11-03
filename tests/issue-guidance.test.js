import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, SAMPLE_INPUT, suggestFormatting } from '../src/engine.js';
import { issueGuidance } from '../src/issue-guidance.js';

test('existing stored issue format distinguishes promotion, claims, and links', () => {
  const title = 'MERACH Bike BEST SELLER FDA approved https://example.com';
  const result = inspect({ ...SAMPLE_INPUT, title });
  const guides = JSON.parse(JSON.stringify(result.issues)).filter(x => x.ruleId === 'T03').map(x => issueGuidance(x, title));
  assert.equal(guides.length, 3);
  assert.match(guides[0].action, /删去/);
  assert.match(guides[1].action, /先核对证书/);
  assert.match(guides[2].action, /网址或邮箱/);
});

test('whitespace advice distinguishes automatic spaces from manual invisible characters', () => {
  for (const title of ['MERACH  Bike', 'MERACH\tBike', 'MERACH\u200BBike']) {
    const issue = inspect({ ...SAMPLE_INPUT, title }).issues.find(x => x.ruleId === 'T07');
    const guide = issueGuidance(issue, title);
    assert.match(guide.fragments[0], /MERACH/);
    if (title.includes('  ')) {
      assert.match(guide.fragments[0], /␣␣/);
      assert.equal(suggestFormatting(title), 'MERACH Bike');
    } else {
      assert.match(guide.action, /重输/);
      assert.equal(suggestFormatting(title), title);
    }
  }
});

test('brand case mismatch and missing brand offer distinct directions; unknown rules retain evidence', () => {
  const mismatch = inspect({ ...SAMPLE_INPUT, title: 'merach Indoor Cycling Bike' }).issues.find(x => x.ruleId === 'T10');
  const absent = inspect({ ...SAMPLE_INPUT, title: 'Indoor Cycling Bike' }).issues.find(x => x.ruleId === 'T10');
  assert.match(issueGuidance(mismatch).action, /标题或商品资料/);
  assert.match(issueGuidance(absent).action, /使用授权/);
  assert.equal(issueGuidance({ ruleId: 'future', name: '旧提示', message: '保留原始说明' }).action, '保留原始说明');
});
