import { describe, expect, it } from "vitest";
import { expandSearchQuery } from "./model-search-aliases";

describe("expandSearchQuery", () => {
  it("returns the query unchanged when no CN alias matches", () => {
    expect(expandSearchQuery("deepseek")).toBe("deepseek");
    expect(expandSearchQuery("128K")).toBe("128k");
  });

  it("widens 千问 with qwen / dashscope / alibaba", () => {
    const expanded = expandSearchQuery("千问");
    expect(expanded).toContain("千问");
    expect(expanded).toContain("qwen");
    expect(expanded).toContain("dashscope");
    expect(expanded).toContain("alibaba");
  });

  it("widens 豆包 with doubao / ark / volcengine", () => {
    const expanded = expandSearchQuery("豆包");
    expect(expanded).toContain("doubao");
    expect(expanded).toContain("ark");
  });

  it("normalises whitespace and case", () => {
    expect(expandSearchQuery("  Kimi  ")).toBe("kimi");
  });

  it("can match an alias that appears as a substring of a longer query", () => {
    const expanded = expandSearchQuery("我要找智谱的模型");
    expect(expanded).toContain("zai");
    expect(expanded).toContain("glm");
  });

  it("returns empty string for blank input", () => {
    expect(expandSearchQuery("")).toBe("");
    expect(expandSearchQuery("   ")).toBe("");
  });
});
