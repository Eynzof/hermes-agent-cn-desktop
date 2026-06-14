// 运行时输入行为（busy_input_mode）——与后端 Hermes-CN-Core 的 CLI 对齐。
//
// 当 agent 正在思考 / 调工具 / 跑长任务时，用户在输入框里发送的消息怎么处理：
//   - "interrupt"（打断）：停掉当前回合，用这条消息开新回合。
//   - "queue"（排队）：先存起来，当前回合结束后自动发送。
//   - "steer"（引导）：不打断，把文本注入到下一个工具结果里，模型在下一步看到。
// 三者对应 CLI 的 `busy_input_mode`（cli.py），后端走 `session.interrupt` /
// 排队 / `session.steer`（tui_gateway/server.py）。配置落在 config.yaml 的
// `display.busy_input_mode`，桌面端纯前端读取这个值来决定走哪条路（不依赖后端
// 把它热更新到会话里）。
//
// 默认值取 "steer"：这是最贴近 "像 CLI 一样持续交互" 的非破坏式行为——可以随时
// 补充/纠偏而不丢弃在跑的工作，硬中止仍由 Stop 按钮兜底。注意：框架默认是
// "interrupt"，TUI 默认是 "queue"，桌面端在这里刻意选 "steer"。

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nestedValue = (
  config: Record<string, unknown> | undefined | null,
  path: string,
): unknown => {
  if (!config) return undefined;
  return path.split(".").reduce<unknown>((current, key) => asRecord(current)?.[key], config);
};

export const BUSY_INPUT_MODES = ["interrupt", "queue", "steer"] as const;

export type BusyInputMode = (typeof BUSY_INPUT_MODES)[number];

/** 下拉菜单/标签里的完整中文标签（与 config-translations 保持一致）。 */
export const BUSY_INPUT_MODE_LABELS: Record<BusyInputMode, string> = {
  interrupt: "打断",
  queue: "排队",
  steer: "引导",
};

/** 工具栏 trigger / 占位符里的一句话说明。 */
export const BUSY_INPUT_MODE_HINTS: Record<BusyInputMode, string> = {
  interrupt: "打断当前回合并发送…",
  queue: "排队，当前回合结束后发送…",
  steer: "引导当前回合（不打断）…",
};

// 桌面端默认行为。框架默认 "interrupt"、TUI 默认 "queue"，详见文件头注释。
export const DESKTOP_DEFAULT_BUSY_INPUT_MODE: BusyInputMode = "steer";

/** 是否为合法的运行时输入行为取值。 */
export function isBusyInputMode(value: unknown): value is BusyInputMode {
  return (
    typeof value === "string" &&
    (BUSY_INPUT_MODES as readonly string[]).includes(value)
  );
}

/**
 * 把配置里读到的任意值规整成合法的 busy_input_mode。
 * 大小写不敏感、去空白；无法识别（含空串）返回 null。
 */
export function normalizeBusyInputMode(value: unknown): BusyInputMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isBusyInputMode(normalized) ? normalized : null;
}

/**
 * 从 `/api/config` 返回的完整配置里取出 `display.busy_input_mode`。
 * 读不到或非法时回落到桌面端默认（steer）。
 */
export function busyInputModeFromConfig(
  config: Record<string, unknown> | undefined | null,
): BusyInputMode {
  return (
    normalizeBusyInputMode(nestedValue(config, "display.busy_input_mode")) ??
    DESKTOP_DEFAULT_BUSY_INPUT_MODE
  );
}

export type BusySubmitAction =
  | { kind: "queue" }
  | { kind: "interrupt" }
  | { kind: "steer" };

export interface BusySubmitInput {
  /** 输入框里的文本（已去除技能 chip 等装饰后的可发送文本）。 */
  text: string;
  /** 是否带附件（图片/文件/目录）。 */
  hasAttachments: boolean;
}

/**
 * 根据当前 busy_input_mode 决定一条 "运行中提交" 走哪条路。纯函数，便于单测。
 *
 * 特例：steer 需要非空文本（后端对空文本返回 4002），因此 steer 模式下若文本为空
 * （仅附件），回落到 queue——附件没法被 steer 注入，但可以排队等下一回合发送。
 */
export function resolveBusySubmitAction(
  mode: BusyInputMode,
  input: BusySubmitInput,
): BusySubmitAction {
  if (mode === "steer") {
    return input.text.trim().length > 0 ? { kind: "steer" } : { kind: "queue" };
  }
  if (mode === "interrupt") return { kind: "interrupt" };
  return { kind: "queue" };
}
