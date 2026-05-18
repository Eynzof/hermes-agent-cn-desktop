import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

describe("MessageTimeline", () => {
  it("uses the optimistic progress model instead of stale session usage", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在启动Hermes Agent内核..." }],
      },
    ];

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{ model: "deepseek-v4-flash" } as any}
        progressModel="qwen3.6-plus"
      />,
    );

    expect(html).toContain("qwen3.6-plus");
    expect(html).not.toContain("deepseek-v4-flash");
  });
});
