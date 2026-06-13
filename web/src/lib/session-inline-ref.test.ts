import { describe, expect, it } from "vitest";
import {
  HERMES_SESSION_MIME,
  dragHasSession,
  formatSessionInlineRef,
  readSessionDrag,
  sessionRefIdentity,
  writeSessionDrag,
} from "./session-inline-ref";

class FakeDataTransfer {
  effectAllowed = "";
  types: string[] = [];
  private values = new Map<string, string>();

  setData(type: string, value: string) {
    if (!this.types.includes(type)) this.types.push(type);
    this.values.set(type, value);
  }

  getData(type: string) {
    return this.values.get(type) ?? "";
  }
}

describe("session-inline-ref", () => {
  it("formats @session refs with the profile/id payload expected by session_search", () => {
    expect(formatSessionInlineRef({ profile: "default", sessionId: "session-id" })).toBe(
      "@session:`default/session-id`",
    );
  });

  it("writes and reads the in-app session drag payload", () => {
    const transfer = new FakeDataTransfer() as unknown as DataTransfer;

    expect(writeSessionDrag(transfer, {
      id: " session-1 ",
      profile: " work ",
      title: " 架构讨论 ",
    })).toBe(true);

    expect(dragHasSession(transfer)).toBe(true);
    expect(transfer.effectAllowed).toBe("copy");
    expect(transfer.getData("text/plain")).toBe("@session:`work/session-1`");
    expect(readSessionDrag(transfer)).toEqual({
      id: "session-1",
      profile: "work",
      title: "架构讨论",
    });
  });

  it("returns null for malformed drag payloads", () => {
    const transfer = new FakeDataTransfer() as unknown as DataTransfer;
    transfer.setData(HERMES_SESSION_MIME, "{not-json");

    expect(dragHasSession(transfer)).toBe(true);
    expect(readSessionDrag(transfer)).toBeNull();
  });

  it("normalizes identities so duplicate refs can be skipped", () => {
    expect(sessionRefIdentity({ profile: "", sessionId: "s1" })).toBe("default/s1");
    expect(sessionRefIdentity({ profile: " default ", id: " s1 " })).toBe("default/s1");
    expect(sessionRefIdentity({ profile: "default", sessionId: "" })).toBe("");
  });
});
