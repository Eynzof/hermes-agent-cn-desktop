import { describe, expect, it } from "vitest";
import { canUsePrewarmedDraftSession } from "./new-task-draft-session";

describe("canUsePrewarmedDraftSession", () => {
  it("uses a prewarmed draft when no explicit model was selected", () => {
    expect(canUsePrewarmedDraftSession(undefined, {
      model: "gpt-5.1",
      provider: "openai",
    })).toBe(true);
  });

  it("uses a prewarmed draft when the selected model matches the active default", () => {
    expect(canUsePrewarmedDraftSession({
      model: "gpt-5.1",
      provider: "openai",
    }, {
      model: "gpt-5.1",
      provider: "openai",
    })).toBe(true);
  });

  it("does not use a prewarmed draft after switching to a different model", () => {
    expect(canUsePrewarmedDraftSession({
      model: "kimi-k2",
      provider: "moonshot",
    }, {
      model: "gpt-5.1",
      provider: "openai",
    })).toBe(false);
  });

  it("does not use a prewarmed draft after switching provider for the same model id", () => {
    expect(canUsePrewarmedDraftSession({
      model: "claude-sonnet-4.5",
      provider: "anthropic",
    }, {
      model: "claude-sonnet-4.5",
      provider: "openrouter",
    })).toBe(false);
  });
});
