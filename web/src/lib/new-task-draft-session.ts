import type { ComposerModelSelection } from "@/components/chat/composer-types";

interface CurrentModelInfo {
  model?: string | null;
  provider?: string | null;
}

export function canUsePrewarmedDraftSession(
  selection: ComposerModelSelection | null | undefined,
  modelInfo: CurrentModelInfo | null | undefined,
): boolean {
  if (!selection?.model) return true;
  if (selection.model !== modelInfo?.model) return false;
  return !selection.provider || selection.provider === modelInfo?.provider;
}
