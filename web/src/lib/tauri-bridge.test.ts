import { describe, expect, it } from "vitest";
import { isTauriDevMode } from "./tauri-bridge";

describe("isTauriDevMode", () => {
  it("uses Vite build mode instead of the window URL protocol", () => {
    expect(isTauriDevMode(true)).toBe(true);
    expect(isTauriDevMode(false)).toBe(false);
  });
});
