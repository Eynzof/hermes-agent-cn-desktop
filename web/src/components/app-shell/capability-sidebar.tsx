import { useLocation, useNavigate } from "react-router-dom";
import {
  Boxes,
  Cpu,
  Puzzle,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface CapabilityItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title?: string;
}

const ITEMS: readonly CapabilityItem[] = [
  {
    label: "Profile",
    path: "/profiles",
    icon: Boxes,
    title: "Profile：独立 config / .env / sessions / skills 的环境",
  },
  { label: "技能", path: "/skills", icon: Sparkles },
  { label: "MCP", path: "/mcp", icon: Puzzle },
  { label: "模型", path: "/models", icon: Cpu },
];

export function CapabilitySidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  return (
    <aside className={s.sidebar} aria-label="配置侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§03 · 配置</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.path}
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
      </div>
    </aside>
  );
}
