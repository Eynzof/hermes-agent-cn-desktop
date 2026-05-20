import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@hermes/protocol";
import { createEmptyChatRuntime } from "@/stores/chat";
import { isRuntimeRunning, isSessionRunning } from "./session-activity";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    source: "tui",
    user_id: null,
    model: "test-model",
    title: null,
    started_at: 1,
    ended_at: null,
    message_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
    ...overrides,
  } as SessionSummary;
}

describe("session activity", () => {
  it("does not treat completed recent sessions as running", () => {
    expect(
      isSessionRunning(
        session({
          is_active: true,
          message_count: 2,
        }),
      ),
    ).toBe(false);
  });

  it("keeps empty active sessions in running state as a first-turn fallback", () => {
    expect(
      isSessionRunning(
        session({
          is_active: true,
          message_count: 0,
        }),
      ),
    ).toBe(true);
  });

  it("uses live runtime state over the API active heuristic", () => {
    const completeRuntime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "complete" as const,
    };
    const streamingRuntime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "streaming" as const,
    };

    expect(
      isSessionRunning(
        session({ is_active: true, message_count: 0 }),
        { s1: completeRuntime },
      ),
    ).toBe(false);
    expect(isRuntimeRunning(streamingRuntime)).toBe(true);
    expect(
      isSessionRunning(
        session({ is_active: false, message_count: 2 }),
        { s1: streamingRuntime },
      ),
    ).toBe(true);
  });

  it("does not keep completed or errored runtimes running because of stale live parts", () => {
    const runtime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "complete" as const,
      pendingApprovals: [{ requestId: "r1", sessionId: "s1", command: "approve" }],
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant" as const,
          createdAt: 1,
          status: "complete" as const,
          parts: [
            {
              type: "tool" as const,
              toolCallId: "tool-1",
              name: "read_file",
              state: "running" as const,
            },
          ],
        },
      ],
    };

    expect(isRuntimeRunning(runtime)).toBe(false);
    expect(isRuntimeRunning({ ...runtime, streamStatus: "error" })).toBe(false);
  });
});
