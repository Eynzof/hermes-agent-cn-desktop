import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
} from "@hermes/protocol";
import { runtime } from "@/lib/runtime";

const RUNTIME_INFO_KEY = ["desktop-runtime-info"] as const;

function hasRuntimeBridge(): boolean {
  return typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.getRuntimeInfo);
}

async function refreshDesktopGateway(): Promise<void> {
  if (window.hermesDesktop?.refreshGatewayUrl) {
    await runtime.refreshGatewayUrl();
  }
}

export function useRuntimeInfo() {
  return useQuery<RuntimeInfo>({
    queryKey: RUNTIME_INFO_KEY,
    queryFn: () => window.hermesDesktop!.getRuntimeInfo!(),
    enabled: hasRuntimeBridge(),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useCheckRuntimeUpdate() {
  return useMutation<RuntimeUpdateCheckResult>({
    mutationFn: () => window.hermesDesktop!.checkRuntimeUpdate!(),
  });
}

export function useInstallRuntimeUpdate() {
  const qc = useQueryClient();
  return useMutation<RuntimeInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.installRuntimeUpdate!(),
    onSuccess: async () => {
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
    },
  });
}

export function useRollbackRuntime() {
  const qc = useQueryClient();
  return useMutation<RuntimeInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.rollbackRuntime!(),
    onSuccess: async () => {
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
    },
  });
}
