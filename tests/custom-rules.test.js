import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SET,
  validateRule,
  validateSet,
  evaluateRule,
  readCustom,
  writeCustom,
  CUSTOM_KEY,
} from "../src/custom-rules.js";
import {
  inspect,
  SAMPLE_INPUT,
  canRecordReview,
  reviewRequirements,
} from "../src/engine.js";
import { resultsCSV } from "../src/files.js";
const base = {
  id: "C-one",
  revision: 1,
  enabled: true,
  name: "测试",
  message: "请修改",
  severity: "REVIEW",
  type: "contains",
  value: ["bike"],
  market: "any",
  language: "any",
  category: "any",
};
const set = (rules = [base], version = "V-one") => ({
  schemaVersion: 1,
  version,
  rules,
});
test("literal matching, Unicode normalization, case expansion and original code point spans", () => {
  for (const [word, title, fragment] of [
    ["bike", "🚲 E-BIKES", "BIKE"],
    ["café", "🚲 Cafe\u0301", "Cafe\u0301"],
    ["i\u0307", "🚲 İ", "İ"],
    ["[x]", "🚲 [X]", "[X]"],
  ]) {
    const rule = { ...base, value: [word] };
    const out = evaluateRule(rule, {
      title,
      market: "US",
      language: "en",
      category: "fitness",
    });
    assert(out.hit);
    assert.equal(
      Array.from(title)
        .slice(...out.spans[0])
        .join(""),
      fragment,
    );
  }
  assert(
    !evaluateRule(base, {
      title: "bicycle",
      market: "US",
      language: "en",
      category: "fitness",
    }).hit,
  );
});
test("scope, disabled, invalid title, missing and strict code-point length", () => {
  assert.equal(
    evaluateRule(
      { ...base, category: "other" },
      { title: "bike", category: "unknown" },
    ).state,
    "SKIPPED",
  );
  assert.equal(
    evaluateRule(
      { ...base, type: "missing", value: ["bike"] },
      { title: "🚲 Bike" },
    ).hit,
    false,
  );
  for (const type of ["less", "more"])
    for (const n of [1, 2, 3])
      assert.equal(
        evaluateRule({ ...base, type, value: 2 }, { title: "😀".repeat(n) })
          .hit,
        type === "less" ? n < 2 : n > 2,
      );
  const result = inspect(
    { ...SAMPLE_INPUT, title: "" },
    set([{ ...base, enabled: false }]),
  );
  assert.equal(result.coverage.at(-1).reason, "输入无效");
  assert.equal(
    inspect(SAMPLE_INPUT, set([{ ...base, enabled: false }])).coverage.at(-1)
      .state,
    "DISABLED",
  );
});
test("validation rejects duplicates, invalid scopes and boundaries", () => {
  assert(validateRule({ ...base, value: " bike \nBIKE" }).errors.value);
  assert(validateRule({ ...base, type: "less", value: "1.5" }).errors.value);
  assert(validateRule({ ...base, category: "beauty" }).errors.category);
  assert(validateRule({ ...base, value: "a".repeat(101) }).errors.value);
  assert(
    validateSet(
      set(Array.from({ length: 100 }, (_, i) => ({ ...base, id: `C-${i}` }))),
    ),
  );
  assert(
    !validateSet(
      set(Array.from({ length: 101 }, (_, i) => ({ ...base, id: `C-${i}` }))),
    ),
  );
});
test("storage detects corruption, conflict and quota without overwriting", async () => {
  let raw = "{broken";
  globalThis.localStorage = {
    getItem: (k) => raw,
    setItem: (k, v) => {
      raw = v;
    },
  };
  assert(readCustom().error);
  assert.equal(raw, "{broken");
  assert((await writeCustom("old", [])).conflict);
  assert.equal(raw, "{broken");
  const recovered = await writeCustom(raw, [], []);
  assert(validateSet(recovered.set));
  assert.notEqual(recovered.set.version, EMPTY_SET.version);
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      throw Error("quota");
    },
  };
  assert.match((await writeCustom(null, [])).error, /quota/);
  assert.equal(CUSTOM_KEY, "tk-title-inspector.custom-rules.v1");
});
test("snapshots survive rule change, review requires current versions and CSV keeps safe appended fields", () => {
  const input = {
    ...SAMPLE_INPUT,
    title: "MERACH Indoor Cycling Bike with LCD Display",
    factsComplete: true,
  };
  const r = inspect(input, set());
  const fixed = inspect(
    { ...input, title: "MERACH Indoor Cycling Cycle with LCD Display" },
    set(),
  );
  const checkedIds = reviewRequirements(input).map((x) => x.id);
  assert(r.issues.some((i) => i.ruleId === "C-one"));
  assert.equal(r.issues.find((i) => i.ruleId === "C-one").message, "请修改");
  assert(
    !canRecordReview({
      result: r,
      candidateResult: fixed,
      candidate: fixed.title,
      checkedIds,
      currentCustomVersion: "V-two",
    }),
  );
  assert(
    !canRecordReview({
      result: r,
      candidateResult: fixed,
      candidate: fixed.title,
      checkedIds,
      currentCustomVersion: "V-one",
    }),
  ); // built-in type mismatch remains REVIEW
  const csv = resultsCSV([{ result: r, candidateResult: fixed }]);
  assert.match(csv, /自定义规则集版本/);
  assert.match(csv, /自定义/);
  assert.match(csv, /V-one/);
});

