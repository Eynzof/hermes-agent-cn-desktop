import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SessionUsageResult } from "@hermes/protocol";
import { getGatewayClient } from "@/lib/gateway-client";

const ACTIVE_USAGE_POLL_INTERVAL_MS = 5_000;

interface UseSessionUsagePollingParams {
  gatewaySessionId: string | undefined;
  restSessionId: string | undefined;
  runtimeIsBusy: boolean;
  getSessionUsage: (sessionId: string) => Promise<SessionUsageResult>;
}

export function useSessionUsagePolling({
  gatewaySessionId,
  restSessionId,
  runtimeIsBusy,
  getSessionUsage,
}: UseSessionUsagePollingParams) {
  const queryClient = useQueryClient();
  const [sessionUsage, setSessionUsage] = useState<SessionUsageResult | null>(null);

  useEffect(() => {
    if (!gatewaySessionId) return;
    let cancelled = false;
    getSessionUsage(gatewaySessionId)
      .then((usage) => {
        if (!cancelled) setSessionUsage(usage);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gatewaySessionId, getSessionUsage]);

  useEffect(() => {
    if (!gatewaySessionId) return;
    return getGatewayClient().on("message.complete", (event) => {
      if (event.session_id !== gatewaySessionId) return;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const parsed = SessionUsageResult.safeParse(payload.usage);
      if (parsed.success) {
        setSessionUsage(parsed.data);
      } else {
        void getSessionUsage(gatewaySessionId)
          .then(setSessionUsage)
          .catch(() => {});
      }

      setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ["session-messages"],
          predicate: (q) => q.queryKey.includes(restSessionId),
        });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }, 500);
    });
  }, [gatewaySessionId, getSessionUsage, queryClient, restSessionId]);

  useEffect(() => {
    if (!gatewaySessionId || !runtimeIsBusy) return;

    let cancelled = false;
    let inFlight = false;

    const refreshUsage = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const usage = await getSessionUsage(gatewaySessionId);
        if (!cancelled) setSessionUsage(usage);
      } catch {
        // Keep the composer responsive; the next poll or completion event can recover.
      } finally {
        inFlight = false;
      }
    };

    void refreshUsage();
    const timer = window.setInterval(refreshUsage, ACTIVE_USAGE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [gatewaySessionId, getSessionUsage, runtimeIsBusy]);

  return [sessionUsage, setSessionUsage] as const;
}
