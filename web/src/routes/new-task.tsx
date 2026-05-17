import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useGateway } from "@/hooks/use-gateway";
import { useConfig, useModelInfo, useSaveConfig } from "@/hooks/use-config";
import { useModelOptions } from "@/hooks/use-model-options";
import { recordModelUsage } from "@/lib/model-usage-log";
import { rememberSessionModelOverride } from "@/lib/session-model-override";
import { useStatus } from "@/hooks/use-status";
import { buildComposerDisplayText, prepareComposerPrompt } from "@/lib/composer-prompt";
import { resolveModelContextWindow } from "@/lib/model-context";
import { readLastUsedModel, rememberLastUsedModel } from "@/lib/last-used-model";
import { uploadAttachmentFile } from "@/lib/transport";
import { titleFromPrompt, titleWithSessionSuffix } from "@/lib/session-title";
import {
  normalizeWorkspacePath,
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  workspaceNameFromPath,
  writeWorkspacePath,
} from "@/lib/workspaces";
import { composerPrefillAtom } from "@/stores/panel";
import { activeSessionIdAtom } from "@/stores/ui";
import { TopBar } from "@/components/top-bar/top-bar";
import { GooseComposer } from "@/components/chat/goose-composer";
import { QuickStart, RECIPES_NEW_TASK } from "@/components/panel/quick-start";
import type {
  ComposerModelSelection,
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { getGreeting } from "@/lib/format";
import s from "./new-task.module.css";

const COMPOSER_HINTS = [
  { kbd: "@", label: "引用文件" },
  { kbd: "/", label: "选择 Skill" },
  { label: "把文件拖入此处直接附加" },
];

interface MetaRowProps {
  k: string;
  v: string;
  mono?: boolean;
  tone?: "warn" | "muted";
}

function MetaRow({ k, v, mono, tone }: MetaRowProps) {
  return (
    <div className={s.metaRow}>
      <span className={s.metaKey}>{k}</span>
      <span
        className={`${s.metaVal} ${mono ? s.mono : ""}`}
        data-tone={tone}
      >
        {v}
      </span>
    </div>
  );
}

export function NewTaskRoute() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    connect,
    createSession,
    beginPrompt,
    failPrompt,
    sendPrompt,
    setSessionTitle,
    getModelOptions,
    setSessionModel,
    attachImage,
    detectDroppedPath,
  } = useGateway();
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const { data: modelOptionsCache } = useModelOptions();
  const saveConfig = useSaveConfig();
  const { data: status, isError: statusError } = useStatus();
  const [sending, setSending] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ComposerModelSelection | null>(
    () => readLastUsedModel(),
  );
  const [prefilledText, setPrefilledText] = useState("");
  const [prefill, setPrefill] = useAtom(composerPrefillAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const composerRef = useRef<HTMLDivElement>(null);
  const initialWorkspacePath = normalizeWorkspacePath(searchParams.get("workspace"));

  useEffect(() => {
    if (!initialWorkspacePath) return;
    writeWorkspacePath(initialWorkspacePath);
    rememberWorkspaceProject(initialWorkspacePath);
  }, [initialWorkspacePath]);

  useEffect(() => {
    void connect().catch(() => {});
  }, [connect]);

  useEffect(() => {
    if (!prefill) return;
    setPrefilledText(prefill.text);
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPrefill(null);
  }, [prefill, setPrefill]);

  const greeting = useMemo(() => getGreeting(new Date().getHours()), []);

  const contextSelection = useMemo(() => {
    const model = selectedModel?.model ?? modelInfo?.model;
    if (!model) return null;
    return {
      model,
      provider: selectedModel?.provider ?? modelInfo?.provider,
      providerName: selectedModel?.providerName,
      contextWindow: selectedModel?.contextWindow,
    };
  }, [modelInfo?.model, modelInfo?.provider, selectedModel]);

  const contextMax = useMemo(
    () =>
      resolveModelContextWindow(config, contextSelection) ??
      modelInfo?.effective_context_length ??
      modelInfo?.auto_context_length,
    [config, contextSelection, modelInfo?.auto_context_length, modelInfo?.effective_context_length],
  );

  const onModelSelect = useCallback((selection: ComposerModelSelection) => {
    const enriched: ComposerModelSelection = {
      ...selection,
      contextWindow: resolveModelContextWindow(config, selection),
    };
    setSelectedModel(enriched);
    rememberLastUsedModel(enriched);
    recordModelUsage(enriched);
  }, [config]);

  const onConfigureProvider = useCallback((providerId: string) => {
    navigate(`/models#provider-${providerId}`);
  }, [navigate]);

  const onSelectAndSetDefault = useCallback((selection: ComposerModelSelection) => {
    onModelSelect(selection);
    if (!config) return;
    saveConfig.mutate({
      ...config,
      model: {
        ...(typeof config.model === "object" && config.model !== null && !Array.isArray(config.model)
          ? config.model as Record<string, unknown>
          : {}),
        provider: selection.provider,
        default: selection.model,
      },
    });
  }, [config, onModelSelect, saveConfig]);

  const onSend = useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => {
    if (sending) return;
    setSending(true);
    try {
      const submittedAt = Date.now();
      const sessionId = await createSession();
      const title = titleFromPrompt(payload.text || payload.attachments[0]?.name || "");
      const optimisticDisplayText = buildComposerDisplayText(payload);

      if (payload.modelSelection?.model) {
        rememberSessionModelOverride(sessionId, payload.modelSelection);
      }
      if (payload.workspacePath) {
        rememberWorkspaceProject(payload.workspacePath);
        rememberSessionWorkspace(sessionId, payload.workspacePath);
      }

      beginPrompt(sessionId, optimisticDisplayText, submittedAt);
      // Atom-driven (#53): set the atom *before* navigating so detail
      // route mounts with the correct sessionId already in atom state.
      setActiveSessionId(sessionId);
      navigate(`/tasks/${sessionId}`);

      void (async () => {
        try {
          if (payload.modelSelection?.model) {
            const selectedProvider = payload.modelSelection.provider;
            const alreadyUsingModel =
              payload.modelSelection.model === modelInfo?.model &&
              (!selectedProvider || selectedProvider === modelInfo?.provider);
            if (!alreadyUsingModel) {
              await setSessionModel(
                sessionId,
                payload.modelSelection.model,
                payload.modelSelection.provider,
              );
            }
          }
          const prepared = await prepareComposerPrompt(sessionId, payload, {
            attachImage,
            detectDroppedPath,
            uploadFile: uploadAttachmentFile,
            onAttachmentUpdate: controls.updateAttachment,
          });
          await sendPrompt(sessionId, prepared.promptText, {
            displayText: prepared.displayText,
            skipOptimisticStart: true,
          });
        } catch (err) {
          console.error("Failed to submit session:", err);
          failPrompt(sessionId, err);
        }
      })();

      if (title) {
        void setSessionTitle(sessionId, title).catch((titleError) => {
          const fallbackTitle = titleWithSessionSuffix(title, sessionId);
          if (!fallbackTitle || fallbackTitle === title) {
            console.warn("Failed to set session title:", titleError);
            return;
          }
          void setSessionTitle(sessionId, fallbackTitle).catch(() => {
            console.warn("Failed to set fallback session title:", titleError);
          });
        });
      }
    } catch (err) {
      console.error("Failed to create session:", err);
      setSending(false);
      throw err;
    }
  }, [
    sending,
    createSession,
    beginPrompt,
    failPrompt,
    setSessionTitle,
    setSessionModel,
    attachImage,
    detectDroppedPath,
    navigate,
    sendPrompt,
    setActiveSessionId,
    modelInfo?.model,
    modelInfo?.provider,
  ]);

  // gateway_running 是 PTY daemon 字段（P-009 之后 v2 transport
  // 走进程内 dispatch，daemon 默认 stopped）。真正的健康指标是
  // dashboard 是否响应。详见 health-grid.tsx 顶部注释。
  const gatewayOk = !statusError && !!status;
  const gatewayLabel = statusError
    ? "Gateway 离线"
    : gatewayOk
      ? "Gateway 就绪"
      : "Gateway 连接中";
  const gatewayTone: "ok" | "warn" | "err" = statusError
    ? "err"
    : gatewayOk
      ? "ok"
      : "warn";

  const projectName = initialWorkspacePath
    ? workspaceNameFromPath(initialWorkspacePath)
    : "";
  const ctxDisplay = contextMax
    ? contextMax >= 1_000_000
      ? `${Math.round(contextMax / 1_000_000)}M`
      : `${Math.round(contextMax / 1_000)}k`
    : "—";

  return (
    <div className={s.page}>
      <TopBar
        title="新建任务"
        sub="空白草稿 · 输入后自动保存"
        right={
          <span className={s.gatewayChip} data-tone={gatewayTone}>
            <span className={s.gatewayDot} />
            {gatewayLabel}
          </span>
        }
      />
      <div className={s.content}>
        <div className={s.center}>
          <div className={s.kicker}>
            <span className={s.kickerDot} />
            新建任务 · COMPOSER
          </div>
          <h1 className={s.title}>{greeting}</h1>
          <p className={s.lede}>
            简明描述任务即可。Hermes 会自动选择工具，遇到风险操作会先征求同意，
            并把读写文件、命令输出、产物等工作过程展示在右侧工作区。
          </p>

          <div ref={composerRef} className={s.composerWrap}>
            <GooseComposer
              onSend={onSend}
              initial={prefilledText}
              placeholder="描述你想完成的任务，⌘ ↵ 发送…"
              autoFocus
              variant="big"
              headerLabel="新任务"
              hints={COMPOSER_HINTS}
              showMeta={false}
              loading={sending}
              modelPicker={{
                selected: selectedModel,
                label: modelInfo?.model,
                loadOptions: () => getModelOptions(),
                initialOptions: modelOptionsCache ?? null,
                onSelect: onModelSelect,
                onSelectAndSetDefault,
                onConfigureProvider,
                disabled: sending,
              }}
              contextUsage={
                contextSelection
                  ? {
                      max: contextMax,
                      model: contextSelection.model,
                    }
                  : null
              }
              initialWorkspacePath={initialWorkspacePath}
            />
          </div>

          <div className={s.metaGrid}>
            <div className={s.metaCard}>
              <div className={s.metaCardHead}>
                <h3>工作区</h3>
                <span className={s.metaPill} data-tone="accent">target</span>
              </div>
              <MetaRow k="项目" v={projectName || "未指定"} tone={projectName ? undefined : "muted"} />
              <MetaRow k="路径" v={initialWorkspacePath || "—"} mono />
            </div>

            <div className={s.metaCard}>
              <div className={s.metaCardHead}>
                <h3>模型</h3>
                <span className={s.metaPill}>budget</span>
              </div>
              <MetaRow
                k="Provider"
                v={contextSelection?.providerName || contextSelection?.provider || modelInfo?.provider || "—"}
              />
              <MetaRow k="模型" v={contextSelection?.model || modelInfo?.model || "—"} mono />
              <MetaRow k="上下文" v={`${ctxDisplay} tokens`} mono />
            </div>
          </div>

          <section className={s.recipeSec}>
            <div className={s.secHead}>
              <h2>或者从模板开始</h2>
              <button
                type="button"
                className={s.more}
                onClick={() => navigate("/skills")}
              >
                在 /skills 中管理 →
              </button>
            </div>
            <QuickStart recipes={RECIPES_NEW_TASK} columns={3} />
          </section>
        </div>
      </div>
    </div>
  );
}
