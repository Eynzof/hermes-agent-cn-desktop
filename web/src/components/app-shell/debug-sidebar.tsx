import { useNavigate, useLocation } from "react-router-dom";
import {
  Boxes,
  Clock,
  Cpu,
  Edit3,
  FileText,
  FlaskConical,
  Folder,
  HeartPulse,
  LayoutDashboard,
  MessageSquare,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface DebugItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title?: string;
}

interface DebugSection {
  num: string;
  label: string;
  items: DebugItem[];
}

const SECTIONS: readonly DebugSection[] = [
  {
    num: "§01",
    label: "工作",
    items: [
      { label: "任务面板", path: "/", icon: LayoutDashboard },
      { label: "新对话", path: "/new", icon: Edit3 },
      { label: "对话历史", path: "/history", icon: MessageSquare },
      { label: "搜索", path: "/history", icon: Search },
      { label: "定时任务", path: "/cron", icon: Clock },
    ],
  },
  {
    num: "§02",
    label: "能力",
    items: [
      {
        label: "Profile",
        path: "/profiles",
        icon: Boxes,
        title: "Profile：独立 config / .env / sessions / skills 的环境",
      },
      { label: "技能", path: "/skills", icon: Sparkles },
      { label: "MCP", path: "/mcp", icon: Puzzle },
      { label: "模型", path: "/models", icon: Cpu },
    ],
  },
  {
    num: "§03",
    label: "项目",
    items: [{ label: "项目列表", path: "/projects", icon: Folder }],
  },
  {
    num: "§04",
    label: "监控",
    items: [
      { label: "健康检查", path: "/health", icon: HeartPulse },
      { label: "日志", path: "/logs", icon: FileText },
    ],
  },
  {
    num: "§05",
    label: "系统",
    items: [
      { label: "设置", path: "/settings", icon: Settings },
      ...(import.meta.env.DEV
        ? [
            {
              label: "Dev Primitives",
              path: "/dev/primitives",
              icon: FlaskConical,
              title: "组件库 / token playground（仅 dev）",
            } as DebugItem,
          ]
        : []),
    ],
  },
];

export function DebugSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname === path || location.pathname.startsWith(path + "/");
  };

  return (
    <aside className={s.sidebar} aria-label="调试侧栏">
      <div className={s.scrollY}>
        {SECTIONS.map((section) => (
          <section key={section.num} className={s.section}>
            <div className={s.label}>
              <span>
                {section.num} · {section.label}
              </span>
              <span className={s.labelNum}>{section.items.length.toString().padStart(2, "0")}</span>
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={`${section.num}-${item.label}-${item.path}`}
                  type="button"
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  onClick={() => navigate(item.path)}
                  title={item.title ?? item.path}
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
        ))}
      </div>
    </aside>
  );
}