test("review gate independently checks versions and custom severities", () => {
  const input = {
    ...SAMPLE_INPUT,
    title: "MERACH Indoor Cycling Bike with LCD Display",
    factsComplete: true,
  };
  const checkedIds = reviewRequirements(input).map((x) => x.id);
  const noHit = { ...base, value: ["not-present"] };
  const original = inspect(input, set([noHit]));
  const candidate = inspect(input, set([noHit]));
  const args = {
    result: original,
    candidateResult: candidate,
    candidate: input.title,
    checkedIds,
    currentCustomVersion: "V-one",
  };
  assert(canRecordReview(args));
  assert(!canRecordReview({ ...args, currentCustomVersion: "V-two" }));
  assert(
    !canRecordReview({
      ...args,
      candidateResult: { ...candidate, customRuleVersion: "V-two" },
    }),
  );
  assert(
    !canRecordReview({
      ...args,
      result: { ...original, customRuleVersion: "V-two" },
    }),
  );
  const { customRuleVersion, ...old } = original;
  assert(!canRecordReview({ ...args, result: old }));
  const review = inspect(input, set([base]));
  assert(!canRecordReview({ ...args, candidateResult: review }));
  const suggestion = inspect(input, set([{ ...base, severity: "SUGGESTION" }]));
  assert(canRecordReview({ ...args, candidateResult: suggestion }));
});

test("maximum definitions and 500 history snapshots round trip; quota failure preserves old value", async () => {
  const rules = Array.from({ length: 100 }, (_, i) => ({
    ...base,
    id: `C-${i}`,
    name: "名".repeat(60),
    message: "提".repeat(500),
    value: Array.from({ length: 20 }, (_, n) => `${n}`.padEnd(100, "词")),
  }));
  assert(validateSet(set(rules)));
  const { loadHistory, saveHistory } = await import("../src/storage.js");
  let raw = null;
  globalThis.localStorage = {
    getItem: () => raw,
    setItem: (_, v) => {
      raw = v;
    },
  };
  const result = inspect({ ...SAMPLE_INPUT, title: "Bike" }, set());
  assert(result.issues.some((i) => i.sourceType === "CUSTOM"));
  assert(result.coverage.some((i) => i.sourceType === "CUSTOM"));
  const records = Array.from({ length: 500 }, (_, i) => ({
    result: { ...result, id: `result-${i}` },
  }));
  assert(saveHistory(records).ok);
  assert.equal(loadHistory().records.length, 500);
  const saved = raw;
  globalThis.localStorage.setItem = () => {
    throw Error("quota");
  };
  assert(!saveHistory(records).ok);
  assert.equal(raw, saved);
  const legacy = structuredClone(records[0]);
  delete legacy.result.customRuleVersion;
  globalThis.localStorage = {
    getItem: () => JSON.stringify([legacy]),
    setItem: () => {},
  };
  assert.equal(loadHistory().records.length, 1);
});

