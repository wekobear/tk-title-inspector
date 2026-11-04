import RuleSwitch from "./RuleSwitch.jsx";
import React, { useEffect, useRef, useState } from "react";
import { validateRule, evaluateRule } from "./custom-rules.js";
const blank = () => ({
  name: "",
  type: "contains",
  value: "",
  message: "",
  severity: "SUGGESTION",
  market: "any",
  language: "any",
  category: "any",
  enabled: true,
});
const sample = {
  ...blank(),
  name: "检查 Bike 词句",
  value: "bike",
  message: "请核对标题中是否需要保留该词句。",
};
const types = {
  contains: "包含任一词句时提示",
  missing: "所有词句都未出现时提示",
  less: "字符数少于",
  more: "字符数多于",
};
export default function CustomRules({ store, onWrite, onReload, onReset }) {
  const nameRef = useRef(null);
  const [draft, setDraft] = useState(null),
    [baseline, setBaseline] = useState(null),
    [errors, setErrors] = useState({}),
    [test, setTest] = useState({
      title: "",
      market: "US",
      language: "en",
      category: "fitness",
    }),
    [outcome, setOutcome] = useState(null),
    [message, setMessage] = useState(""),
    [backup, setBackup] = useState(null),
    [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (draft && nameRef.current) {
      nameRef.current.focus({ preventScroll: true });
      nameRef.current.scrollIntoView({ block: "center" });
    }
  }, [draft?.id, !!draft]);
  const change = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setOutcome(null);
  };

  const start = (rule) => {
    setDraft(
      rule
        ? {
            ...rule,
            value: Array.isArray(rule.value)
              ? rule.value.join("\n")
              : String(rule.value),
          }
        : blank(),
    );
    setBaseline(store.raw);
    setErrors({});
    setOutcome(null);
    setMessage("");
  };

  const save = async () => {
    const v = validateRule(draft);
    setErrors(v.errors);
    if (Object.keys(v.errors).length) return;
    if (!draft.id && store.set.rules.length >= 100) {
      setMessage("最多保存 100 条规则。");
      return;
    }
    const current = draft.id
      ? store.set.rules.find((r) => r.id === draft.id)
      : null;
    if (draft.id && !current) {
      setMessage("此规则已在其他标签页删除。草稿仍保留，请另存为新规则。");
      return;
    }
    const rule = {
      ...v.rule,
      id: draft.id || `C-${crypto.randomUUID()}`,
      revision: current ? current.revision + 1 : 1,
      enabled: current ? current.enabled : draft.enabled,
    };
    const rules = draft.id
      ? store.set.rules.map((r) => (r.id === draft.id ? rule : r))
      : [...store.set.rules, rule];
    const result = await onWrite(baseline, rules);
    if (result.error) setMessage(result.error);
    else {
      setDraft(null);
      setMessage(
        rule.enabled ? "规则已保存并生效。" : "规则已保存，当前已停用。",
      );
    }
  };

  const mutate = async (rule, remove = false) => {
    if (switching) return;
    if (!remove && draft?.id === rule.id && baseline !== store.raw) {
      setMessage("规则已在其他标签页更改，请重新载入后再保存。");
      return;
    }
    if (remove && !window.confirm(`确认删除“${rule.name}”？历史记录不会删除。`))
      return;
    const rules = remove
      ? store.set.rules.filter((r) => r.id !== rule.id)
      : store.set.rules.map((r) =>
          r.id === rule.id
            ? { ...r, enabled: !r.enabled, revision: r.revision + 1 }
            : r,
        );
    setSwitching(true);
    const result = await onWrite(store.raw, rules);
    setSwitching(false);
    if (!result.error && !remove && draft?.id === rule.id) {
      setDraft((d) =>
        d?.id === rule.id ? { ...d, enabled: !rule.enabled } : d,
      );
      setBaseline(result.raw);
    }
    setMessage(result.error || "规则已更新。");
  };

  const trial = () => {
    const v = validateRule(draft);
    setErrors(v.errors);
    if (Object.keys(v.errors).length) return;
    if (!test.title.trim()) {
      setMessage("请填写试测标题。");
      return;
    }
    const r = evaluateRule(v.rule, test);
    setOutcome(
      r.state === "SKIPPED"
        ? `范围不符或输入无效：${r.reason}`
        : r.hit
          ? "命中"
          : "未命中",
    );
    setMessage("");
  };

  const field = (key, label, control) => (
    <div className="field">
      <label className="field-label" htmlFor={`custom-${key}`}>
        {label}
      </label>
      {control}
      {errors[key] && (
        <p className="custom-error" role="alert">
          {errors[key]}
        </p>
      )}
    </div>
  );
  const select = (key, options) => (
    <select
      className="select"
      id={`custom-${key}`}
      value={draft[key]}
      onChange={(e) => change(key, e.target.value)}
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  return (
    <section className="panel custom-panel">
      <h2 className="panel-title">自定义规则（非平台政策）</h2>
      <p className="panel-hint">
        保存在本机浏览器；待核验命中会阻止记录复核，建议不会。规则变更后需重新检测。
      </p>
      {store.error ? (
        <>
          <p className="msg msg-error" role="alert">
            {store.error}。检测与编辑已暂停，原数据仍保留。
          </p>
          <div className="btn-row">
            <button
              className="btn btn-secondary"
              onClick={() => {
                try {
                  const blob = new Blob([store.raw ?? ""], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "损坏的自定义规则备份.json";
                  a.click();
                  URL.revokeObjectURL(url);
                  setBackup({ raw: store.raw });
                  setMessage("备份下载已触发，请确认文件已保存。");
                } catch {
                  setBackup(null);
                  setMessage("备份失败，不能重置。");
                }
              }}
            >
              下载损坏数据备份
            </button>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                if (!backup || backup.raw !== store.raw) {
                  setMessage(
                    "规则原始数据已变化或尚未备份，请先重新下载备份。",
                  );
                  return;
                }
                if (
                  window.confirm(
                    "请确认备份文件已保存。确认重置本机所有规则配置？自定义规则将清空，内置规则恢复默认；历史记录不受影响。",
                  )
                ) {
                  const r = await onReset(store.raw);
                  setMessage(r.error || "已重置为空。");
                }
              }}
            >
              确认重置为空
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            className="btn"
            disabled={switching}
            onClick={() => start(null)}
          >
            添加自定义规则
          </button>
          {store.set.rules.length === 0 ? (
            <p>暂无自定义规则。可填入示例后检查并保存。</p>
          ) : (
            <div className="rule-list custom-list">
              {store.set.rules.map((r) => (
                <article className="row-card custom-rule-card" key={r.id}>
                  <div className="custom-rule-content">
                    <strong>{r.name}</strong>
                    <span>
                      {types[r.type]}：
                      {Array.isArray(r.value) ? r.value.join("、") : r.value}
                    </span>
                    <span>
                      范围：{{ any: "任意", US: "美国" }[r.market]} /{" "}
                      {{ any: "任意", en: "英语" }[r.language]} /{" "}
                      {
                        { any: "任意", fitness: "健身器材", other: "其他" }[
                          r.category
                        ]
                      }{" "}
                      · {r.enabled ? "启用" : "停用"} ·{" "}
                      {r.severity === "REVIEW" ? "待核验" : "建议"} · 修订{" "}
                      {r.revision}
                    </span>
                    <p>{r.message}</p>
                    <div className="btn-row">
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={switching}
                        onClick={() => start(r)}
                      >
                        编辑
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={switching}
                        onClick={() => mutate(r, true)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <RuleSwitch
                    enabled={r.enabled}
                    label={`启用规则 ${r.name}`}
                    disabled={switching}
                    onClick={() => mutate(r)}
                  />
                </article>
              ))}
            </div>
          )}
          <button
            className="btn btn-secondary"
            disabled={switching}
            onClick={() => {
              start(null);
              setDraft(sample);
            }}
          >
            填入示例
          </button>
        </>
      )}
      {message && (
        <p className="msg" role="status">
          {message}{" "}
          {message.includes("另存为新规则") && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setDraft((d) => ({
                  ...d,
                  id: undefined,
                  revision: undefined,
                  enabled: d.enabled,
                }));
                setBaseline(store.raw);
                setMessage("已保留草稿，可作为新规则保存。");
              }}
            >
              另存为新规则
            </button>
          )}{" "}
          {message.includes("重新载入") && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                onReload();
                setMessage("已重新载入；草稿仍保留，请检查后重新保存。");
                setBaseline(null);
              }}
            >
              重新载入
            </button>
          )}
        </p>
      )}
      {draft && !store.error && (
        <div className="custom-form">
          <div className="custom-form-heading">
            <h3>{draft.id ? "编辑规则" : "添加自定义规则"}</h3>
            <RuleSwitch
              enabled={
                draft.id
                  ? (store.set.rules.find((rule) => rule.id === draft.id)
                      ?.enabled ?? draft.enabled)
                  : draft.enabled
              }
              label="启用当前规则"
              disabled={switching}
              onClick={() => {
                if (!draft.id) {
                  change("enabled", !draft.enabled);
                  return;
                }
                const current = store.set.rules.find(
                  (rule) => rule.id === draft.id,
                );
                if (!current) {
                  setMessage(
                    "此规则已在其他标签页删除。草稿仍保留，请另存为新规则。",
                  );
                  return;
                }
                mutate(current);
              }}
            />
          </div>
          {!draft.id && <p className="inline-note">开关状态保存后生效。</p>}
          {baseline !== store.raw && (
            <p className="msg msg-error">
              规则配置已变化，草稿已保留；保存时需重新载入并检查。
            </p>
          )}
          {baseline === null && store.raw !== null && (
            <button
              className="btn btn-secondary"
              onClick={() => setBaseline(store.raw)}
            >
              保留草稿并重新尝试
            </button>
          )}
          {field(
            "name",
            "规则名称",
            <input
              ref={nameRef}
              className="input"
              id="custom-name"
              value={draft.name}
              onChange={(e) => change("name", e.target.value)}
            />,
          )}
          {field("type", "条件类型", select("type", Object.entries(types)))}
          {field(
            "value",
            ["contains", "missing"].includes(draft.type)
              ? "词句，每行一个"
              : "字符数",
            ["contains", "missing"].includes(draft.type) ? (
              <textarea
                className="textarea"
                id="custom-value"
                value={draft.value}
                onChange={(e) => change("value", e.target.value)}
              />
            ) : (
              <input
                className="input"
                id="custom-value"
                inputMode="numeric"
                value={draft.value}
                onChange={(e) => change("value", e.target.value)}
              />
            ),
          )}
          <p className="inline-note">
            词句按字面、忽略大小写匹配；bike 会匹配 bikes 和
            e-bike。缺少词句条件下，出现任意一个就不提示。字符数按 Unicode
            码点计算，含空格；这是个人检查条件，不是平台发布限制。
          </p>
          {field(
            "message",
            "命中后的修改提示",
            <textarea
              className="textarea"
              id="custom-message"
              value={draft.message}
              onChange={(e) => change("message", e.target.value)}
            />,
          )}
          {field(
            "severity",
            "严重程度",
            select("severity", [
              ["SUGGESTION", "建议"],
              ["REVIEW", "待核验"],
            ]),
          )}
          {field(
            "market",
            "市场",
            select("market", [
              ["any", "任意"],
              ["US", "美国（US）"],
            ]),
          )}
          {field(
            "language",
            "语言",
            select("language", [
              ["any", "任意"],
              ["en", "英语（en）"],
            ]),
          )}
          {field(
            "category",
            "类目",
            select("category", [
              ["any", "任意"],
              ["fitness", "健身器材"],
              ["other", "其他"],
            ]),
          )}
          <h3>试测当前草稿，不保存</h3>
          <div className="field">
            <label className="field-label" htmlFor="trial-title">
              测试标题
            </label>
            <textarea
              id="trial-title"
              className="textarea"
              value={test.title}
              onChange={(e) => {
                setTest({ ...test, title: e.target.value });
                setOutcome(null);
              }}
            />
          </div>
          {[
            [
              "market",
              [
                ["US", "美国（US）"],
                ["unknown", "未指定"],
              ],
            ],
            [
              "language",
              [
                ["en", "英语（en）"],
                ["unknown", "未指定"],
              ],
            ],
            [
              "category",
              [
                ["fitness", "健身器材"],
                ["other", "其他"],
                ["unknown", "未指定"],
              ],
            ],
          ].map(([key, opts]) => (
            <div className="field" key={key}>
              <label className="field-label" htmlFor={`trial-${key}`}>
                测试
                {key === "market"
                  ? "市场"
                  : key === "language"
                    ? "语言"
                    : "类目"}
              </label>
              <select
                className="select"
                id={`trial-${key}`}
                value={test[key]}
                onChange={(e) => {
                  setTest({ ...test, [key]: e.target.value });
                  setOutcome(null);
                }}
              >
                {opts.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="btn-row">
            <button className="btn" onClick={save} disabled={switching}>
              保存规则
            </button>
            <button className="btn btn-secondary" onClick={trial}>
              试测
            </button>
            <button
              className="btn btn-secondary"
              disabled={switching}
              onClick={() => setDraft(null)}
            >
              取消
            </button>
          </div>
          {outcome && <p role="status">试测结果：{outcome}</p>}
        </div>
      )}
    </section>
  );
}
