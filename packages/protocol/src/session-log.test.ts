import { describe, expect, it } from "vitest";

import { sessionLogToMessages } from "./session-log";

describe("sessionLogToMessages", () => {
  it("returns empty array when log has no messages field", () => {
    expect(sessionLogToMessages("s1", {})).toEqual([]);
  });

  it("returns empty array when messages is not an array", () => {
    expect(sessionLogToMessages("s1", { messages: "not an array" })).toEqual([]);
    expect(sessionLogToMessages("s1", { messages: { wrong: "shape" } })).toEqual([]);
    expect(sessionLogToMessages("s1", { messages: null })).toEqual([]);
  });

  it("drops entries with unknown roles", () => {
    const result = sessionLogToMessages("s1", {
      messages: [
        { role: "wizard", content: "magic" },
        { role: "user", content: "hi" },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });

  it("accepts all four canonical roles", () => {
    const result = sessionLogToMessages("s1", {
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        { role: "system", content: "sys" },
        { role: "tool", content: "t" },
      ],
    });
    expect(result.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
      "tool",
    ]);
  });

  it("drops null / non-object entries without affecting indices of valid ones", () => {
    const result = sessionLogToMessages("s1", {
      messages: [null, "string-not-obj", [], { role: "user", content: "ok" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("ok");
    // id is 1-based positional in the source array — verify the dropped
    // entries do not leave gaps but DO advance the counter.
    expect(result[0]?.id).toBe(4);
  });

  it("preserves stringification of non-string content", () => {
    const result = sessionLogToMessages("s1", {
      messages: [
        { role: "tool", content: { nested: { key: "value" } } },
      ],
    });
    expect(result[0]?.content).toBe('{"nested":{"key":"value"}}');
  });

  it("returns null content when content is null or undefined", () => {
    const result = sessionLogToMessages("s1", {
      messages: [
        { role: "user", content: null },
        { role: "user" },
      ],
    });
    expect(result[0]?.content).toBeNull();
    expect(result[1]?.content).toBeNull();
  });

  it("propagates tool_calls and reasoning_details verbatim", () => {
    const toolCalls = [{ id: "c1", function: { name: "f", arguments: "{}" } }];
    const reasoningDetails = { source: "openai", trace: [1, 2, 3] };
    const result = sessionLogToMessages("s1", {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
          reasoning_details: reasoningDetails,
        },
      ],
    });
    expect(result[0]?.tool_calls).toBe(toolCalls);
    expect(result[0]?.reasoning_details).toBe(reasoningDetails);
  });

  it("coerces non-string tool_name to null instead of crashing", () => {
    const result = sessionLogToMessages("s1", {
      messages: [
        { role: "tool", content: "x", tool_name: 42, tool_call_id: { obj: true } },
      ],
    });
    expect(result[0]?.tool_name).toBeNull();
    expect(result[0]?.tool_call_id).toBeNull();
  });

  it("assigns timestamps relative to session_start, monotonically increasing by index", () => {
    const result = sessionLogToMessages("s1", {
      session_start: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    const start = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
    expect(result[0]?.timestamp).toBeCloseTo(start, 3);
    expect(result[1]?.timestamp).toBeCloseTo(start + 1, 3);
    expect(result[2]?.timestamp).toBeCloseTo(start + 2, 3);
  });

  it("falls back to Date.now when session_start is missing", () => {
    const before = Date.now() / 1000;
    const result = sessionLogToMessages("s1", {
      messages: [{ role: "user", content: "x" }],
    });
    const after = Date.now() / 1000;
    const ts = result[0]?.timestamp ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("falls back to Date.now when session_start is unparseable", () => {
    const before = Date.now() / 1000;
    const result = sessionLogToMessages("s1", {
      session_start: "not a real date",
      messages: [{ role: "user", content: "x" }],
    });
    const after = Date.now() / 1000;
    const ts = result[0]?.timestamp ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("falls back to Date.now when session_start is not a string", () => {
    const before = Date.now() / 1000;
    const result = sessionLogToMessages("s1", {
      session_start: 1700000000,
      messages: [{ role: "user", content: "x" }],
    });
    const after = Date.now() / 1000;
    const ts = result[0]?.timestamp ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("attaches the sessionId to every emitted message", () => {
    const result = sessionLogToMessages("session-xyz", {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    });
    expect(result.every((m) => m.session_id === "session-xyz")).toBe(true);
  });

  it("sets token_count to null (raw logs don't carry it)", () => {
    const result = sessionLogToMessages("s1", {
      messages: [{ role: "user", content: "a" }],
    });
    expect(result[0]?.token_count).toBeNull();
  });
});
