import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AppTopBar } from "./app-top-bar";
import { AppSidebar } from "./app-sidebar";
import { AppStatusBar } from "./app-status-bar";
import { SidebarVersionTag } from "./sidebar-version-tag";
import s from "./app-shell.module.css";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { pathname } = useLocation();
  // Settings owns its own full-page layout — bypass the shell entirely.
  const fullscreen = pathname.startsWith("/settings");

  return (
    <div className={s.shell} data-fullscreen={fullscreen ? "true" : undefined}>
      <div className={s.topbarSlot}>
        <AppTopBar />
      </div>
      <div className={s.sidebarSlot}>
        <AppSidebar />
        <SidebarVersionTag />
      </div>
      <div className={s.mainSlot}>{children}</div>
      <div className={s.statusbarSlot}>
        <AppStatusBar />
      </div>
    </div>
  );
}
