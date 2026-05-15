import { useEffect, useState } from "react";
import { useStatus } from "@/hooks/use-status";
import { useAnalytics } from "@/hooks/use-analytics";
import { formatCostCny, formatHeroTimestamp, getGreeting } from "@/lib/format";
import { Dot, Pill } from "@/components/ui/pill";
import s from "./panel-hero.module.css";

interface PanelHeroProps {
  activeCount: number;
}

export function PanelHero({ activeCount }: PanelHeroProps) {
  const [now, setNow] = useState(() => new Date());
  const { data: status } = useStatus();
  const { data: analytics } = useAnalytics(1);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const greeting = getGreeting(now.getHours());
  const stamp = formatHeroTimestamp(now);
  // Dashboard 可达即视为健康。gateway_running（PTY daemon 字段）
  // 跟 v2 SSE+POST transport 无关，详见 health-grid.tsx 注释。
  const healthOk = !!status;
  const todayCost = analytics?.daily?.[0]?.estimated_cost ?? 0;

  return (
    <div className={s.row}>
      <div className={s.left}>
        <h1 className={s.title}>{greeting}</h1>
        <div className={s.stamp}>{stamp}</div>
      </div>
      <div className={s.pills}>
        <Pill tone={healthOk ? "ok" : "warn"}>
          <Dot tone={healthOk ? "ok" : "warn"} />
          {healthOk ? "健康" : "异常"}
        </Pill>
        <Pill tone={activeCount > 0 ? "ok" : "neutral"}>{activeCount} 进行中</Pill>
        <Pill>{formatCostCny(todayCost)} 今日</Pill>
      </div>
    </div>
  );
}
