import { describe, expect, it } from "vitest";
import {
  busyInputModeFromConfig,
  DESKTOP_DEFAULT_BUSY_INPUT_MODE,
  normalizeBusyInputMode,
  resolveBusySubmitAction,
} from "./busy-input-mode";

describe("normalizeBusyInputMode", () => {
  it("accepts the three valid modes case-insensitively", () => {
    expect(normalizeBusyInputMode("interrupt")).toBe("interrupt");
    expect(normalizeBusyInputMode("QUEUE")).toBe("queue");
    expect(normalizeBusyInputMode("  Steer ")).toBe("steer");
  });

  it("rejects unknown / non-string values", () => {
    expect(normalizeBusyInputMode("nope")).toBeNull();
    expect(normalizeBusyInputMode("")).toBeNull();
    expect(normalizeBusyInputMode(undefined)).toBeNull();
    expect(normalizeBusyInputMode(42)).toBeNull();
  });
});

describe("busyInputModeFromConfig", () => {
  it("reads display.busy_input_mode when present and valid", () => {
    expect(busyInputModeFromConfig({ display: { busy_input_mode: "interrupt" } })).toBe("interrupt");
    expect(busyInputModeFromConfig({ display: { busy_input_mode: "queue" } })).toBe("queue");
    expect(busyInputModeFromConfig({ display: { busy_input_mode: "steer" } })).toBe("steer");
  });

  it("falls back to the desktop default when missing / invalid / no config", () => {
    expect(busyInputModeFromConfig(undefined)).toBe(DESKTOP_DEFAULT_BUSY_INPUT_MODE);
    expect(busyInputModeFromConfig(null)).toBe(DESKTOP_DEFAULT_BUSY_INPUT_MODE);
    expect(busyInputModeFromConfig({})).toBe(DESKTOP_DEFAULT_BUSY_INPUT_MODE);
    expect(busyInputModeFromConfig({ display: {} })).toBe(DESKTOP_DEFAULT_BUSY_INPUT_MODE);
    expect(busyInputModeFromConfig({ display: { busy_input_mode: "garbage" } })).toBe(
      DESKTOP_DEFAULT_BUSY_INPUT_MODE,
    );
  });

  it("defaults to steer (desktop-specific choice)", () => {
    expect(DESKTOP_DEFAULT_BUSY_INPUT_MODE).toBe("steer");
  });
});

describe("resolveBusySubmitAction", () => {
  it("maps each mode to its action kind", () => {
    expect(resolveBusySubmitAction("interrupt", { text: "go", hasAttachments: false })).toEqual({ kind: "interrupt" });
    expect(resolveBusySubmitAction("queue", { text: "go", hasAttachments: false })).toEqual({ kind: "queue" });
    expect(resolveBusySubmitAction("steer", { text: "go", hasAttachments: false })).toEqual({ kind: "steer" });
  });

  it("falls back to queue for steer with empty text (attachments-only)", () => {
    expect(resolveBusySubmitAction("steer", { text: "", hasAttachments: true })).toEqual({ kind: "queue" });
    expect(resolveBusySubmitAction("steer", { text: "   ", hasAttachments: false })).toEqual({ kind: "queue" });
  });

  it("interrupt/queue ignore empty text (they can carry attachments)", () => {
    expect(resolveBusySubmitAction("interrupt", { text: "", hasAttachments: true })).toEqual({ kind: "interrupt" });
    expect(resolveBusySubmitAction("queue", { text: "", hasAttachments: true })).toEqual({ kind: "queue" });
  });
});
