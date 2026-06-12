import { useState, useCallback } from "react";
import { Popover } from "@hermes/shared-ui";
import { Brain } from "lucide-react";
import s from "./reasoning-effort-selector.module.css";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORTS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "关闭思考",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

export interface ReasoningEffortSelectorProps {
  value: ReasoningEffort | null;
  onChange: (value: ReasoningEffort) => void;
  disabled?: boolean;
}

export function ReasoningEffortSelector({
  value,
  onChange,
  disabled,
}: ReasoningEffortSelectorProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback((effort: ReasoningEffort) => {
    onChange(effort);
    setOpen(false);
  }, [onChange]);

  const currentLabel = value ? REASONING_EFFORT_LABELS[value] : "未设置";
  const isThinkingEnabled = value && value !== "none";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <button
          type="button"
          className={s.trigger}
          disabled={disabled}
          title={value ? `思考强度: ${currentLabel}` : "设置思考强度"}
          aria-label={value ? `当前思考强度: ${currentLabel}` : "设置思考强度"}
          data-active={isThinkingEnabled ? "true" : undefined}
        >
          <Brain size={12} aria-hidden="true" />
          <span>{isThinkingEnabled ? currentLabel : "思考"}</span>
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content className={s.panel} sideOffset={4} align="end">
          <div className={s.header}>
            <Brain size={14} aria-hidden="true" />
            <span>思考强度</span>
          </div>
          <div className={s.list}>
            {REASONING_EFFORTS.map((effort) => (
              <button
                key={effort}
                type="button"
                className={s.option}
                data-selected={effort === value ? "true" : undefined}
                onClick={() => handleSelect(effort)}
              >
                <span className={s.optionLabel}>{REASONING_EFFORT_LABELS[effort]}</span>
                {effort === value && <span className={s.check}>✓</span>}
              </button>
            ))}
          </div>
          <div className={s.footer}>
            {value && value !== "none"
              ? "模型将展示推理过程"
              : "关闭思考以节省 Token"}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
