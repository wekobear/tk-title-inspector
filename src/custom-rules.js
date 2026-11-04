export const CUSTOM_KEY = "tk-title-inspector.custom-rules.v1";
export const BUILTIN_TOGGLE_IDS = [
  "T01",
  "T02",
  "T03",
  "T04",
  "T05",
  "T06",
  "T07",
  "T08",
  "T10",
  "T11",
];
export const EMPTY_SET = Object.freeze({
  schemaVersion: 1,
  version: "empty-v1",
  rules: [],
});
const len = (s) => Array.from(s).length;
const types = ["contains", "missing", "less", "more"];
const scopes = {
  market: ["any", "US"],
  language: ["any", "en"],
  category: ["any", "fitness", "other"],
};
export function validateRule(rule) {
  const errors = {};
  if (!rule || typeof rule !== "object")
    return { errors: { rule: "规则无效" } };
  const name = typeof rule.name === "string" ? rule.name.trim() : "";
  const message = typeof rule.message === "string" ? rule.message.trim() : "";
  if (!name || len(name) > 60) errors.name = "请输入 1–60 个字符的规则名称。";
  if (!message || len(message) > 500)
    errors.message = "请输入 1–500 个字符的修改提示。";
  if (!types.includes(rule.type)) errors.type = "请选择条件类型。";
  if (!["REVIEW", "SUGGESTION"].includes(rule.severity))
    errors.severity = "请选择严重程度。";
  for (const [key, values] of Object.entries(scopes))
    if (!values.includes(rule[key])) errors[key] = "请选择有效范围。";
  let value;
  if (["contains", "missing"].includes(rule.type)) {
    const lines = Array.isArray(rule.value)
      ? rule.value
      : typeof rule.value === "string"
        ? rule.value.split("\n")
        : [];
    const terms = lines
      .map((x) => (typeof x === "string" ? x.trim().normalize("NFC") : ""))
      .filter(Boolean);
    if (!terms.length || terms.length > 20 || terms.some((x) => len(x) > 100))
      errors.value = "请输入 1–20 个词句，每项最多 100 个字符。";
    if (new Set(terms.map((x) => x.toLowerCase())).size !== terms.length)
      errors.value = "词句重复，请删除重复项。";
    value = terms;
  } else {
    const raw = String(rule.value ?? "").trim();
    if (!/^\d+$/.test(raw) || Number(raw) > 5000)
      errors.value = "请输入 0–5000 的整数。";
    value = Number(raw);
  }
  return { errors, rule: { ...rule, name, message, value } };
}
export function validateSet(set) {
  if (
    !set ||
    set.schemaVersion !== 1 ||
    typeof set.version !== "string" ||
    !set.version ||
    !Array.isArray(set.rules) ||
    set.rules.length > 100 ||
    (set.builtinDisabled !== undefined &&
      (!Array.isArray(set.builtinDisabled) ||
        set.builtinDisabled.some((id) => !BUILTIN_TOGGLE_IDS.includes(id)) ||
        new Set(set.builtinDisabled).size !== set.builtinDisabled.length))
  )
    return false;
  const ids = new Set();
  return set.rules.every((r) => {
    const v = validateRule(r);
    if (
      Object.keys(v.errors).length ||
      typeof r.id !== "string" ||
      !/^C-/.test(r.id) ||
      ids.has(r.id) ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      typeof r.enabled !== "boolean"
    )
      return false;
    ids.add(r.id);
    return (
      JSON.stringify(v.rule.value) === JSON.stringify(r.value) &&
      v.rule.name === r.name &&
      v.rule.message === r.message
    );
  });
}
export function readCustom() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw === null) return { raw, set: structuredClone(EMPTY_SET) };
    const set = JSON.parse(raw);
    if (!validateSet(set)) throw Error("规则数据格式无效");
    return { raw, set };
  } catch (e) {
    let raw = null;
    try {
      raw = localStorage.getItem(CUSTOM_KEY);
    } catch {}
    return { raw, error: `规则读取失败：${e.message}` };
  }
}
export async function writeCustom(expected, rules, builtinDisabled) {
  const write = () => {
    try {
      if (localStorage.getItem(CUSTOM_KEY) !== expected)
        return {
          error: "规则已在其他标签页更改，请重新载入后再保存。",
          conflict: true,
        };
      let disabled = builtinDisabled;
      if (disabled === undefined) {
        const oldSet = expected === null ? EMPTY_SET : JSON.parse(expected);
        if (!validateSet(oldSet)) throw Error("原规则配置无效");
        disabled = oldSet.builtinDisabled ?? [];
      }
      const set = {
        schemaVersion: 1,
        builtinDisabled: disabled,
        version: `V-${crypto.randomUUID()}`,
        rules,
      };
      if (!validateSet(set)) return { error: "规则数据无效，未保存。" };
      const raw = JSON.stringify(set);
      localStorage.setItem(CUSTOM_KEY, raw);
      return { set, raw };
    } catch (e) {
      return { error: `规则未保存：${e.message}` };
    }
  };
  return globalThis.navigator?.locks
    ? navigator.locks.request(CUSTOM_KEY, write)
    : write();
}
export function evaluateRule(rule, input) {
  if (!input.title.trim() || len(input.title) > 5000)
    return { state: "SKIPPED", reason: "输入无效" };
  for (const key of Object.keys(scopes))
    if (rule[key] !== "any" && rule[key] !== input[key])
      return {
        state: "SKIPPED",
        reason: `${key === "market" ? "市场" : key === "language" ? "语言" : "类目"}范围不符或未指定`,
      };
  const length = len(input.title);
  if (rule.type === "less" || rule.type === "more")
    return {
      state: "EXECUTED",
      hit: rule.type === "less" ? length < rule.value : length > rule.value,
      spans: [],
    };
  let text = "",
    map = [],
    offset = 0;
  for (const { segment } of new Intl.Segmenter("en", {
    granularity: "grapheme",
  }).segment(input.title)) {
    const part = segment.normalize("NFC").toLowerCase(),
      end = offset + len(segment);
    for (let i = 0; i < part.length; i++) map.push([offset, end]);
    text += part;
    offset = end;
  }
  const spans = [];
  for (const word of rule.value) {
    const term = word.toLowerCase();
    let index = 0;
    while ((index = text.indexOf(term, index)) !== -1) {
      spans.push([map[index][0], map[index + term.length - 1][1]]);
      index += Math.max(1, term.length);
    }
  }
  return {
    state: "EXECUTED",
    hit: rule.type === "contains" ? spans.length > 0 : spans.length === 0,
    spans: rule.type === "contains" ? spans : [],
  };
}
