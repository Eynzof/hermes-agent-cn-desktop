import { useStatus } from "@/hooks/use-status";
import s from "./app-shell.module.css";

const FALLBACK_VERSION = "0.14.0";
const BUILD_COMMIT = import.meta.env.VITE_HERMES_BUILD_COMMIT || "unknown";

function versionLabel(version: string | undefined): string {
  const value = version?.trim() || FALLBACK_VERSION;
  return value.startsWith("v") || value.startsWith("V") ? value : `v${value}`;
}

function shortCommit(commit: string): string {
  const normalized = commit.trim();
  if (!normalized || normalized === "unknown") return "—";
  return normalized.slice(0, 7);
}

export function SidebarVersionTag() {
  const { data: status } = useStatus();
  const commit = shortCommit(BUILD_COMMIT);
  const items = [
    versionLabel(status?.version),
    status?.release_date?.trim() || undefined,
    commit !== "—" ? commit : undefined,
  ].filter(Boolean);

  return (
    <div
      className={s.sidebarInfoPanel}
      aria-label="构建与运行信息"
      title={`${items.join(" · ")}\n预览版本，不代表最终品质`}
    >
      <div className={s.sidebarInfoMeta}>
        {items.map((item, index) => (
          <span key={item} className={index === 0 ? s.sidebarInfoVersion : undefined}>
            {index > 0 && (
              <span className={s.sidebarInfoDot} aria-hidden="true">
                ·
              </span>
            )}
            {item}
          </span>
        ))}
      </div>
      <div className={s.sidebarInfoNote}>预览版本，不代表最终品质</div>
    </div>
  );
}
