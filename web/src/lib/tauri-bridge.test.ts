import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, isTauriDevMode } from "./tauri-bridge";

describe("isTauriDevMode", () => {
  it("uses Vite build mode instead of the window URL protocol", () => {
    expect(isTauriDevMode(true)).toBe(true);
    expect(isTauriDevMode(false)).toBe(false);
  });

  it("encodes large upload buffers in chunks", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const decoded = Uint8Array.from(atob(arrayBufferToBase64(bytes.buffer)), (char) => char.charCodeAt(0));

    expect(decoded).toEqual(bytes);
  });
});
