import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { SessionUsageResult } from "@hermes/protocol";
import { activeSessionIdAtom } from "@/stores/ui";
import {
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  gwSessionIdAtom,
  removeApprovalAtom,
} from "@/stores/chat";
import { useSession, useSessionMessages, useSessions } from "@/hooks/use-sessions";
import { useGateway } from "@/hooks/use-gateway";
import { useConfig, useModelInfo } from "@/hooks/use-config";
import { prepareComposerPrompt } from "@/lib/composer-prompt";
import { formatElapsedTimer } from "@/lib/format";
import { getGatewayClient } from "@/lib/gateway-client";
import { resolveModelContextWindow } from "@/lib/model-context";
import { resolveGatewaySessionId, resolvePersistentSessionId } from "@/lib/session-map";
import { isRuntimeRunning } from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
} from "@/lib/session-ui-state";
import { uploadAttachmentFile } from "@/lib/transport";
import { rememberSessionWorkspace, rememberWorkspaceProject } from "@/lib/workspaces";
import { TopBar, TopBarActionButton, TopBarActions } from "@/components/top-bar/top-bar";
import { GooseComposer } from "@/components/chat/goose-composer";
import type {
  ComposerModelSelection,
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { MessageTimeline } from "@/components/chat/message-timeline";
import {
  hermesUIMessagesToChatMessages,
  mergeHermesUIMessages,
  messagesResponseToHermesUIMessages,
} from "@/components/chat/message-adapter";
import s from "./detail.module.css";

const ACTIVE_USAGE_POLL_INTERVAL_MS = 5_000;

export function DetailRoute() {
  // URL drives the *initial* selection (deep links, browser back/forward),
  // but `activeSessionIdAtom` is the runtime source of truth. This lets
  // sidebar / history / panel clicks update the atom synchronously and
  // keeps async work (resumeSession, RPCs) from racing the route.
  // See issue #53.
  const { taskId: urlTaskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveId] = useAtom(activeSessionIdAtom);
  const taskId = activeSessionId ?? urlTaskId;

  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);

  const {
    resumeSession,
    sendPrompt,
    interruptSession,
    getSessionUsage,
    getModelOptions,
    setSessionModel,
    attachImage,
    detectDroppedPath,
  } = useGateway();
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const [sessionUsage, setSessionUsage] = useState<SessionUsageResult | null>(null);
  const [selectedModel, setSelectedModel] = useState<ComposerModelSelection | null>(null);
  const [sessionIdCopyState, setSessionIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [sessionTitleOverrides, setSessionTitleOverrides] = useState(readSessionTitleOverrides);
  const sessionIdCopyTimer = useRef<number | null>(null);

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
  const { data: session } = useSession(restSessionId);
  const messagesQuery = useSessionMessages(restSessionId);
  const { data: messagesData, isLoading } = messagesQuery;
  const { data: sessionsData } = useSessions();
  const sessionData = session;
  const sessionSummary = sessionsData?.sessions.find(
    (item) => item.id === restSessionId || item.id === taskId,
  );
  const copyableSessionId = sessionData?.id ?? sessionSummary?.id ?? restSessionId ?? taskId ?? "";
  const runtimeIsBusy = isRuntimeRunning(runtime);
  const isGatewayLinked = Boolean(
    taskId &&
    (gwSessionId === taskId ||
      gwSessionId === activeMappedGatewaySessionId ||
      resolvePersistentSessionId(gwSessionId ?? undefined) === restSessionId),
  );
  // Stay in live mode whenever runtime messages have unsynced content, regardless
  // of streamStatus. Live messages carry richer metadata (TTFT, duration, cost)
  // than REST stored messages, so we keep them around and rely on
  // mergeHermesUIMessages() to deduplicate against stored data.
  const isLiveSession =
    isGatewayLinked ||
    runtimeIsBusy ||
    runtime.pendingApprovals.length > 0 ||
    runtime.messages.length > 0;

  // Sync URL → atom on mount and whenever URL changes (browser back/forward
  // or a deep-link entry). Sidebar / history clicks already update the atom
  // synchronously *before* navigating, so this only matters for the cases
  // where atom was empty/stale when this component mounted.
  useEffect(() => {
    if (urlTaskId && urlTaskId !== activeSessionId) setActiveId(urlTaskId);
  }, [urlTaskId, activeSessionId, setActiveId]);

  // Reset the user-selected model whenever the route changes to a different
  // session — otherwise the composer chip would carry over the previous
  // session's choice (or the global last-used model) instead of reflecting
  // this session's own model.
  useEffect(() => {
    setSelectedModel(null);
    setSessionUsage(null);
  }, [taskId]);

  useEffect(() => {
    return subscribeSessionUiStateChanges(() => {
      setSessionTitleOverrides(readSessionTitleOverrides());
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionIdCopyTimer.current !== null) {
        window.clearTimeout(sessionIdCopyTimer.current);
      }
    };
  }, []);

  const markSessionIdCopyState = useCallback((state: "copied" | "error") => {
    setSessionIdCopyState(state);
    if (sessionIdCopyTimer.current !== null) {
      window.clearTimeout(sessionIdCopyTimer.current);
    }
    sessionIdCopyTimer.current = window.setTimeout(() => {
      setSessionIdCopyState("idle");
      sessionIdCopyTimer.current = null;
    }, 2200);
  }, []);

  const copySessionId = useCallback(async () => {
    if (!copyableSessionId) return;
    try {
      await navigator.clipboard.writeText(copyableSessionId);
      markSessionIdCopyState("copied");
    } catch {
      markSessionIdCopyState("error");
    }
  }, [copyableSessionId, markSessionIdCopyState]);

  const ensureGatewaySession = useCallback(async (): Promise<string> => {
    if (!taskId) throw new Error("缺少会话 ID");
    if (restSessionId && taskId === restSessionId && !activeMappedGatewaySessionId) {
      // No URL navigate after the resume — atom + gwSessionIdAtom hold
      // the authoritative state; downstream callers go through
      // resolveGatewaySessionId / resolvePersistentSessionId helpers
      // which understand both id shapes. The async navigate that used
      // to live here was the source of #52 (closure-stale replace
      // yanking the URL back to the previous session after rapid
      // switches). See #53 for the broader rework.
      return await resumeSession(restSessionId);
    }
    return activeMappedGatewaySessionId ?? taskId;
  }, [activeMappedGatewaySessionId, restSessionId, resumeSession, taskId]);

  const usageGatewaySessionId = runtimeSessionId ?? activeMappedGatewaySessionId;

  useEffect(() => {
    if (!usageGatewaySessionId) return;
    let cancelled = false;
    getSessionUsage(usageGatewaySessionId)
      .then((usage) => {
        if (!cancelled) setSessionUsage(usage);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [getSessionUsage, usageGatewaySessionId]);

  useEffect(() => {
    if (!usageGatewaySessionId) return;
    return getGatewayClient().on("message.complete", (event) => {
      if (event.session_id !== usageGatewaySessionId) return;
      const payload = event.payload && typeof event.payload === "object"
        ? event.payload as Record<string, unknown>
        : {};
      const parsed = SessionUsageResult.safeParse(payload.usage);
      if (parsed.success) {
        setSessionUsage(parsed.data);
      } else {
        void getSessionUsage(usageGatewaySessionId)
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
  }, [getSessionUsage, queryClient, restSessionId, usageGatewaySessionId]);

  useEffect(() => {
    if (!usageGatewaySessionId || !runtimeIsBusy) return;

    let cancelled = false;
    let inFlight = false;

    const refreshUsage = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const usage = await getSessionUsage(usageGatewaySessionId);
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
  }, [getSessionUsage, runtimeIsBusy, usageGatewaySessionId]);

  const chatMessages = useMemo(() => {
    const stored = messagesResponseToHermesUIMessages(messagesData);
    const canonical = mergeHermesUIMessages(
      stored,
      isLiveSession ? runtime.messages : [],
    );
    return hermesUIMessagesToChatMessages(canonical);
  }, [
    isLiveSession,
    messagesData,
    runtime.messages,
  ]);

  const onSend = useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => {
    if (!taskId) return;
    const gatewaySessionId = await ensureGatewaySession();
    if (payload.workspacePath) {
      rememberWorkspaceProject(payload.workspacePath);
      rememberSessionWorkspace(taskId, payload.workspacePath);
      rememberSessionWorkspace(gatewaySessionId, payload.workspacePath);
      rememberSessionWorkspace(restSessionId, payload.workspacePath);
    }
    const prepared = await prepareComposerPrompt(gatewaySessionId, payload, {
      attachImage,
      detectDroppedPath,
      uploadFile: uploadAttachmentFile,
      onAttachmentUpdate: controls.updateAttachment,
    });
    await sendPrompt(gatewaySessionId, prepared.promptText, {
      displayText: prepared.displayText,
    });
  }, [attachImage, detectDroppedPath, ensureGatewaySession, restSessionId, sendPrompt, taskId]);

  const loadModelOptions = useCallback(async () => {
    const gatewaySessionId = await ensureGatewaySession();
    return getModelOptions(gatewaySessionId);
  }, [ensureGatewaySession, getModelOptions]);

  const onModelSelect = useCallback(async (selection: ComposerModelSelection) => {
    const gatewaySessionId = await ensureGatewaySession();
    await setSessionModel(gatewaySessionId, selection.model, selection.provider);
    setSelectedModel({
      ...selection,
      contextWindow: resolveModelContextWindow(config, selection),
    });
    await getSessionUsage(gatewaySessionId)
      .then(setSessionUsage)
      .catch(() => {});
  }, [config, ensureGatewaySession, getSessionUsage, setSessionModel]);

  const onStop = useCallback(async () => {
    const sessionId = runtimeSessionId ?? taskId;
    if (!sessionId || !runtimeIsBusy) return;
    await interruptSession(sessionId);
  }, [interruptSession, runtimeIsBusy, runtimeSessionId, taskId]);

  const title = sessionData || sessionSummary
    ? sessionDisplayTitle({
        id: sessionData?.id ?? sessionSummary?.id ?? taskId ?? "",
        title:
          sessionTitleOverrides[sessionData?.id ?? ""] ??
          sessionTitleOverrides[sessionSummary?.id ?? ""] ??
          sessionTitleOverrides[restSessionId ?? ""] ??
          sessionData?.title ??
          sessionSummary?.title,
        preview: sessionData?.preview ?? sessionSummary?.preview,
      })
    : "会话详情";
  const model = selectedModel?.model ?? sessionUsage?.model ?? sessionData?.model ?? "";
  const contextSelection = useMemo<ComposerModelSelection | null>(() => {
    if (selectedModel) return selectedModel;
    if (!model) return null;
    return {
      model,
      provider: modelInfo?.provider,
    };
  }, [model, modelInfo?.provider, selectedModel]);
  const selectedContextMax = useMemo(
    () => resolveModelContextWindow(config, contextSelection),
    [config, contextSelection],
  );
  const pendingApproval = runtime.pendingApprovals[0] ?? null;

  const [composerTick, setComposerTick] = useState(0);
  useEffect(() => {
    if (!runtimeIsBusy || !runtime.turnStartedAt) {
      setComposerTick(0);
      return;
    }
    setComposerTick(Date.now() - runtime.turnStartedAt);
    const timer = window.setInterval(() => {
      setComposerTick(Date.now() - (runtime.turnStartedAt ?? Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runtimeIsBusy, runtime.turnStartedAt]);

  const composerLoadingPlaceholder = runtimeIsBusy && runtime.turnStartedAt
    ? `Hermes 思考中 · ${formatElapsedTimer(composerTick)}`
    : undefined;

  const timelineStatus =
    runtime.statusMessage ||
    (runtimeIsBusy && chatMessages.length === 0 ? "任务运行中，等待输出…" : undefined);
  // session.usage 在刚 resume 的 gw session 上会返回 context_used=0（因为 gw
  // 只跟踪当前 live session 的累计用量，resume 后是新 gw session_id），但
  // REST /api/sessions/{id} 的 input_tokens+output_tokens 是该持久化 session
  // 的全部历史。0 是"还没数据"哨兵——用 ?? 会把 0 当 truthy 卡住，必须显式
  // 把 0 视为 undefined 才能 fall through 到 REST。compressions 同理。
  const liveUsed = sessionUsage?.context_used && sessionUsage.context_used > 0
    ? sessionUsage.context_used
    : undefined;
  const liveCompressions = sessionUsage?.compressions && sessionUsage.compressions > 0
    ? sessionUsage.compressions
    : undefined;
  const contextUsage = sessionUsage || modelInfo || sessionData
    ? {
        used:
          liveUsed ??
          (sessionData?.input_tokens || sessionData?.output_tokens
            ? (sessionData.input_tokens ?? 0) + (sessionData.output_tokens ?? 0)
            : undefined),
        max:
          selectedContextMax ??
          sessionUsage?.context_max ??
          // effective = max(config_context_length, auto_context_length)，是上游
          // 算好的权威值；auto 在探测失败时会回落到 256k，必须排在 effective 之后
          // 否则会把"探测失败兜底"误当成模型真实上限。
          modelInfo?.effective_context_length ??
          modelInfo?.auto_context_length,
        percent: liveUsed ? sessionUsage?.context_percent : undefined,
        model: selectedModel?.model ?? sessionUsage?.model ?? sessionData?.model ?? modelInfo?.model,
        compressions: liveCompressions,
      }
    : null;

  return (
    <div className={s.page}>
      <TopBar
        title={title}
        sub={model ? `本会话 ${model}` : undefined}
        right={
          <>
            {copyableSessionId ? (
              <TopBarActionButton
                onClick={copySessionId}
                title={`复制会话 ID：${copyableSessionId}`}
                aria-label={`复制会话 ID ${copyableSessionId}`}
              >
                {sessionIdCopyState === "copied" ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>
                  {sessionIdCopyState === "copied"
                    ? "已复制"
                    : sessionIdCopyState === "error"
                      ? "复制失败"
                      : "复制ID"}
                </span>
              </TopBarActionButton>
            ) : null}
            <TopBarActions />
          </>
        }
      />
      <MessageTimeline
        messages={chatMessages}
        loading={isLoading && runtime.messages.length === 0}
        statusMessage={timelineStatus}
        pendingApproval={
          pendingApproval ? (
            <ApprovalDialog approval={pendingApproval} />
          ) : undefined
        }
        turnStartedAt={runtimeIsBusy ? runtime.turnStartedAt : undefined}
        sessionUsage={runtimeIsBusy ? sessionUsage : undefined}
      />
      <div className={s.composerArea}>
        <GooseComposer
          onSend={onSend}
          placeholder="发送消息…"
          loadingPlaceholder={composerLoadingPlaceholder}
          showMeta={false}
          loading={runtimeIsBusy}
          onStop={onStop}
          modelPicker={{
            selected: contextSelection,
            label: model || modelInfo?.model,
            loadOptions: loadModelOptions,
            onSelect: onModelSelect,
            disabled: runtimeIsBusy,
          }}
          contextUsage={contextUsage}
        />
      </div>
    </div>
  );
}

/* ── Approval Dialog ──────────────────────────────────────────────────── */

function ApprovalDialog({ approval }: { approval: { requestId: string; sessionId: string; command: string; reason?: string } }) {
  const removeApproval = useSetAtom(removeApprovalAtom);

  const respond = async (choice: "approve" | "deny") => {
    try {
      await getGatewayClient().request("approval.respond", {
        session_id: approval.sessionId,
        request_id: approval.requestId,
        choice,
      });
    } catch {}
    removeApproval({ sessionId: approval.sessionId, requestId: approval.requestId });
  };

  return (
    <div className={s.approvalCard}>
      <div className={s.approvalHeader}>⚠ 需要确认执行</div>
      <div className={s.approvalCommand}>{approval.command}</div>
      {approval.reason && <div className={s.approvalReason}>{approval.reason}</div>}
      <div className={s.approvalActions}>
        <button className={s.approvalApprove} onClick={() => respond("approve")}>允许执行</button>
        <button className={s.approvalDeny} onClick={() => respond("deny")}>拒绝</button>
      </div>
    </div>
  );
}
