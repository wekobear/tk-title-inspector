import React from "react";
export default function RuleSwitch({
  enabled,
  label,
  disabled,
  onClick,
  describedBy,
}) {
  return (
    <button
      type="button"
      className="rule-switch"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="rule-switch-track">
        <span className="rule-switch-thumb" />
      </span>
    </button>
  );
}
