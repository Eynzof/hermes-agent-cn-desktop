import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetSessionModelOverride,
  readSessionModelOverride,
  rememberSessionModelOverride,
} from "./session-model-override";

function stubSessionStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
}

describe("session-model-override", () => {
  beforeEach(() => stubSessionStorage());

  it("returns null when nothing stored", () => {
    expect(readSessionModelOverride("abc")).toBeNull();
  });

  it("round-trips a selection by session id", () => {
    rememberSessionModelOverride("sess-1", {
      model: "deepseek-v4-pro",
      provider: "deepseek",
      providerName: "DeepSeek",
    });
    expect(readSessionModelOverride("sess-1")).toEqual({
      model: "deepseek-v4-pro",
      provider: "deepseek",
      providerName: "DeepSeek",
    });
  });

  it("isolates entries per session id", () => {
    rememberSessionModelOverride("s1", { model: "A", provider: "p" });
    rememberSessionModelOverride("s2", { model: "B", provider: "p" });
    expect(readSessionModelOverride("s1")?.model).toBe("A");
    expect(readSessionModelOverride("s2")?.model).toBe("B");
  });

  it("ignores selections without a model", () => {
    rememberSessionModelOverride("s1", { model: "" });
    expect(readSessionModelOverride("s1")).toBeNull();
  });

  it("survives malformed payloads", () => {
    window.sessionStorage.setItem("hermes:session-model:s1", "not json");
    expect(readSessionModelOverride("s1")).toBeNull();
    window.sessionStorage.setItem("hermes:session-model:s1", JSON.stringify({ model: 42 }));
    expect(readSessionModelOverride("s1")).toBeNull();
  });

  it("forgets on demand", () => {
    rememberSessionModelOverride("s1", { model: "A", provider: "p" });
    forgetSessionModelOverride("s1");
    expect(readSessionModelOverride("s1")).toBeNull();
  });

  it("no-ops on empty session id", () => {
    rememberSessionModelOverride("", { model: "A" });
    expect(readSessionModelOverride("")).toBeNull();
  });
});
