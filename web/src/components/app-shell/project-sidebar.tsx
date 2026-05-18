import { useLocation, useNavigate } from "react-router-dom";
import {
  Edit3,
  Folder,
  LayoutDashboard,
  MessageSquare,
  Search,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface ProjectItem {
  label: string;
  path: string;
  icon: LucideIcon;
  active?: (pathname: string) => boolean;
}

const ITEMS: readonly ProjectItem[] = [
  {
    label: "项目列表",
    path: "/projects",
    icon: Folder,
    active: (pathname) => pathname === "/projects" || pathname.startsWith("/projects/"),
  },
  {
    label: "任务面板",
    path: "/",
    icon: LayoutDashboard,
    active: (pathname) => pathname === "/",
  },
  { label: "新对话", path: "/new", icon: Edit3 },
  { label: "对话历史", path: "/history", icon: MessageSquare },
  { label: "搜索", path: "/history", icon: Search },
];

export function ProjectSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = (item: ProjectItem) =>
    item.active
      ? item.active(location.pathname)
      : location.pathname === item.path || location.pathname.startsWith(item.path + "/");

  return (
    <aside className={s.sidebar} aria-label="项目侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§02 · 项目</span>
            <span className={s.labelNum}>{ITEMS.length.toString().padStart(2, "0")}</span>
          </div>
          {ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={`${item.label}-${item.path}`}
                type="button"
                className={s.item}
                data-active={isActive(item) ? "true" : undefined}
                onClick={() => navigate(item.path)}
                title={item.path}
              >
                <span className={s.itemIcon}>
                  <Icon size={14} />
                </span>
                <span className={s.itemLabel}>{item.label}</span>
                <span className={s.itemPath}>{item.path}</span>
              </button>
            );
          })}
        </section>
      </div>
    </aside>
  );
}
