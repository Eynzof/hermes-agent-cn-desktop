import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useModelInfo } from "@/hooks/use-config";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";

const SKIP_KEY = "hermes-onboarding-skipped";

function hasConfiguredModel(modelInfo: { model?: string; provider?: string } | undefined): boolean {
  return Boolean(modelInfo?.model?.trim() && modelInfo?.provider?.trim());
}

export function ModelOnboardingGuard() {
  const location = useLocation();
  const { data: modelInfo, isLoading, isError } = useModelInfo();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(SKIP_KEY) === "true"; } catch { return false; }
  });

  const configured = hasConfiguredModel(modelInfo);

  useEffect(() => {
    if (!configured || typeof window === "undefined") return;
    try { localStorage.removeItem(SKIP_KEY); } catch { /* ignore */ }
    setDismissed(false);
  }, [configured]);

  if (
    isLoading ||
    isError ||
    configured ||
    dismissed ||
    location.pathname.startsWith("/models") ||
    location.pathname.startsWith("/console")
  ) {
    return null;
  }

  return <OnboardingWizard />;
}
