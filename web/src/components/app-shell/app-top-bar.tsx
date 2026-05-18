import { useNavigate, useLocation } from "react-router-dom";
import { Search, Settings } from "lucide-react";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import { ProfileSelector } from "@/components/sidebar/profile-selector";
import { TOP_TABS } from "./use-active-top-tab";
import s from "./app-top-bar.module.css";

export function AppTopBar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <header className={s.topbar} data-window-drag data-tauri-drag-region="deep">
      <div className={s.brand} aria-label="Hermes Agent CN">
        <HermesLogoMark className={s.brandMark} size={22} />
        <span className={s.wordmark}>
          Hermes <em>Agent</em>
        </span>
        <span className={s.ver}>中文社区桌面版</span>
      </div>

      <nav className={s.nav} aria-label="主导航">
        {TOP_TABS.map((tab) => (
          <a
            key={tab.id}
            href={tab.href}
            className={s.navLink}
            data-active={tab.matches(location.pathname) ? "true" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(tab.href);
            }}
          >
            <span className={s.navNum}>{tab.num}</span>
            {tab.label}
          </a>
        ))}
      </nav>

      <button
        type="button"
        className={s.search}
        onClick={() => navigate("/history")}
        title="搜索会话 / 文件"
        data-no-drag
      >
        <Search size={12} />
        <span>搜索会话 / 文件…</span>
        <span className={s.searchKbd}>⌘ K</span>
      </button>

      <div className={s.actions}>
        <ProfileSelector />
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => navigate("/settings")}
          data-active={location.pathname.startsWith("/settings") ? "true" : undefined}
          title="设置"
          aria-label="设置"
        >
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}
