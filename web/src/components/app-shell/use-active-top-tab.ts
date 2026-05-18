import { useLocation } from "react-router-dom";

export type TopTab =
  | "workbench"
  | "projects"
  | "skills"
  | "automation"
  | "observability";

export interface TopTabDef {
  id: TopTab;
  num: string;
  label: string;
  href: string;
  matches: (path: string) => boolean;
}

export const TOP_TABS: readonly TopTabDef[] = [
  {
    id: "workbench",
    num: "01",
    label: "工作台",
    href: "/",
    matches: (path) =>
      path === "/" ||
      path.startsWith("/new") ||
      path.startsWith("/tasks/") ||
      path.startsWith("/history"),
  },
  {
    id: "projects",
    num: "02",
    label: "项目",
    href: "/projects",
    matches: (path) => path === "/projects" || path.startsWith("/projects/"),
  },
  {
    id: "skills",
    num: "03",
    label: "配置",
    href: "/skills",
    matches: (path) =>
      path.startsWith("/skills") ||
      path.startsWith("/mcp") ||
      path.startsWith("/profiles") ||
      path.startsWith("/models"),
  },
  {
    id: "automation",
    num: "04",
    label: "自动化",
    href: "/cron",
    matches: (path) => path.startsWith("/cron"),
  },
  {
    id: "observability",
    num: "05",
    label: "可观测",
    href: "/health",
    matches: (path) =>
      path.startsWith("/health") ||
      path.startsWith("/logs") ||
      path.startsWith("/debug") ||
      path.startsWith("/settings") ||
      path.startsWith("/dev/primitives"),
  },
];

export function useActiveTopTab(): TopTab | null {
  const { pathname } = useLocation();
  const match = TOP_TABS.find((tab) => tab.matches(pathname));
  return match?.id ?? null;
}
