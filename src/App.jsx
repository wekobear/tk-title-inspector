import RuleSwitch from './RuleSwitch.jsx';
import CustomRules from './CustomRules.jsx';
import {readCustom, writeCustom} from './custom-rules.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RULES,
  RULE_VERSION,
  LEXICON,
  DEFAULT_INPUT,
  SAMPLE_INPUT,
  inspect,
  suggestFormatting,
  reviewRequirements,
  canRecordReview,
} from './engine.js';
import { issueGuidance } from './issue-guidance.js';
import { parseImport, parsePasted, downloadTemplate, exportResults } from './files.js';
import { loadHistory, saveHistory, upsertRecord } from './storage.js';

/* ================= 常量与文案 ================= */

const SOURCE_TYPE_LABELS = {
  PLATFORM_REQUIREMENT: '平台政策相关',
  OFFICIAL_RECOMMENDATION: '官方建议',
  INTERNAL_HEURISTIC: '本工具建议',
  CUSTOM: '自定义规则（非平台政策）',
};

const COVERAGE_STATE_LABELS = {
  EXECUTED: '已执行',
  SKIPPED: '未执行',
  MANUAL_PENDING: '待人工',
  DISABLED: '已停用',
};

const MODE_LABELS = { auto: '自动检查', manual: '人工检查', disabled: '已停用' };

const SEVERITY_LABELS = { REVIEW: '待核验', SUGGESTION: '建议' };

const MARKET_OPTIONS = [
  { value: 'US', label: '美国（US）' },
  { value: 'unknown', label: '未指定，仅格式检查' },
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: '英语（en）' },
  { value: 'unknown', label: '未指定' },
];

const CATEGORY_OPTIONS = [
  { value: 'fitness', label: '健身器材（fitness）' },
  { value: 'other', label: '其他（other）' },
  { value: 'unknown', label: '未指定（unknown）' },
];

const BRAND_STATUS_OPTIONS = [
  { value: 'unknown', label: '未知 / 未提供' },
  { value: 'branded', label: '有品牌（branded）' },
  { value: 'unbranded', label: '无品牌（unbranded）' },
];

/* ================= 纯工具函数 ================= */

function cpLength(text) {
  return Array.from(text || '').length;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(iso);
  }
}

const INPUT_FIELDS = [
  'title',
  'market',
  'language',
  'category',
  'brandStatus',
  'brand',
  'productType',
  'features',
  'factsSource',
  'factsComplete',
];

function buildInput(form) {
  const input = {};
  for (const key of INPUT_FIELDS) input[key] = form[key];
  input.title = typeof input.title === 'string' ? input.title : '';
  input.factsComplete = Boolean(input.factsComplete);
  return input;
}

function sameInput(a, b) {
  if (!a || !b) return false;
  return INPUT_FIELDS.every((key) => (a[key] || '') === (b[key] || '') && Boolean(a.factsComplete) === Boolean(b.factsComplete));
}

function emptyForm() {
  return {
    title: '',
    market: DEFAULT_INPUT.market,
    language: DEFAULT_INPUT.language,
    category: DEFAULT_INPUT.category,
    brandStatus: DEFAULT_INPUT.brandStatus,
    brand: '',
    productType: '',
    features: '',
    factsSource: '',
    factsComplete: false,
  };
}

function formFromInput(input) {
  const form = emptyForm();
  for (const key of INPUT_FIELDS) {
    if (input && input[key] !== undefined && input[key] !== null) form[key] = input[key];
  }
  return form;
}

function sampleForm() {
  const form = formFromInput(SAMPLE_INPUT || {});
  // 示例仅为体验：事实来源使用演示说明，且不声明“事实已齐备”。
  form.factsSource = (SAMPLE_INPUT && SAMPLE_INPUT.factsSource) || '演示资料，仅用于体验';
  form.factsComplete = false;
  return form;
}

function sourceTypeLabel(sourceType) {
  return SOURCE_TYPE_LABELS[sourceType] || sourceType || '内部规则';
}

function coverageStateLabel(state) {
  return COVERAGE_STATE_LABELS[state] || state || '';
}

/** 用码点区间在标题上渲染高亮（不使用 innerHTML）。 */
function HighlightTitle({ title, issues }) {
  const chars = Array.from(title || '');
  const flagBySeverity = chars.map(() => null); // 'REVIEW' | 'SUGGESTION'
  const validIssues = (issues || []).filter(
    (issue) => Array.isArray(issue.spans) && issue.spans.length > 0
  );
  for (const issue of validIssues) {
    for (const span of issue.spans) {
      const start = Math.max(0, Number(span[0]) || 0);
      const end = Math.min(chars.length, Number(span[1]) || 0);
      for (let i = start; i < end; i += 1) {
        if (!flagBySeverity[i]) flagBySeverity[i] = issue.severity;
        else if (flagBySeverity[i] !== issue.severity) flagBySeverity[i] = 'REVIEW';
      }
    }
  }
  const parts = [];
  let buffer = [];
  let current = null;
  const flush = (key) => {
    if (buffer.length === 0) return;
    const text = buffer.join('');
    if (current === 'REVIEW') {
      parts.push(
        <mark className="hl-mark" key={key}>
          {text}
        </mark>
      );
    } else if (current === 'SUGGESTION') {
      parts.push(
        <span className="hl-mark hl-mark-suggestion" key={key}>
          {text}
        </span>
      );
    } else {
      parts.push(<span key={key}>{text}</span>);
    }
    buffer = [];
  };
  flagBySeverity.forEach((flag, index) => {
    if (flag !== current) {
      flush(`p${index}`);
      current = flag;
    }
    buffer.push(chars[index]);
  });
  flush(`p${chars.length}`);
  if (parts.length === 0) parts.push(<span key="empty">{title}</span>);
  return <>{parts}</>;
}

function sliceSpan(title, span) {
  const chars = Array.from(title || '');
  const start = Math.max(0, Number(span[0]) || 0);
  const end = Math.min(chars.length, Number(span[1]) || 0);
  return chars.slice(start, end).join('');
}

/* ================= 通用小组件 ================= */

