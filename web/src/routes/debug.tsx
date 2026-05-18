import { DebugSection } from "./settings-debug-section";
import { SectionShell } from "./section-shell";

export function DebugRoute() {
  return (
    <SectionShell title="Debug" sub="前端事件、REST / Gateway 失败、Console 错误与异常捕获。">
      <DebugSection showHeading={false} />
    </SectionShell>
  );
}
