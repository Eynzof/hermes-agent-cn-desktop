import { useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  gwSessionIdAtom,
} from "@/stores/chat";
import { isRuntimeRunning } from "@/lib/session-activity";
import { resolveGatewaySessionId, resolvePersistentSessionId } from "@/lib/session-map";

export function useSessionResolution(taskId: string | undefined) {
  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);

  return useMemo(() => {
    const restSessionId = resolvePersistentSessionId(taskId);
    const mappedGatewaySessionId = resolveGatewaySessionId(taskId);
    const activeMappedGatewaySessionId =
      mappedGatewaySessionId &&
      (gwSessionId === mappedGatewaySessionId || runtimeBySession[mappedGatewaySessionId])
        ? mappedGatewaySessionId
        : undefined;
    const runtimeSessionId =
      taskId && runtimeBySession[taskId] ? taskId : activeMappedGatewaySessionId;
    const runtime = taskId
      ? runtimeBySession[runtimeSessionId ?? taskId] ?? createEmptyChatRuntime()
      : createEmptyChatRuntime();
    const runtimeIsBusy = isRuntimeRunning(runtime);
    const isGatewayLinked = Boolean(
      taskId &&
        (gwSessionId === taskId ||
          gwSessionId === activeMappedGatewaySessionId ||
          resolvePersistentSessionId(gwSessionId ?? undefined) === restSessionId),
    );

    // Stay in live mode whenever runtime messages have unsynced content, regardless
    // of streamStatus. Live messages carry richer metadata (TTFT, duration, cost)
    // than REST stored messages, so detail can deduplicate them against stored data.
    const isLiveSession =
      isGatewayLinked ||
      runtimeIsBusy ||
      runtime.pendingApprovals.length > 0 ||
      runtime.messages.length > 0;

    return {
      restSessionId,
      activeMappedGatewaySessionId,
      runtimeSessionId,
      usageGatewaySessionId: runtimeSessionId ?? activeMappedGatewaySessionId,
      runtime,
      runtimeIsBusy,
      isGatewayLinked,
      isLiveSession,
    };
  }, [gwSessionId, runtimeBySession, taskId]);
}