function Badge({ tone = 'neutral', dot = false, className = '', children }) {
  const base = tone === 'review' ? 'badge badge-review' : tone === 'ink' ? 'badge badge-ink' : 'badge';
  const cls = className ? `${base} ${className}` : base;
  return (
    <span className={cls}>
      {dot ? <span className={tone === 'review' ? 'dot dot-amber' : 'dot'} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

function Msg({ kind = 'error', children }) {
  if (!children) return null;
  return (
    <p className={kind === 'ok' ? 'msg msg-ok' : 'msg msg-error'} role={kind === 'ok' ? 'status' : 'alert'}>
      {children}
    </p>
  );
}

function StatusPill({ status }) {
  if (status === 'INVALID_INPUT') return <Badge tone="ink">输入无效</Badge>;
  return (
    <Badge tone="review" dot>
      草稿 · 待人工核验
    </Badge>
  );
}

function Field({ label, hint, htmlFor, children }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        <span>
          {label}
          {hint ? <span className="field-label-count"> · {hint}</span> : null}
        </span>
      </label>
      {children}
    </div>
  );
}

/* ================= 单条检测：输入面板 ================= */

function InputPanel({
  form,
  onFormChange,
  onCheck,
  onSample,
  onClear,
  checking,
  engineError,
  rulesBlocked,
}) {
  const charCount = cpLength(form.title);
  const disabled = checking || charCount === 0 || rulesBlocked;
  return (
    <section className="panel" aria-labelledby="single-input-title">
      <h2 className="panel-title" id="single-input-title">
        录入参数
      </h2>
      <p className="panel-hint">输入标题并选择适用范围，可补充商品事实辅助核验。</p>

      <div className="field">
        <label htmlFor="title-input">
          <span>商品原标题</span>
          <span className="field-label-count" aria-hidden="true">
            {charCount} 字符
          </span>
        </label>
        <textarea
          id="title-input"
          className="textarea"
          rows="3"
          value={form.title}
          onChange={(event) => onFormChange('title', event.target.value)}
          placeholder="粘贴待检查的英文商品标题"
          aria-describedby="title-count-desc"
        />
        <span className="sr-only" id="title-count-desc" aria-live="polite">
          当前 {charCount} 个字符
        </span>
      </div>

      <div className="field-row">
        <Field label="目标市场" htmlFor="market-select">
          <select
            id="market-select"
            className="select"
            value={form.market}
            onChange={(event) => onFormChange('market', event.target.value)}
          >
            {MARKET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="语言" htmlFor="language-select">
          <select
            id="language-select"
            className="select"
            value={form.language}
            onChange={(event) => onFormChange('language', event.target.value)}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="类目" htmlFor="category-select">
        <select
          id="category-select"
          className="select"
          value={form.category}
          onChange={(event) => onFormChange('category', event.target.value)}
        >
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <details className="facts">
        <summary>
          <span>商品事实（可选，用于减少待核验项）</span>
        </summary>
        <div className="facts-body">
          <p className="facts-note">
            这些字段不是必填：不填也能得到格式草稿。填写后引擎可对照品牌、产品类型等事实；
            “事实来源”需写真实资料出处，勾选“事实已齐备”表示你已核对资料，工具不会替你核验。
          </p>
          <Field label="品牌状态" htmlFor="brand-status-select">
            <select
              id="brand-status-select"
              className="select"
              value={form.brandStatus}
              onChange={(event) => onFormChange('brandStatus', event.target.value)}
            >
              {BRAND_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="规范品牌名"
            hint={form.brandStatus !== 'branded' ? '选择“有品牌”后填写' : '与包装一致的规范写法'}
            htmlFor="brand-input"
          >
            <input
              id="brand-input"
              className="input"
              type="text"
              value={form.brand}
              disabled={form.brandStatus !== 'branded'}
              onChange={(event) => onFormChange('brand', event.target.value)}
              placeholder="例如 MERACH"
            />
          </Field>
          <Field label="产品类型（英文表述）" htmlFor="product-type-input">
            <input
              id="product-type-input"
              className="input"
              type="text"
              value={form.productType}
              onChange={(event) => onFormChange('productType', event.target.value)}
              placeholder="例如 Indoor Cycling Bike"
            />
          </Field>
          <Field label="核心特征（每行一条）" htmlFor="features-input">
            <textarea
              id="features-input"
              className="textarea"
              rows="3"
              value={form.features}
              onChange={(event) => onFormChange('features', event.target.value)}
              placeholder={'LCD Display\nMagnetic Resistance'}
            />
          </Field>
          <Field label="事实来源说明" htmlFor="facts-source-input">
            <input
              id="facts-source-input"
              className="input"
              type="text"
              value={form.factsSource}
              onChange={(event) => onFormChange('factsSource', event.target.value)}
              placeholder="内部资料编号或链接，例如：商品资料表 2026-10-20"
            />
          </Field>
          <div className="checkline" style={{ marginBottom: 16 }}>
            <input
              id="facts-complete"
              type="checkbox"
              checked={form.factsComplete}
              onChange={(event) => onFormChange('factsComplete', event.target.checked)}
            />
            <label htmlFor="facts-complete">
              我已核对资料，标题涉及的商品事实（品牌、类型、规格等）已按来源提供。
              此声明只表示人工已提供资料，不代表系统核验通过。
            </label>
          </div>
        </div>
      </details>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={onCheck} disabled={disabled}>
          {checking ? '检测中…' : '检测标题'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onSample} disabled={checking}>
          填入示例
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClear} disabled={checking}>
          清空
        </button>
      </div>
      {disabled && charCount === 0 ? (
        <p className="inline-note">标题为空时不检测；先粘贴标题或点击“填入示例”。</p>
      ) : null}
      <Msg kind="error">{engineError}</Msg>
    </section>
  );
}

/* ================= 结果面板子组件 ================= */

function IssueItem({ issue, title }) {
  const isReview = issue.severity === 'REVIEW';
  const guide = issueGuidance(issue, title);
  return (
    <article className="issue">
      <div className="issue-heading">
        <h3 className="issue-name"><span className={isReview ? 'dot dot-amber' : 'dot'} aria-hidden="true" />{guide.headline}</h3>
        <Badge tone={isReview ? 'review' : 'neutral'}>{isReview ? '需处理' : '建议修改'}</Badge>
      </div>
      <div className="issue-body">
        {guide.fragments.length > 0 ? <div className="issue-fragments">
          <span>位置</span>{guide.fragments.map((text, index) => <code key={index}>{text}</code>)}
          {issue.ruleId === 'T07' ? <small>␣ 表示一个空格</small> : null}
        </div> : null}
        <p className="issue-action"><strong>怎么改</strong>{guide.action}</p>
        <details className="issue-evidence">
          <summary>为什么提示 · {sourceTypeLabel(issue.sourceType)}</summary>
          <p>{issue.message}</p>
          {issue.sourceTitle ? <p>{issue.sourceTitle}</p> : null}
          {issue.sourceUrl ? <a href={issue.sourceUrl} target="_blank" rel="noreferrer">查看参考页面</a> : null}
          <p className="mono">规则 {issue.ruleId}</p>
        </details>
      </div>
    </article>
  );
}

function CoverageList({ coverage }) {
  return (
    <div className="cover-grid">
      {(coverage || []).map((row) => (
        <div className="cover-row" key={row.ruleId}>
          <span className="cover-name">
            <span className={row.state === 'EXECUTED' ? 'dot dot-ink' : 'dot'} aria-hidden="true" />
            {row.name}
            <span className="mono" style={{ color: 'var(--faint)', fontWeight: 400 }}>
              {row.ruleId}
            </span>
          </span>
          <span className="cover-reason">
            <Badge tone="neutral" className="cover-state">
              {coverageStateLabel(row.state)}
            </Badge>
            {row.reason ? ` ${row.reason}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function DraftNotice({ result }) {
  const missing = (result.missing || []).filter(item => !item.startsWith('研究规则'));
  const directions = {
    '未选择受支持的美国 / 英语范围': '在检测范围中选择美国 / 英语；其他范围目前仅检查空白格式。',
    '尚未指定商品类目': '在检测范围中选择商品类目。',
    '品牌状态未确认': '展开“商品事实”，确认商品有品牌还是无品牌。',
    '缺少品牌名称': '在“商品事实”中填入准确的品牌名称。',
    '缺少产品类型': '在“商品事实”中填入产品类型，例如 Indoor Cycling Bike。',
    '缺少商品事实来源': '在“商品事实”中填写可核对的资料来源。',
    '未确认已提供完整商品事实': '核对并补齐商品事实；确认完整后，再勾选完整性确认。',
  };
  return (
    <div className="notice">
      <p style={{ margin: 0 }}>研究规则仅供辅助检查，发布前仍需人工确认。{result.error ? ` ${result.error}` : ''}</p>
      {missing.length > 0 ? <details className="issue-evidence">
        <summary>另有 {missing.length} 项商品资料待确认</summary>
        <ul>{missing.map((item, index) => <li key={index}>{directions[item] || item}</li>)}</ul>
        <p>补齐资料后，请重新检测原标题。</p>
      </details> : null}
    </div>
  );
}

function CandidatePanel({
  result,
  candidate,
  candidateResult,
  onCandidateChange,
  onTidySpaces,
  onRecheck,
  onCopy,
  copyMsg,
  rechecking,
  rulesStale,
}) {
  const [copyState, setCopyState] = useState(null);
  const textareaRef = useRef(null);
  useEffect(() => setCopyState(null), [candidate]);

  const doCopy = useCallback(async () => {
    const text = candidate || '';
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok && textareaRef.current) {
      try {
        textareaRef.current.select();
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
    }
    setCopyState(ok ? 'ok' : 'fail');
    onCopy(ok);
  }, [candidate, onCopy]);

  const candidateCount = cpLength(candidate);
  return (
    <div className="candidate-box">
      <div className="candidate-head">
        <h3 className="candidate-title">修改后的标题</h3>
        <span className="badge mono">{candidateCount} 字符</span>
      </div>
      <textarea
        ref={textareaRef}
        id="candidate-title"
        className="textarea"
        rows="3"
        value={candidate}
        aria-label="修改后的标题"
        onChange={(event) => onCandidateChange(event.target.value)}
        placeholder="按上方提示修改，再点击下方按钮检测一次"
      />
      {rulesStale ? <p className="inline-note">规则已更新，请先重新检测原标题，再检测修改稿。</p> : null}
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRecheck}
          disabled={!candidate || rechecking || rulesStale}
        >
          {rechecking ? '复检中…' : '检测修改后的标题'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onTidySpaces}
          disabled={!candidate}
          title="仅去除首尾空格并合并连续 ASCII 空格，不删词、不改大小写"
        >
          一键整理空格
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={doCopy} disabled={!candidate}>
          复制修改后标题
        </button>
      </div>
      {copyState ? (
        <p className={copyState === 'ok' ? 'msg msg-ok' : 'msg msg-error'} style={{ margin: 0 }}>
          {copyState === 'ok' ? '已复制修改后标题。' : '复制失败，请手动选中文本复制。'}
        </p>
      ) : null}
      {copyMsg ? <span className="sr-only" aria-live="polite">{copyMsg}</span> : null}
      <p className="inline-note" style={{ margin: 0 }}>
        先按上方提示修改，再检测一次。整理空格只改这里的普通空格，原标题会保留；检测后保存修改稿。
      </p>
      {candidateResult ? (
        <div className="diff-grid">
          <div className="diff-cell">
            <div className="lbl">
              <span>原标题</span>
              <span className="mono">
                待核验 {result.counts.review} · 建议 {result.counts.suggestion} · {result.length} 字符
              </span>
            </div>
            <div className="txt">{result.title}</div>
          </div>
          <div className="diff-cell">
            <div className="lbl">
              <span>修改后（已检测）</span>
              <span className="mono">
                待核验 {candidateResult.counts.review} · 建议 {candidateResult.counts.suggestion} ·{' '}
                {candidateResult.length} 字符
              </span>
            </div>
            <div className="txt">{candidateResult.title}</div>
          </div>
        </div>
      ) : (
        <p className="inline-note" style={{ margin: 0 }}>
          尚未检测修改稿；原标题待核验 {result.counts.review} 项、建议 {result.counts.suggestion} 项。
        </p>
      )}
      {candidateResult?.issues.length > 0 ? <div>
        <p className="field-label">修改稿还需处理（{candidateResult.issues.length} 项）</p>
        <div className="issue-list">{candidateResult.issues.map(issue => <IssueItem key={issue.id} issue={issue} title={candidateResult.title} />)}</div>
      </div> : null}
      {candidateResult && candidateResult.status !== 'INVALID_INPUT' && candidateResult.issues.length === 0 ? <p className="inline-note">修改稿未发现本工具能识别的问题；发布前仍需人工确认。</p> : null}
      {candidateResult && candidateResult.status === 'INVALID_INPUT' ? (
        <Msg kind="error">候选输入无效：{candidateResult.error || '请检查候选内容'}</Msg>
      ) : null}
    </div>
  );
}

function ReviewPanel({ result, candidateResult, candidate, checkedIds, onToggle, onRecord, reviewed, reviewedAt, currentCustomVersion }) {
  const effectiveResult = candidateResult || result;
  const requirements = useMemo(() => {
    try {
      return reviewRequirements(effectiveResult.input || result.input);
    } catch {
      return [];
    }
  }, [effectiveResult, result]);

  const reviewIssues = useMemo(
    () => (effectiveResult.issues || []).filter((issue) => issue.severity === 'REVIEW'),
    [effectiveResult]
  );

  const eligible = useMemo(() => {
    try {
      return canRecordReview({ result, candidateResult, candidate, checkedIds, currentCustomVersion });
    } catch {
      return false;
    }
  }, [result, candidateResult, candidate, checkedIds, currentCustomVersion]);

  const blockers = result.missing.filter(item => !item.startsWith('研究规则')); 
  if (result.ruleVersion !== RULE_VERSION || result.customRuleVersion !== currentCustomVersion || (candidateResult && (candidateResult.ruleVersion !== RULE_VERSION || candidateResult.customRuleVersion !== currentCustomVersion))) blockers.push('规则已更新，重新检测原标题和修改稿后才能记录复核。');
  if (!candidateResult) blockers.push('候选标题尚未重新检测（需以最新候选为准）。');
  else if (candidateResult.status === 'INVALID_INPUT') blockers.push('候选标题输入无效，需修正后重新检测。');
  if (candidateResult && candidate !== candidateResult.title)
    blockers.push('候选文本已改动，需再次“检测修改后的标题”。');
  if (reviewIssues.length > 0)
    blockers.push(`候选仍有 ${reviewIssues.length} 项待核验问题未处理（需修改标题或补齐事实后重检）。`);
  if (requirements.length > 0 && checkedIds.length < requirements.length)
    blockers.push(`确认项未全部勾选（${checkedIds.length}/${requirements.length}）。`);
  if (result.status === 'INVALID_INPUT') blockers.push('原始输入无效。');

  return (
    <details className="facts">
      <summary>
        <span>人工复核记录（{requirements.length} 项确认）</span>
      </summary>
      <div className="facts-body">
        <p className="facts-note">
          复核是对草稿结论的人工记录，不是“正式采用”：规则包仍为草稿，平台合规性不由本工具判定。
          修改输入或候选后，确认项会重置；请以最新复检结果为准。
        </p>
        {reviewIssues.length > 0 ? (
          <div className="review-block-reason" style={{ border: 'none', padding: 0, marginTop: 0 }}>
            <p style={{ margin: '0 0 6px', fontWeight: 600, color: 'var(--ink)' }}>当前待核验问题（未处理完不能记录复核）：</p>
            <ul>
              {reviewIssues.map((issue) => (
                <li key={issue.id}>
                  {issueGuidance(issue, effectiveResult.title).headline}：{issueGuidance(issue, effectiveResult.title).action}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="review-list">
          {requirements.map((requirement) => (
            <label className="review-item" key={requirement.id}>
              <input
                type="checkbox"
                checked={checkedIds.includes(requirement.id)}
                disabled={reviewed}
                onChange={(event) => onToggle(requirement.id, event.target.checked)}
              />
              <span>{requirement.label}</span>
            </label>
          ))}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            onClick={onRecord}
            disabled={!eligible || reviewed}
          >
            记录人工复核
          </button>
          {reviewed ? (
            <Badge tone="ink">已记录人工复核 · {formatTime(reviewedAt)}</Badge>
          ) : (
            <Badge tone="review">未记录复核</Badge>
          )}
        </div>
        {!reviewed ? (
          <div className="review-block-reason">
            {blockers.length > 0 ? (
              <>
                记录条件未满足：
                <ul>
                  {blockers.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </>
            ) : (
              '条件已满足，可以记录本次人工复核。'
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/* ================= 结果面板 ================= */

function ResultPanel({
  result,
  candidate,
  candidateResult,
  checkedIds,
  reviewed,
  reviewedAt,
  onCandidateChange,
  onTidySpaces,
  onRecheck,
  onCopy,
  copyMsg,
  rechecking,
  onToggleCheck,
  onRecordReview,
  currentCustomVersion,
}) {
  const [showCoverage, setShowCoverage] = useState(false);
  const invalid = result.status === 'INVALID_INPUT';
  return (
    <section className="panel" aria-labelledby="result-title">
      <div className="result-head">
        <h2 className="result-title" id="result-title">
          {invalid ? '检测未执行：输入无效' : '已检查 · 仍需人工确认'}
        </h2>
        <StatusPill status={result.status} />
      </div>
      <div className="count-row">
        <span>
          <span className="num">{result.counts.review}</span> 项待人工核验
        </span>
        <span>
          <span className="num">{result.counts.suggestion}</span> 条修改建议
        </span>
        <span>
          标题 <span className="num">{result.length}</span> 字符（含空格）
        </span>
        <span>
          规则版本 <span className="num">{result.ruleVersion}</span>
        </span>
      </div>

      <p className="inline-note">内置命中 {result.issues.filter(i=>i.sourceType!=='CUSTOM').length} · 自定义命中 {result.issues.filter(i=>i.sourceType==='CUSTOM').length} · 本机规则配置版本 {result.customRuleVersion || '旧记录'}</p>
      {result.customRuleVersion !== currentCustomVersion || result.ruleVersion !== RULE_VERSION ? <p className="msg msg-error">规则已更新，重新检测后才能记录复核。</p> : null}
      {invalid ? (
        <>
          <Msg kind="error">{result.error || '输入无效，请检查标题后重新检测。'}</Msg>
          <DraftNotice result={result} />
        </>
      ) : (
        <>
          <div className="panel-section">
            <div className="action-heading">
              <h3 className="field-label">{result.issues.length ? `原标题：${result.issues.length} 条修改提示` : '未发现本工具能识别的问题'}</h3>
              {result.issues.length > 0 ? <a className="edit-link" href="#candidate-title">去修改标题 ↓</a> : null}
            </div>
            {result.issues.length > 0 ? <div className="issue-list">
              {result.issues.map(issue => <IssueItem key={issue.id} issue={issue} title={result.title} />)}
            </div> : <p className="inline-note">仍需核对品牌、规格和商品事实，不能据此判定已通过平台审核。</p>}
          </div>
          <details className="facts original-highlight">
            <summary>查看原标题与标记</summary>
            <div className="facts-body"><div className="hl-box"><HighlightTitle title={result.title} issues={result.issues} /></div>
              <p className="hl-caption">琥珀色为需处理片段，灰色为建议调整的片段。</p>
            </div>
          </details>

          <div className="panel-section">
            <CandidatePanel
              result={result}
              candidate={candidate}
              candidateResult={candidateResult}
              onCandidateChange={onCandidateChange}
              onTidySpaces={onTidySpaces}
              onRecheck={onRecheck}
              onCopy={onCopy}
              copyMsg={copyMsg}
              rechecking={rechecking}
              rulesStale={result.ruleVersion !== RULE_VERSION || result.customRuleVersion !== currentCustomVersion}
            />
          </div>

          <DraftNotice result={result} />

          <div className="panel-section">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={showCoverage}
              onClick={() => setShowCoverage((value) => !value)}
            >
              {showCoverage ? '收起检查覆盖明细' : `展开检查覆盖明细（${(result.coverage || []).length} 项）`}
            </button>
            {showCoverage ? (
              <div style={{ marginTop: 10 }}>
                <CoverageList coverage={result.coverage} />
              </div>
            ) : null}
          </div>

          <div className="panel-section">
            <ReviewPanel
              result={result}
              candidateResult={candidateResult}
              candidate={candidate}
              checkedIds={checkedIds}
              onToggle={onToggleCheck}
              onRecord={onRecordReview}
              reviewed={reviewed}
              reviewedAt={reviewedAt}
              currentCustomVersion={currentCustomVersion}
            />
          </div>
        </>
      )}
    </section>
  );
}

/* ================= 批量检测 ================= */

const BATCH_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'review', label: '有待核验问题' },
  { value: 'clean', label: '无待核验问题' },
  { value: 'invalid', label: '输入无效' },
  { value: 'error', label: '解析/执行错误' },
];

function BatchPanel({ baseForm, records, onPersist, onOpenRow, customStore }) {
  const [rows, setRows] = useState([]);
  const [sourceLabel, setSourceLabel] = useState('');
  const [parseError, setParseError] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(() => new Set());
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [runError, setRunError] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const applyParsed = useCallback((parsed, label) => {
    const list = (parsed.rows || []).map((row) => ({
      rowNumber: row.rowNumber,
      input: row.input || buildInput(emptyForm()),
      error: row.error || '',
      result: null,
      runError: '',
    }));
    setRows(list);
    setSourceLabel(label);
    setSelected(new Set());
    setRunMsg(
      list.length > 0
        ? `已载入 ${list.length} 行（来源：${label}），替换了之前的批量工作区。尚未检测，点击“开始批量检测”执行。`
        : '未解析到任何数据行。'
    );
    setRunError('');
  }, []);

  const onFileChange = useCallback(
    async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      setImporting(true);
      setParseError('');
      try {
        const parsed = await parseImport(file);
        applyParsed(parsed, parsed.fileName || file.name);
      } catch (error) {
        setParseError(`文件导入失败：${error && error.message ? error.message : String(error)}。当前批量工作区保持不变。`);
        setRunMsg('');
        setRunError('');
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [applyParsed]
  );

  const onImportPaste = useCallback(() => {
    setParseError('');
    const text = pasteText || '';
    if (!text.trim()) {
      setParseError('粘贴内容为空：请每行一条标题后再导入。');
      return;
    }
    try {
      const parsed = parsePasted(text, {...emptyForm(), market: baseForm.market, language: baseForm.language, category: baseForm.category});
      applyParsed(parsed, '粘贴输入');
    } catch (error) {
      setParseError(`粘贴解析失败：${error && error.message ? error.message : String(error)}`);
    }
  }, [pasteText, baseForm]);

  const runBatch = useCallback(async () => {
    if (rows.length === 0 || running || customStore.error) return;
    const snapshot=structuredClone(customStore.set);
    setRunning(true);
    setRunError('');
    setRunMsg('批量检测执行中…');
    const nextRows = [];
    for (const row of rows) {
      let result = null;
      let runError = '';
      try {
        const inspectInput = { ...row.input };
        result = inspect(inspectInput, snapshot);
        if (row.error) {
          runError = row.error;
          result = { ...result, status: 'INVALID_INPUT', error: row.error, issues: [], counts: {review: 0, suggestion: 0},
            coverage: result.coverage.map(c => ({...c, state: 'SKIPPED', reason: '导入行数据无效，未执行检查'})) };
        }
      } catch (error) {
        runError = row.error || (error && error.message ? error.message : String(error));
        const failed = inspect({title: ''}, snapshot);
        result = {...failed, title: row.input.title, input: {...row.input}, length: cpLength(row.input.title), error: `检测失败：${runError}`};
      }
      nextRows.push({ ...row, result, runError });
    }
    const executedRecords = nextRows
      .filter((row) => row.result)
      .map((row) => ({...makeRecord(row.result, row.result.title, null, [], false, null), rowNumber: row.rowNumber}));
    setRows(nextRows);
    const invalidCount = nextRows.filter((row) => row.result && row.result.status === 'INVALID_INPUT').length;
    const failedCount = nextRows.filter((row) => row.runError).length;
    setRunMsg(
      `批量检测完成：共 ${nextRows.length} 行，已处理 ${executedRecords.length} 行，其中输入无效 ${invalidCount} 行。`
    );
    if (failedCount > 0) {
      setRunError(`有 ${failedCount} 行包含导入或执行错误，详情已保留在各行及导出结果中。`);
    }
    setRunning(false);
    if (executedRecords.length > 0 && onPersist) onPersist(executedRecords);
  }, [rows, running, onPersist, customStore]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const title = row.input && row.input.title ? row.input.title : '';
      if (q && !title.toLowerCase().includes(q)) return false;
      if (filter === 'review') return !!(row.result && (row.result.counts.review > 0 || row.result.status === 'INVALID_INPUT'));
      if (filter === 'clean') return !!(row.result && row.result.counts.review === 0 && row.result.status !== 'INVALID_INPUT');
      if (filter === 'invalid') return !!(row.result && row.result.status === 'INVALID_INPUT');
      if (filter === 'error') return Boolean(row.error || row.runError);
      return true;
    });
  }, [rows, query, filter]);

  const totals = useMemo(() => {
    const checked = rows.filter((row) => row.result);
    return {
      rows: rows.length,
      checked: checked.length,
      invalid: checked.filter((row) => row.result.status === 'INVALID_INPUT').length,
      reviewIssues: checked.reduce((sum, row) => sum + (row.result.counts.review || 0), 0),
      suggestions: checked.reduce((sum, row) => sum + (row.result.counts.suggestion || 0), 0),
      failed: rows.filter((row) => row.runError).length,
      selected: rows.filter((row) => selected.has(row.rowNumber) && row.result).length,
    };
  }, [rows, selected]);

  const toggleSelected = useCallback((rowNumber, checked) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(rowNumber);
      else next.delete(rowNumber);
      return next;
    });
  }, []);

  const selectableVisible = filtered.filter((row) => row.result);
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((row) => selected.has(row.rowNumber));

  const exportBatch = useCallback(
    (mode) => {
      const target = rows.filter(
        (row) => row.result && (mode === 'all' || selected.has(row.rowNumber))
      );
      if (target.length === 0) {
        setRunError('没有可导出的行：请先检测，或调整勾选。');
        return;
      }
      try {
        exportResults(target.map((row) => ({...records.find(r => r.result.id === row.result.id), rowNumber: row.rowNumber, result: row.result})));
        setRunError('');
        setRunMsg(`已导出 ${target.length} 行检查结果（CSV）。`);
      } catch (error) {
        setRunError(`导出失败：${error && error.message ? error.message : String(error)}`);
      }
    },
    [rows, selected, records]
  );

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">批量导入与检测</h2>
        <p className="panel-hint">
          支持 UTF-8 CSV / XLSX（无宏），最多 100 行、5MB。也可以直接粘贴标题（每行一条）。
          新导入会替换当前批次。检测后各行均存入本机历史，错误行也会保留。
        </p>
        <div className="batch-toolbar">
          <label className="file-label">
            <input
              ref={fileRef}
              className="file-input"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onFileChange}
              disabled={importing}
            />
            {importing ? '解析文件中…' : '导入 CSV / XLSX'}
          </label>
          <button type="button" className="btn btn-secondary" onClick={() => downloadTemplate()}>
            下载导入模板
          </button>
        </div>
        <Msg kind="error">{parseError}</Msg>

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="batch-paste">
            <span>粘贴标题（备选方式）</span>
            <span className="field-label-count">每行一条 · 最多 100 行</span>
          </label>
          <textarea
            id="batch-paste"
            className="textarea"
            rows="4"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={'MERACH Indoor Cycling Bike with LCD Display\nAnother Product Title…'}
          />
          <p className="inline-note">粘贴使用单条页面所选范围：{MARKET_OPTIONS.find(o => o.value === baseForm.market)?.label} / {LANGUAGE_OPTIONS.find(o => o.value === baseForm.language)?.label}。商品事实需逐条补充，不沿用上一件商品的品牌和规格。</p>
        </div>
        <div className="btn-row" style={{ marginBottom: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onImportPaste}>
            导入粘贴标题（替换当前批次）
          </button>
        </div>

        <div className="btn-row">
          <button type="button" className="btn" onClick={runBatch} disabled={rows.length === 0 || running || !!customStore.error}>
            {running ? '批量检测中…' : '开始批量检测'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => exportBatch('all')}
            disabled={totals.checked === 0}
          >
            导出全部结果
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => exportBatch('selected')}
            disabled={totals.selected === 0}
          >
            导出勾选结果（{totals.selected}）
          </button>
        </div>
        {rows.length > 0 ? (
          <div className="total-row">
            <span>
              数据行 <span className="num">{totals.rows}</span>
            </span>
            <span>
              已检测 <span className="num">{totals.checked}</span>
            </span>
            <span>
              输入无效 <span className="num">{totals.invalid}</span>
            </span>
            <span>
              待核验问题 <span className="num">{totals.reviewIssues}</span>
            </span>
            <span>
              格式建议 <span className="num">{totals.suggestions}</span>
            </span>
            <span>
              行错误 <span className="num">{totals.failed}</span>
            </span>
            {sourceLabel ? <span>来源：{sourceLabel}</span> : null}
          </div>
        ) : null}
        <Msg kind="error">{runError}</Msg>
        <Msg kind="ok">{runMsg}</Msg>
      </section>

      {rows.length > 0 ? (
        <section className="panel">
          <h2 className="panel-title">批量结果（实际 {rows.length} 行）</h2>
          <div className="filter-bar">
            <input
              className="input"
              type="search"
              placeholder="按标题搜索本批次"
              aria-label="按标题搜索本批次"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="select"
              aria-label="筛选行"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              style={{ maxWidth: 220 }}
            >
              {BATCH_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="inline-note" style={{ margin: 0 }}>
              显示 {filtered.length} / {rows.length} 行
            </span>
          </div>

          <div className="table-wrap table-desktop">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      type="checkbox"
                      aria-label="全选当前显示且已检测的行"
                      checked={allVisibleSelected}
                      onChange={(event) => {
                        const next = new Set(selected);
                        selectableVisible.forEach((row) => {
                          if (event.target.checked) next.add(row.rowNumber);
                          else next.delete(row.rowNumber);
                        });
                        setSelected(next);
                      }}
                      disabled={selectableVisible.length === 0}
                    />
                  </th>
                  <th scope="col" className="num">
                    行号
                  </th>
                  <th scope="col">标题</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="num">
                    待核验
                  </th>
                  <th scope="col" className="num">
                    建议
                  </th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <BatchRowDesktop
                    key={row.rowNumber}
                    row={row}
                    checked={selected.has(row.rowNumber)}
                    onToggle={toggleSelected}
                    onOpen={onOpenRow}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="row-cards">
            {filtered.map((row) => (
              <BatchRowCard
                key={row.rowNumber}
                row={row}
                checked={selected.has(row.rowNumber)}
                onToggle={toggleSelected}
                onOpen={onOpenRow}
              />
            ))}
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="empty">
            <p className="empty-lead">批量工作区为空</p>
            <p>导入文件或粘贴标题后，这里会显示真实数据行（最多 100 行），没有演示数据。</p>
          </div>
        </section>
      )}
    </div>
  );
}

function BatchRowStatus({ row }) {
  if (!row.result) return <Badge tone="neutral">尚未检测</Badge>;
  if (row.result.status === 'INVALID_INPUT') return <Badge tone="ink">输入无效</Badge>;
  return (
    <Badge tone="review" dot>
      草稿 · 待人工核验
    </Badge>
  );
}

function BatchRowCheck({ row, checked, onToggle }) {
  return (
    <input
      type="checkbox"
      aria-label={`选择第 ${row.rowNumber} 行`}
      checked={checked}
      disabled={!row.result}
      onChange={(event) => onToggle(row.rowNumber, event.target.checked)}
    />
  );
}

function BatchRowOpen({ row, onOpen }) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => onOpen(row)}
      disabled={!row.result}
    >
      查看
    </button>
  );
}

function BatchRowError({ row }) {
  const error = row.runError || row.error || '';
  if (!error) return null;
  return <p className="inline-note" style={{ margin: 0 }}>行错误：{error}</p>;
}

function BatchRowDesktop({ row, checked, onToggle, onOpen }) {
  return (
    <tr>
      <td>
        <BatchRowCheck row={row} checked={checked} onToggle={onToggle} />
      </td>
      <td className="num">{row.rowNumber}</td>
      <td className="cell-title">
        {row.input.title || <span style={{ color: 'var(--faint)' }}>（空标题）</span>}
        <br />
        <BatchRowError row={row} />
      </td>
      <td>
        <BatchRowStatus row={row} />
      </td>
      <td className="num">{row.result ? row.result.counts.review : '—'}</td>
      <td className="num">{row.result ? row.result.counts.suggestion : '—'}</td>
      <td>
        <BatchRowOpen row={row} onOpen={onOpen} />
      </td>
    </tr>
  );
}

function BatchRowCard({ row, checked, onToggle, onOpen }) {
  return (
    <div className="row-card">
      <div className="row-card-top">
        <span className="mono">第 {row.rowNumber} 行</span>
        <BatchRowStatus row={row} />
      </div>
      <p className="row-card-title">{row.input.title || '（空标题）'}</p>
      <BatchRowError row={row} />
      <div className="btn-row">
        <BatchRowCheck row={row} checked={checked} onToggle={onToggle} />
        <BatchRowOpen row={row} onOpen={onOpen} />
        {row.result ? (
          <span className="inline-note" style={{ margin: 0 }}>
            待核验 {row.result.counts.review} · 建议 {row.result.counts.suggestion}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ================= 检查历史 ================= */

const HISTORY_FILTERS = [
  { value: 'all', label: '全部记录' },
  { value: 'reviewed', label: '已记录复核' },
  { value: 'unreviewed', label: '未记录复核' },
];

function HistoryPanel({ records, storageMsg, onOpenRecord, onExport }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');

  const sorted = useMemo(
    () =>
      [...records].sort((a, b) => {
        const ta = a.result && a.result.createdAt ? Date.parse(a.result.createdAt) : 0;
        const tb = b.result && b.result.createdAt ? Date.parse(b.result.createdAt) : 0;
        return (tb || 0) - (ta || 0);
      }),
    [records]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((record) => {
      const title = record.result && record.result.title ? record.result.title : '';
      if (q && !title.toLowerCase().includes(q)) return false;
      if (filter === 'reviewed') return Boolean(record.reviewed);
      if (filter === 'unreviewed') return !record.reviewed;
      return true;
    });
  }, [sorted, query, filter]);

  return (
    <section className="panel">
      <div className="result-head">
        <div>
          <h2 className="panel-title">检查历史</h2>
          <p className="panel-hint" style={{ marginBottom: 0 }}>
            最多保留 500 条，保存于本机浏览器（localStorage）。查看历史只读取快照，不会改动原记录。
          </p>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onExport(filtered, '当前筛选')}
            disabled={filtered.length === 0}
          >
            导出当前筛选（{filtered.length}）
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onExport(records, '全部')}
            disabled={records.length === 0}
          >
            导出全部（{records.length}）
          </button>
        </div>
      </div>
      {storageMsg ? <Msg kind="error">{storageMsg}</Msg> : null}

      <div className="filter-bar">
        <input
          className="input"
          type="search"
          placeholder="按标题搜索历史记录"
          aria-label="按标题搜索历史记录"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="select"
          aria-label="按复核状态筛选"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          style={{ maxWidth: 200 }}
        >
          {HISTORY_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="inline-note" style={{ margin: 0 }}>
          显示 {filtered.length} / {records.length} 条
        </span>
      </div>

      {records.length === 0 ? (
        <div className="empty">
          <p className="empty-lead">暂无历史记录</p>
          <p>在检测工作台执行“检测标题”后，记录会保存到这里（本机浏览器存储）。</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <p className="empty-lead">没有匹配的记录</p>
          <p>调整搜索词或筛选条件。</p>
        </div>
      ) : (
        <div className="history-list">
          {filtered.map((record) => (
            <article className="history-item" key={record.result.id}>
              <div className="row-card-top">
                <p className="history-title">{record.result.title || '（空标题）'}</p>
                {record.reviewed ? (
                  <Badge tone="ink">已记录复核</Badge>
                ) : (
                  <Badge tone="review" dot>
                    未记录复核
                  </Badge>
                )}
              </div>
              {record.result.error ? <p className="inline-note">输入无效：{record.result.error}</p> : null}
              <div className="history-meta">
                <span>{formatTime(record.result.createdAt)}</span>
                <span>
                  待核验 {record.result.counts.review} · 建议 {record.result.counts.suggestion}
                </span>
                <span>{record.result.length} 字符</span>
                {record.candidateResult ? (
                  <span>
                    候选已复检：待核验 {record.candidateResult.counts.review} · 建议{' '}
                    {record.candidateResult.counts.suggestion}
                  </span>
                ) : record.candidate && record.candidate !== record.result.title ? (
                  <span>候选未复检</span>
                ) : null}
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onOpenRecord(record)}
                >
                  查看
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ================= 规则与词库 ================= */

function RulesPanel({customStore,onWrite,onReload,onReset}) {
  const [pending, setPending] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const disabled = customStore.set?.builtinDisabled ?? [];
  const autoCount = RULES.filter(rule => rule.mode === 'auto' && !disabled.includes(rule.id)).length;
  const manualCount = RULES.filter(rule => rule.mode === 'manual' && !disabled.includes(rule.id)).length;
  const disabledCount = RULES.length - autoCount - manualCount;
  const toggleBuiltin = async rule => {
    if (pending || customStore.error || rule.mode === 'disabled') return;
    const next = disabled.includes(rule.id) ? disabled.filter(id => id !== rule.id) : [...disabled, rule.id];
    setPending(true);
    const result = await onWrite(customStore.raw, customStore.set.rules, next);
    setPending(false);
    setSwitchError(result.error || '内置规则配置已更新。');
  };
  return (
    <div>
      <CustomRules store={customStore} onWrite={onWrite} onReload={onReload} onReset={onReset} />
      <section className="panel">
        <h2 className="panel-title">内置规则目录</h2>
        <p className="panel-hint">
          共 {RULES.length} 项检查：自动 {autoCount} · 人工 {manualCount} · 停用 {disabledCount}。规则包版本{' '}
          <span className="mono">{RULE_VERSION}</span>，为草稿版本，未经生产发布核验；规则定义只读，可在本机启停已实现的检查。
        </p>
        {switchError ? <p className="msg" role="status">{switchError}{switchError.includes('重新载入') ? <button className="btn btn-secondary btn-sm" onClick={()=>{onReload();setSwitchError('已重新载入本机规则配置。');}}>重新载入</button> : null}</p> : null}
        {customStore.error ? <p className="msg msg-error">规则配置读取失败，请先备份并恢复。</p> : null}
        <div className="rule-list">
          {RULES.map((rule) => (
            <div className="builtin-rule-wrap" key={rule.id}>
            <details className="rule">
              <summary>
                <span className="rule-name">{rule.name}</span>
                <Badge tone={rule.mode === 'disabled' || disabled.includes(rule.id) ? 'neutral' : 'ink'}>
                  {rule.mode === 'disabled' ? '未实现' : disabled.includes(rule.id) ? '已停用' : MODE_LABELS[rule.mode] || rule.mode}
                </Badge>
              </summary>
              <div className="rule-body">
                <p style={{ margin: 0 }}>{rule.description}</p>
                {rule.mode === 'disabled' ? (
                  <div className="notice" style={{ margin: 0 }}>
                    尚未实现自动检查，暂不可启用。相关问题仍需人工判断。
                  </div>
                ) : null}
                <dl className="kv">
                  <dt>规则 ID</dt>
                  <dd className="mono">{rule.id}</dd>
                  <dt>作用域</dt>
                  <dd>{rule.scope}</dd>
                  <dt>依据类型</dt>
                  <dd>{sourceTypeLabel(rule.sourceType)}</dd>
                  {rule.sourceTitle ? (
                    <>
                      <dt>依据名称</dt>
                      <dd>{rule.sourceTitle}</dd>
                    </>
                  ) : null}
                  {rule.sourceUrl ? (
                    <>
                      <dt>官方来源</dt>
                      <dd>
                        <a href={rule.sourceUrl} target="_blank" rel="noreferrer">
                          打开官方页面
                        </a>
                      </dd>
                    </>
                  ) : null}
                  <dt>规则包版本</dt>
                  <dd className="mono">{RULE_VERSION}</dd>
                </dl>
                {Array.isArray(rule.examples) && rule.examples.length > 0 ? (
                  <div>
                    <p className="field-label" style={{ marginBottom: 6 }}>
                      示例
                    </p>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {rule.examples.map((example, index) => (
                        <li key={index}>{example}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </details>
            <RuleSwitch enabled={rule.mode !== 'disabled' && !disabled.includes(rule.id)} label={`启用内置规则 ${rule.name}`} disabled={pending || !!customStore.error || rule.mode === 'disabled'} describedBy={rule.mode === 'disabled' ? 'builtin-unavailable' : undefined} onClick={()=>toggleBuiltin(rule)} />
            {rule.mode === 'disabled' ? <span id="builtin-unavailable" className="builtin-unavailable">尚未实现自动检查，暂不可启用</span> : null}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-title">词库（只读）</h2>
        <p className="panel-hint">
          词典随规则包版本 <span className="mono">{RULE_VERSION}</span> 保存，命中仅作为草稿检查线索，不构成平台处罚判定。
        </p>
        <div className="lex-columns">
          <div>
            <p className="field-label">营销 / 主观短语（{(LEXICON.promotions || []).length} 条）</p>
            <div className="lex-list">
              {(LEXICON.promotions || []).map((word) => (
                <span className="lex-chip" key={word}>
                  {word}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="field-label">缩写例外（{(LEXICON.abbreviations || []).length} 条）</p>
            <div className="lex-list">
              {(LEXICON.abbreviations || []).map((word) => (
                <span className="lex-chip" key={word}>
                  {word}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ================= 应用外壳 ================= */

const NAV_ITEMS = [
  { id: 'workbench', label: '检测工作台' },
  { id: 'history', label: '检查历史' },
  { id: 'rules', label: '规则与词库' },
];

function makeRecord(result, candidate, candidateResult, checkedIds, reviewed, reviewedAt) {
  return {
    input: result.input,
    result,
    candidate,
    candidateResult: candidateResult || null,
    checkedIds: checkedIds || [],
    reviewed: Boolean(reviewed),
    reviewedAt: reviewedAt || null,
  };
}

export default function App() {
  const [view, setView] = useState('workbench');
  const [tab, setTab] = useState('single');

  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState(null);
  const [candidate, setCandidate] = useState('');
  const [candidateResult, setCandidateResult] = useState(null);
  const [checkedIds, setCheckedIds] = useState([]);
  const [reviewed, setReviewed] = useState(false);
  const [reviewedAt, setReviewedAt] = useState(null);
  const [fromRow, setFromRow] = useState(null);

  const [checking, setChecking] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [engineError, setEngineError] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const [liveMsg, setLiveMsg] = useState('');

  const [records, setRecords] = useState([]);
  const [storageMsg, setStorageMsg] = useState('');
  const [customStore,setCustomStore]=useState(readCustom);
  const reloadCustom=useCallback(()=>setCustomStore(readCustom()),[]);
  const writeRules=useCallback(async (expected,rules,builtinDisabled)=>{const response=await writeCustom(expected,rules,builtinDisabled);if(response.set){setCustomStore(response);setCheckedIds([]);}return response;},[]);
  useEffect(()=>{const listener=e=>{if(e.key===null || e.key==='tk-title-inspector.custom-rules.v1'){setCustomStore(readCustom());setCheckedIds([]);}};window.addEventListener('storage',listener);return ()=>window.removeEventListener('storage',listener);},[]);
  const recordsRef = useRef([]);

  useEffect(() => {
    const loaded = loadHistory();
    const list = loaded && Array.isArray(loaded.records) ? loaded.records : [];
    setRecords(list);
    recordsRef.current = list;
    if (loaded && loaded.error) setStorageMsg(`历史读取失败：${loaded.error}（当前会话新记录仍会保留在内存中）`);
  }, []);

  const persistRecord = useCallback((record) => {
    const existing = recordsRef.current.find(r => r.result.id === record.result.id);
    const next = upsertRecord(recordsRef.current, {...existing, ...record});
    recordsRef.current = next;
    setRecords(next);
    const save = saveHistory(next);
    if (!save || save.ok !== true) {
      setStorageMsg(`历史保存失败：${(save && save.error) || '未知错误'}。记录已保留在当前页面内存中，刷新会丢失。`);
    } else {
      setStorageMsg('');
    }
  }, []);

  const persistMany = useCallback((recordList) => {
    let next = recordsRef.current;
    for (const record of recordList) next = upsertRecord(next, record);
    recordsRef.current = next;
    setRecords(next);
    const save = saveHistory(next);
    if (!save || save.ok !== true) {
      setStorageMsg(`历史保存失败：${(save && save.error) || '未知错误'}。记录已保留在当前页面内存中，刷新会丢失。`);
    } else {
      setStorageMsg('');
    }
  }, []);

  const handleFormChange = useCallback((key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setCandidateResult(null);
    setCheckedIds([]);
    setReviewed(false);
    setReviewedAt(null);
  }, []);

  const loadSample = useCallback(() => {
    setEngineError('');
    setForm(sampleForm());
    setLiveMsg('已填入示例：仅为体验流程的演示资料，不代表真实商品事实。');
  }, []);

  const clearForm = useCallback(() => {
    setEngineError('');
    setForm(emptyForm());
    setLiveMsg('已清空输入。');
  }, []);

  const runCheck = useCallback(() => {
    setEngineError('');
    if(customStore.error){setEngineError('本机规则配置损坏，请先在规则页备份并恢复。');return;}
    setChecking(true);
    setFromRow(null);
    try {
      const input = buildInput(form);
      const checkResult = inspect(input, customStore.set);
      setResult(checkResult);
      const nextCandidate = result && result.title === checkResult.title ? candidate : checkResult.title;
      setCandidate(nextCandidate);
      setCandidateResult(null);
      setCheckedIds([]);
      setReviewed(false);
      setReviewedAt(null);
      setLiveMsg(
        checkResult.status === 'INVALID_INPUT'
          ? '检测未执行：输入无效。'
          : `检测完成：待核验 ${checkResult.counts.review} 项，建议 ${checkResult.counts.suggestion} 条。结果为待人工核验的草稿。`
      );
      persistRecord(makeRecord(checkResult, nextCandidate, null, [], false, null));
    } catch (error) {
      setEngineError(`检测失败：${error && error.message ? error.message : String(error)}`);
      setLiveMsg('检测失败，未生成结果。');
    } finally {
      setChecking(false);
    }
  }, [form, persistRecord, customStore, result, candidate]);

  const handleCandidateChange = useCallback(
    (value) => {
      setCandidate(value);
      // 候选变化后，旧复检结果、复核勾选与复核状态一律作废。
      if (!candidateResult || candidateResult.title !== value) {
        setCandidateResult(null);
        setCheckedIds([]);
        setReviewed(false);
        setReviewedAt(null);
      }
    },
    [candidateResult]
  );

  const tidySpaces = useCallback(() => {
    if (!candidate) return;
    let next = candidate;
    try {
      next = suggestFormatting(candidate);
    } catch {
      next = candidate;
    }
    if (next === candidate) {
      setLiveMsg('空格已规范，无需整理。');
      return;
    }
    setCandidate(next);
    setCandidateResult(null);
    setCheckedIds([]);
    setReviewed(false);
    setReviewedAt(null);
    setLiveMsg('已整理候选空格（仅去除首尾与合并连续空格，不删词、不改大小写），需检测修改后的标题。');
  }, [candidate]);

  const recheckCandidate = useCallback(() => {
    if (!result || !candidate || customStore.error) return;
    if (result.ruleVersion !== RULE_VERSION || result.customRuleVersion !== customStore.set.version) {setEngineError('规则已更新，请先重新检测原标题，再检测修改稿。');return;}
    setRechecking(true);
    try {
      const input = { ...(result.input || buildInput(form)), title: candidate };
      const nextResult = inspect(input, customStore.set);
      setCandidateResult(nextResult);
      setCheckedIds([]);
      setReviewed(false);
      setReviewedAt(null);
      setLiveMsg(
        nextResult.status === 'INVALID_INPUT'
          ? '候选输入无效，请修改后重试。'
          : `候选复检完成：待核验 ${nextResult.counts.review} 项，建议 ${nextResult.counts.suggestion} 条。`
      );
      persistRecord(makeRecord(result, candidate, nextResult, [], false, null));
    } catch (error) {
      setEngineError(`候选复检失败：${error && error.message ? error.message : String(error)}`);
    } finally {
      setRechecking(false);
    }
  }, [result, candidate, form, persistRecord, customStore]);

  const toggleChecked = useCallback((id, checked) => {
    setCheckedIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  }, []);

  const recordReview = useCallback(() => {
    if (!result) return;
    const eligible = !customStore.error && canRecordReview({ result, candidateResult, candidate, checkedIds, currentCustomVersion:customStore.set.version });
    if (!eligible) {
      setLiveMsg('尚不满足记录人工复核的条件。');
      return;
    }
    const now = new Date().toISOString();
    setReviewed(true);
    setReviewedAt(now);
    setLiveMsg('已记录人工复核（草稿记录，不等于正式采用或平台审核通过）。');
    persistRecord(makeRecord(result, candidate, candidateResult, checkedIds, true, now));
  }, [result, candidateResult, candidate, checkedIds, persistRecord, customStore]);

  const handleCopy = useCallback((ok) => {
    setCopyMsg(ok ? '候选文本已复制。' : '复制失败。');
    setLiveMsg(ok ? '候选文本已复制。' : '复制失败，请手动选择文本复制。');
  }, []);

  const openBatchRow = useCallback((row) => {
    if (!row || !row.result) return;
    const saved = recordsRef.current.find(r => r.result.id === row.result.id);
    setForm(formFromInput(row.result.input));
    setResult(row.result);
    setCandidate(saved?.candidate ?? row.result.title);
    setCandidateResult(saved?.candidateResult || null);
    setCheckedIds(saved?.checkedIds || []);
    setReviewed(Boolean(saved?.reviewed));
    setReviewedAt(saved?.reviewedAt || null);
    setFromRow(row.rowNumber);
    setTab('single');
    setView('workbench');
    setLiveMsg(`已打开批量第 ${row.rowNumber} 行的检测结果（未重新检测，未新建记录）。`);
  }, []);

  const openHistoryRecord = useCallback((record) => {
    if (!record || !record.result) return;
    const input = record.result.input || record.input;
    setForm(formFromInput(input));
    setResult(record.result);
    setCandidate(record.candidate !== undefined ? record.candidate : record.result.title);
    setCandidateResult(record.candidateResult || null);
    setCheckedIds(Array.isArray(record.checkedIds) ? record.checkedIds : []);
    setReviewed(Boolean(record.reviewed));
    setReviewedAt(record.reviewedAt || null);
    setFromRow(record.rowNumber ?? null);
    setTab('single');
    setView('workbench');
    setLiveMsg('已载入历史快照；浏览不会修改原记录。');
  }, []);

  const exportHistory = useCallback((list, label) => {
    if (!list || list.length === 0) return;
    try {
      exportResults(list, `tk标题检查-历史-${label}-${new Date().toISOString().slice(0, 10)}.csv`);
      setLiveMsg(`已导出 ${label}历史 ${list.length} 条（CSV）。`);
    } catch (error) {
      setStorageMsg(`历史导出失败：${error && error.message ? error.message : String(error)}`);
    }
  }, []);

  const currentInput = useMemo(() => buildInput(form), [form]);
  const stale = Boolean(result) && !sameInput(currentInput, result.input);

  const singleArea = (
    <div className="workbench-grid">
      <InputPanel
        form={form}
        onFormChange={handleFormChange}
        onCheck={runCheck}
        onSample={loadSample}
        onClear={clearForm}
        checking={checking}
        engineError={engineError}
        rulesBlocked={!!customStore.error}
      />
      <div>
        {!result ? (
          <section className="panel">
            <div className="empty">
              <p className="empty-lead">还没有检测结果</p>
              <p>
                粘贴商品标题开始检查，也可以“填入示例”体验完整流程。
              </p>
              <p>查看命中片段与官方依据，修改候选后再次核验。</p>
            </div>
          </section>
        ) : stale ? (
          <section className="panel">
            <div className="stale">
              <span className="stale-strong">输入已修改，请重新检测</span>
              上一次的检测结果与快照已过期并隐藏，避免新旧结论混用。
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button type="button" className="btn" onClick={runCheck} disabled={checking || cpLength(form.title) === 0}>
                  {checking ? '检测中…' : '立即重新检测'}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <>
            {fromRow !== null ? (
              <div className="notice" style={{ marginTop: 0, marginBottom: 16 }}>
                正在查看批量导入第 <span className="mono">{fromRow}</span> 行的既有结果（未重新检测、未新建记录）。修改输入后需重新检测。
              </div>
            ) : null}
            <ResultPanel
              result={result}
              candidate={candidate}
              candidateResult={candidateResult}
              checkedIds={checkedIds}
              reviewed={reviewed}
              reviewedAt={reviewedAt}
              onCandidateChange={handleCandidateChange}
              onTidySpaces={tidySpaces}
              onRecheck={recheckCandidate}
              onCopy={handleCopy}
              copyMsg={copyMsg}
              rechecking={rechecking}
              onToggleCheck={toggleChecked}
              onRecordReview={recordReview}
              currentCustomVersion={customStore.error ? null : customStore.set.version}
            />
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-title">TK 标题检查</span>
            <span className="version-tag">本地试用版</span>
          </div>
          <nav className="top-nav" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <span className="topbar-note">数据仅存本机浏览器</span>
        </div>
      </header>

      <main className="shell">
        <span className="live-region" aria-live="polite">
          {liveMsg}
        </span>

        <div hidden={view !== 'workbench'}>
            <div className="page-head">
              <h1 className="page-title">检测工作台</h1>
              <span className="version-tag">本地试用版 v0.2</span>
            </div>
            <p className="page-sub">
              检查 TikTok Shop 商品标题，核对问题与依据，再整理可供人工复核的候选。
            </p>
            {storageMsg ? <Msg kind="error">{storageMsg}</Msg> : null}
            {customStore.error ? <Msg kind="error">本机规则配置损坏，检测已暂停；请到规则与词库备份并恢复。</Msg> : null}
            <div className="tabs" role="tablist" aria-label="检测方式">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'single'}
                onClick={() => setTab('single')}
              >
                单条检测
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'batch'}
                onClick={() => setTab('batch')}
              >
                批量检测
              </button>
            </div>
            <div hidden={tab !== 'single'}>{singleArea}</div>
            <div hidden={tab !== 'batch'}>
              <BatchPanel baseForm={form} records={records} onPersist={persistMany} onOpenRow={openBatchRow} customStore={customStore} />
            </div>
        </div>

        {view === 'history' ? (
          <>
            <div className="page-head">
              <h1 className="page-title">检查历史</h1>
              <span className="version-tag">{records.length} 条记录</span>
            </div>
            <p className="page-sub">历史按检测时间倒序展示；“查看”会按当时快照恢复输入、候选与复核勾选状态。</p>
            <HistoryPanel records={records} storageMsg={storageMsg} onOpenRecord={openHistoryRecord} onExport={exportHistory} />
          </>
        ) : null}

        {view === 'rules' ? (
          <>
            <div className="page-head">
              <h1 className="page-title">规则与词库</h1>
              <span className="version-tag">内置规则定义只读，可启停</span>
            </div>
            <p className="page-sub">
              展示当前草稿规则包的 11 项检查与词库。来源链接指向官方页面，级别与阈值以规则元数据为准。
            </p>
            <RulesPanel customStore={customStore} onWrite={writeRules} onReload={reloadCustom} onReset={expected=>writeRules(expected,[],[])} />
          </>
        ) : null}
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>TK 标题检查 · 本地试用版 v0.2 · 检查与复核不等于发布</span>
          <span>本机浏览器保存 · AI 改写未接入 · 规则包 {RULE_VERSION}</span>
        </div>
      </footer>

      <nav className="bottom-nav" aria-label="移动端主导航">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </>
  );
}



