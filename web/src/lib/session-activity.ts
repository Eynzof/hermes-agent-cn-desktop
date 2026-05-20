import type { SessionSummary } from "@hermes/protocol";
import { resolvePersistentSessionId } from "@/lib/session-map";
import type { ChatRuntimeBySession, ChatSessionRuntime } from "@/stores/chat";

export function isRuntimeRunning(runtime: ChatSessionRuntime | undefined): boolean {
  if (!runtime) return false;
  if (
    runtime.streamStatus === "error" ||
    runtime.streamStatus === "complete" ||
    runtime.streamStatus === "idle"
  ) {
    return false;
  }
  return (
    runtime.streamStatus === "connecting" ||
    runtime.streamStatus === "streaming" ||
    runtime.pendingApprovals.length > 0 ||
    runtime.messages.some((message) =>
      message.parts.some((part) => part.type === "tool" && part.state === "running"),
    )
  );
}

function findRuntimeForSession(
  sessionId: string,
  runtimeBySession: ChatRuntimeBySession,
): ChatSessionRuntime | undefined {
  for (const [runtimeSessionId, runtime] of Object.entries(runtimeBySession)) {
    if (
      runtimeSessionId === sessionId ||
      resolvePersistentSessionId(runtimeSessionId) === sessionId
    ) {
      return runtime;
    }
  }
  return undefined;
}

export function isSessionRunning(
  session: SessionSummary,
  runtimeBySession: ChatRuntimeBySession = {},
): boolean {
  const runtime = findRuntimeForSession(session.id, runtimeBySession);
  if (runtime) return isRuntimeRunning(runtime);

  return session.is_active === true && session.message_count === 0;
}