test("CSV preserves original fourteen columns and protects custom names from formulas", () => {
  const r = inspect(
    { ...SAMPLE_INPUT, title: "MERACH Indoor Cycling Bike with LCD Display" },
    set([{ ...base, name: '=HYPERLINK("x")' }]),
  );
  const csv = resultsCSV([{ result: r }]);
  const header = csv.replace(/^\uFEFF/, "").split(/\r?\n/)[0];
  assert.deepEqual(
    header
      .split(",")
      .slice(0, 14)
      .map((x) => x.replace(/^"|"$/g, "")),
    [
      "源行号",
      "检查时间",
      "市场",
      "语言",
      "原标题",
      "字符数",
      "原文结果",
      "问题明细",
      "资料及覆盖限制",
      "候选标题",
      "候选结果",
      "人工复核",
      "复核时间",
      "规则版本",
    ],
  );
  assert.match(csv, /'=HYPERLINK/);
});

test("invalid custom history fields are rejected without overwriting raw data", async () => {
  const { loadHistory, saveHistory } = await import("../src/storage.js");
  for (const damage of [
    (r) => {
      r.customRuleVersion = {};
    },
    (r) => {
      r.customRuleVersion = "";
    },
    (r) => {
      r.issues.find((i) => i.sourceType === "CUSTOM").revision = 0;
    },
    (r) => {
      r.coverage.at(-1).revision = 1.5;
    },
  ]) {
    const result = inspect({ ...SAMPLE_INPUT, title: "Bike" }, set());
    damage(result);
    const raw = JSON.stringify([{ result }]);
    let value = raw;
    globalThis.localStorage = {
      getItem: () => value,
      setItem: (_, v) => {
        value = v;
      },
    };
    assert(loadHistory().error);
    assert(!saveHistory([{ result: inspect(SAMPLE_INPUT) }]).ok);
    assert.equal(value, raw);
  }
});

test("builtin settings accept legacy data, preserve preferences and reject invalid IDs", async () => {
  let raw = JSON.stringify(set());
  globalThis.localStorage = {
    getItem: () => raw,
    setItem: (_, value) => {
      raw = value;
    },
  };
  assert(readCustom().set);
  const changed = await writeCustom(raw, [base], ["T01", "T11"]);
  assert.deepEqual(changed.set.builtinDisabled, ["T01", "T11"]);
  const next = await writeCustom(raw, [{ ...base, name: "新名称" }]);
  assert.deepEqual(next.set.builtinDisabled, ["T01", "T11"]);
  const toggled = await writeCustom(raw, [{ ...base, enabled: false }]);
  assert.deepEqual(toggled.set.builtinDisabled, ["T01", "T11"]);
  const removed = await writeCustom(raw, []);
  assert.deepEqual(removed.set.builtinDisabled, ["T01", "T11"]);
  for (const invalid of [["T09"], ["T01", "T01"], ["T99"], "T01"])
    assert(!validateSet({ ...set(), builtinDisabled: invalid }));
  const broken = "{broken";
  raw = broken;
  assert((await writeCustom(raw, [])).error);
  const reset = await writeCustom(raw, [], []);
  assert.deepEqual(reset.set.builtinDisabled, []);
});

test("disabled builtins skip matching but not fact review, and configuration version gates review", () => {
  const input = {
    ...SAMPLE_INPUT,
    title: "MERACH Indoor Cycling Bike with LCD Display",
    factsComplete: true,
  };
  const oldSet = { ...set([]), builtinDisabled: [] };
  const nextSet = {
    ...set([], "V-two"),
    builtinDisabled: ["T01", "T03", "T11"],
  };
  const r = inspect({ ...input, title: "MERACH Bike BEST SELLER" }, nextSet);
  assert(!r.issues.some((i) => i.ruleId === "T03"));
  assert.equal(r.coverage.find((c) => c.ruleId === "T03").state, "DISABLED");
  assert.match(r.coverage.find((c) => c.ruleId === "T03").reason, /用户已停用/);
  assert.equal(r.coverage.find((c) => c.ruleId === "T11").state, "DISABLED");
  assert.equal(r.coverage.find((c) => c.ruleId === "T09").state, "DISABLED");
  const original = inspect(input, oldSet),
    candidate = inspect(input, oldSet);
  const checkedIds = reviewRequirements(input).map((x) => x.id);
  assert(
    canRecordReview({
      result: original,
      candidateResult: candidate,
      candidate: input.title,
      checkedIds,
      currentCustomVersion: "V-one",
    }),
  );
  assert(
    !canRecordReview({
      result: original,
      candidateResult: candidate,
      candidate: input.title,
      checkedIds,
      currentCustomVersion: "V-two",
    }),
  );
  const incomplete = { ...input, factsComplete: false };
  assert(
    !canRecordReview({
      result: inspect(incomplete, nextSet),
      candidateResult: inspect(incomplete, nextSet),
      candidate: input.title,
      checkedIds,
      currentCustomVersion: "V-two",
    }),
  );
});
