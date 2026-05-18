import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { CapabilitySidebar } from "./capability-sidebar";
import { ProjectSidebar } from "./project-sidebar";
import { AutomationSidebar } from "./automation-sidebar";
import { ObservabilitySidebar } from "./observability-sidebar";
import { PlaceholderSidebar } from "./placeholder-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "workbench") return <WorkbenchSidebar />;
  if (tab === "projects") return <ProjectSidebar />;
  if (tab === "skills") return <CapabilitySidebar />;
  if (tab === "automation") return <AutomationSidebar />;
  if (tab === "observability") return <ObservabilitySidebar />;
  return <PlaceholderSidebar tab={tab} />;
}
