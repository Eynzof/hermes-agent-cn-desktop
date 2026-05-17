import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

function freshLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
}

beforeEach(() => {
  const ls = freshLocalStorage();
  vi.stubGlobal("localStorage", ls);
  // atomWithStorage uses `window.localStorage` in browser-ish environments.
  vi.stubGlobal("window", { localStorage: ls });
});

describe("activeSessionIdAtom", () => {
  it("starts null and accepts a string id", async () => {
    const { activeSessionIdAtom } = await import("./ui");
    const store = createStore();
    expect(store.get(activeSessionIdAtom)).toBeNull();
    store.set(activeSessionIdAtom, "session-1");
    expect(store.get(activeSessionIdAtom)).toBe("session-1");
  });
});

describe("sidebarSearchAtom", () => {
  it("defaults to empty string", async () => {
    const { sidebarSearchAtom } = await import("./ui");
    const store = createStore();
    expect(store.get(sidebarSearchAtom)).toBe("");
  });

  it("round-trips a search query", async () => {
    const { sidebarSearchAtom } = await import("./ui");
    const store = createStore();
    store.set(sidebarSearchAtom, "tavily");
    expect(store.get(sidebarSearchAtom)).toBe("tavily");
  });
});

describe("activeProfileAtom (persisted)", () => {
  it("defaults to 'default' when nothing in storage", async () => {
    const { activeProfileAtom } = await import("./ui");
    const store = createStore();
    expect(store.get(activeProfileAtom)).toBe("default");
  });

  it("persists writes to localStorage under hermes.active-profile", async () => {
    const { activeProfileAtom } = await import("./ui");
    const store = createStore();
    store.set(activeProfileAtom, "work");
    expect(globalThis.localStorage.getItem("hermes.active-profile")).toBe(
      JSON.stringify("work"),
    );
  });
});

describe("showReasoningAtom (persisted)", () => {
  it("defaults to false", async () => {
    const { showReasoningAtom } = await import("./ui");
    const store = createStore();
    expect(store.get(showReasoningAtom)).toBe(false);
  });

  it("persists boolean toggles", async () => {
    const { showReasoningAtom } = await import("./ui");
    const store = createStore();
    store.set(showReasoningAtom, true);
    expect(globalThis.localStorage.getItem("hermes.show-reasoning")).toBe("true");
    store.set(showReasoningAtom, false);
    expect(globalThis.localStorage.getItem("hermes.show-reasoning")).toBe("false");
  });
});

describe("profileSwitchingAtom", () => {
  it("defaults to { active: false }", async () => {
    const { profileSwitchingAtom } = await import("./ui");
    const store = createStore();
    expect(store.get(profileSwitchingAtom)).toEqual({ active: false });
  });

  it("carries the targetName when activating", async () => {
    const { profileSwitchingAtom } = await import("./ui");
    const store = createStore();
    store.set(profileSwitchingAtom, { active: true, targetName: "work" });
    expect(store.get(profileSwitchingAtom)).toEqual({
      active: true,
      targetName: "work",
    });
  });

  it("notifies subscribers on each change", async () => {
    const { profileSwitchingAtom } = await import("./ui");
    const store = createStore();
    let calls = 0;
    const unsubscribe = store.sub(profileSwitchingAtom, () => {
      calls += 1;
    });
    store.set(profileSwitchingAtom, { active: true, targetName: "a" });
    store.set(profileSwitchingAtom, { active: false });
    unsubscribe();
    expect(calls).toBe(2);
  });
});
