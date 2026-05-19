import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";

type CopyButtonState = "idle" | "copied" | "error";
type CopyTextSource = string | (() => string | Promise<string>);

interface CopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> {
  text: CopyTextSource;
  children: ReactNode;
  copiedLabel?: ReactNode;
  errorLabel?: ReactNode;
  resetMs?: number;
  showStatusIcon?: boolean;
  statusIconSize?: number;
  onCopied?: () => void;
  onCopyError?: (error: unknown) => void;
}

export function CopyButton({
  text,
  children,
  copiedLabel = "已复制",
  errorLabel = "复制失败",
  resetMs = 1600,
  showStatusIcon = true,
  statusIconSize = 13,
  onCopied,
  onCopyError,
  disabled,
  type = "button",
  ...buttonProps
}: CopyButtonProps) {
  const [state, setState] = useState<CopyButtonState>("idle");
  const resetTimer = useRef<number | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const markState = useCallback((nextState: Exclude<CopyButtonState, "idle">) => {
    clearResetTimer();
    setState(nextState);
    resetTimer.current = window.setTimeout(() => {
      setState("idle");
      resetTimer.current = null;
    }, resetMs);
  }, [clearResetTimer, resetMs]);

  const handleCopy = useCallback(async () => {
    try {
      const value = typeof text === "function" ? await text() : text;
      if (!value) throw new Error("empty copy text");
      await navigator.clipboard.writeText(value);
      markState("copied");
      onCopied?.();
    } catch (error) {
      markState("error");
      onCopyError?.(error);
    }
  }, [markState, onCopied, onCopyError, text]);

  const isDisabled = disabled || (typeof text === "string" && text.length === 0);
  const isInteractionLocked = state === "copied";

  return (
    <button
      {...buttonProps}
      type={type}
      disabled={isDisabled || isInteractionLocked}
      onClick={handleCopy}
      data-copy-state={state}
      aria-live="polite"
    >
      {state === "copied" ? (
        <>
          {showStatusIcon ? <Check size={statusIconSize} aria-hidden="true" /> : null}
          {copiedLabel}
        </>
      ) : state === "error" ? (
        errorLabel
      ) : (
        children
      )}
    </button>
  );
}
