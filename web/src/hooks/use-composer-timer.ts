import { useEffect, useState } from "react";

export function useComposerTimer(runtimeIsBusy: boolean, turnStartedAt: number | undefined) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!runtimeIsBusy || !turnStartedAt) {
      setElapsedMs(0);
      return;
    }

    setElapsedMs(Date.now() - turnStartedAt);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - (turnStartedAt ?? Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runtimeIsBusy, turnStartedAt]);

  return elapsedMs;
}
