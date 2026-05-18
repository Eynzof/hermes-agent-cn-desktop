import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import s from "./top-bar.module.css";

interface TopBarProps {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}

type TopBarActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function TopBar({ title, sub, right }: TopBarProps) {
  return (
    <div className={s.topBar} data-window-drag data-tauri-drag-region="deep">
      <div className={s.titleGroup}>
        {title && <span className={s.title}>{title}</span>}
        {sub && <span className={s.sub}>{sub}</span>}
      </div>
      <span className={s.spacer} />
      {right && <div className={s.actions}>{right}</div>}
    </div>
  );
}

export const TopBarActionButton = forwardRef<
  HTMLButtonElement,
  TopBarActionButtonProps
>(function TopBarActionButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={className ? `${s.chip} ${className}` : s.chip}
    />
  );
});

export function TopBarActions() {
  return null;
}
