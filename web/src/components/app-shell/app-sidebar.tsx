import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { DebugSidebar } from "./debug-sidebar";
import { PlaceholderSidebar } from "./placeholder-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "workbench") return <WorkbenchSidebar />;
  if (tab === "debug") return <DebugSidebar />;
  return <PlaceholderSidebar tab={tab} />;
}
