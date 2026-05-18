import { useLocation, useNavigate } from "react-router-dom";
import { FileCog, Info, SlidersHorizontal, type LucideIcon } from "lucide-react";
import s from "./debug-sidebar.module.css";

interface AdvancedItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const ITEMS: readonly AdvancedItem[] = [
  { label: "常规", path: "/advanced", icon: SlidersHorizontal },
  { label: "配置", path: "/advanced/config", icon: FileCog },
  { label: "关于", path: "/advanced/about", icon: Info },
];

export function AdvancedSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    path === "/advanced"
      ? location.pathname === "/advanced" || location.pathname === "/advanced/"
      : location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <aside className={s.sidebar} aria-label="高级侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§05 · 高级</span>
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
