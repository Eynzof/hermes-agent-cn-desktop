export const HERMES_SESSION_MIME = "application/x-hermes-session";

export interface SessionDragPayload {
  id: string;
  profile: string;
  title: string;
}

export interface SessionRefIdentityLike {
  id?: string | null;
  sessionId?: string | null;
  profile?: string | null;
}

function normalizeSessionId(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function normalizeSessionProfile(value: string | null | undefined): string {
  const profile = (value ?? "").trim();
  return profile || "default";
}

export function sessionRefIdentity(ref: SessionRefIdentityLike): string {
  const sessionId = normalizeSessionId(ref.sessionId ?? ref.id);
  if (!sessionId) return "";
  return `${normalizeSessionProfile(ref.profile)}/${sessionId}`;
}

export function sessionRefLabel(ref: { id?: string | null; sessionId?: string | null; title?: string | null }): string {
  const title = (ref.title ?? "").trim();
  if (title) return title;
  const sessionId = normalizeSessionId(ref.sessionId ?? ref.id);
  return sessionId ? `chat ${sessionId.slice(0, 8)}` : "会话";
}

function quoteRefValue(value: string): string {
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `\`${value.replace(/`/g, "") || "session"}\``;
}

export function formatSessionInlineRef(ref: { profile?: string | null; sessionId: string }): string {
  const sessionId = normalizeSessionId(ref.sessionId);
  if (!sessionId) return "";
  return `@session:${quoteRefValue(`${normalizeSessionProfile(ref.profile)}/${sessionId}`)}`;
}

export function normalizeSessionDragPayload(value: Partial<SessionDragPayload> | null | undefined): SessionDragPayload | null {
  const id = normalizeSessionId(value?.id);
  if (!id) return null;
  return {
    id,
    profile: normalizeSessionProfile(value?.profile),
    title: (value?.title ?? "").trim(),
  };
}

export function writeSessionDrag(transfer: DataTransfer, payload: Partial<SessionDragPayload>): boolean {
  const normalized = normalizeSessionDragPayload(payload);
  if (!normalized) return false;
  transfer.setData(HERMES_SESSION_MIME, JSON.stringify(normalized));
  transfer.setData("text/plain", formatSessionInlineRef({
    profile: normalized.profile,
    sessionId: normalized.id,
  }));
  transfer.effectAllowed = "copy";
  return true;
}

export function dragHasSession(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types || []).includes(HERMES_SESSION_MIME);
}

export function readSessionDrag(transfer: DataTransfer | null): SessionDragPayload | null {
  const raw = transfer?.getData(HERMES_SESSION_MIME);
  if (!raw) return null;

  try {
    return normalizeSessionDragPayload(JSON.parse(raw) as Partial<SessionDragPayload>);
  } catch {
    return null;
  }
}
