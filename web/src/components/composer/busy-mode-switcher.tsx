import { useState } from "react";
import { Check, Zap } from "lucide-react";
import { Popover } from "@hermes/shared-ui";
import {
  BUSY_INPUT_MODES,
  BUSY_INPUT_MODE_LABELS,
  type BusyInputMode,
} from "@/lib/busy-input-mode";
import s from "./busy-mode-switcher.module.css";

export interface BusyModeSwitcherProps {
  value: BusyInputMode;
  onSelect: (mode: BusyInputMode) => void | Promise<void>;
  disabled?: boolean;
}

// 每种模式的一句话说明，挂在菜单项副标题里，帮用户理解"运行中发送"会发生什么。
const MODE_DESCRIPTIONS: Record<BusyInputMode, string> = {
  steer: "不打断当前回合，注入到下一步让模型采纳。",
  interrupt: "停掉当前回合，用这条消息开新回合。",
  queue: "先排队，当前回合结束后自动发送。",
};

/**
 * 工具栏里的「运行时输入行为」入口：决定 agent 正忙时，用户发送的消息怎么处理
 * （引导 / 打断 / 排队）。选择后通过网关 config.set（key="busy"）落到
 * config.yaml 的 display.busy_input_mode，与思考强度入口同一套交互。
 */
export function BusyModeSwitcher({ value, onSelect, disabled }: BusyModeSwitcherProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (mode: BusyInputMode) => {
    setOpen(false);
    if (mode !== value) void onSelect(mode);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={s.trigger}
          disabled={disabled}
          data-active={open ? "true" : undefined}
          data-state={open ? "open" : undefined}
          title={`运行时输入行为：${BUSY_INPUT_MODE_LABELS[value]}`}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Zap className={s.triggerIcon} aria-hidden="true" />
          <span>运行中</span>
          <small>{BUSY_INPUT_MODE_LABELS[value]}</small>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.menu} side="top" align="start">
          <div className={s.menuTitle}>运行时输入行为</div>
          <div className={s.menuList} role="menu" aria-label="运行时输入行为">
            {BUSY_INPUT_MODES.map((mode) => {
              const isActive = mode === value;
              return (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={s.menuItem}
                  data-active={isActive ? "true" : undefined}
                  onClick={() => handleSelect(mode)}
                >
                  <span className={s.menuItemBody}>
                    <span className={s.menuItemLabel}>{BUSY_INPUT_MODE_LABELS[mode]}</span>
                    <span className={s.menuItemDesc}>{MODE_DESCRIPTIONS[mode]}</span>
                  </span>
                  {isActive && <Check className={s.menuCheck} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
