import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { useGateway } from "@/hooks/use-gateway";
import { useModelInfo } from "@/hooks/use-config";
import type {
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { activeSessionIdAtom } from "@/stores/ui";
import { buildComposerDisplayText, prepareComposerPrompt } from "@/lib/composer-prompt";
import { rememberSessionModelOverride } from "@/lib/session-model-override";
import { titleFromPrompt, titleWithSessionSuffix } from "@/lib/session-title";
import { uploadAttachmentFile } from "@/lib/transport";
import {
  rememberSessionWorkspace,
  rememberWorkspaceProject,
} from "@/lib/workspaces";

interface CreateAndSendOptions {
  createSession?: () => Promise<string>;
}

export function useCreateAndSendSession() {
  const navigate = useNavigate();
  const {
    createSession,
    beginPrompt,
    failPrompt,
    sendPrompt,
    setSessionTitle,
    setSessionModel,
    attachImage,
    detectDroppedPath,
  } = useGateway();
  const { data: modelInfo } = useModelInfo();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);

  return useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
    options?: CreateAndSendOptions,
  ) => {
    const submittedAt = Date.now();
    const sessionId = await (options?.createSession ?? createSession)();
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

    return sessionId;
  }, [
    attachImage,
    beginPrompt,
    createSession,
    detectDroppedPath,
    failPrompt,
    modelInfo?.model,
    modelInfo?.provider,
    navigate,
    sendPrompt,
    setActiveSessionId,
    setSessionModel,
    setSessionTitle,
  ]);
}
