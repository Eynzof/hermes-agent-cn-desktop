import type { ComposerModelSelection } from "@/components/chat/composer-types";

// Carries the picker selection across the new-task → detail navigation.
// Without this, detail's selectedModel/sessionUsage/sessionData are all
// empty on first mount and the displayed model falls back to modelInfo
// (the global default), which is almost never what the user just picked.
//
// sessionStorage (not localStorage) — overrides should die with the tab so
// stale entries don't accumulate. Detail consumes-and-clears on mount.

const STORAGE_PREFIX = "hermes:session-model:";

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function isValid(value: unknown): value is ComposerModelSelection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.model !== "string" || !v.model) return false;
  if (v.provider !== undefined && typeof v.provider !== "string") return false;
  if (v.providerName !== undefined && typeof v.providerName !== "string") return false;
  if (v.contextWindow !== undefined && typeof v.contextWindow !== "number") return false;
  return true;
}

export function rememberSessionModelOverride(
  sessionId: string,
  selection: ComposerModelSelection,
): void {
  if (!sessionId || !isValid(selection)) return;
  try {
    window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify(selection));
  } catch {
    // sessionStorage unavailable — silently drop, detail page will fall
    // back to its existing precedence chain.
  }
}

export function readSessionModelOverride(sessionId: string): ComposerModelSelection | null {
  if (!sessionId) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function forgetSessionModelOverride(sessionId: string): void {
  if (!sessionId) return;
  try {
    window.sessionStorage.removeItem(storageKey(sessionId));
  } catch {}
}
