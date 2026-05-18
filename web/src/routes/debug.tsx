import { usePlatform } from "@hermes/shared-ui";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { runtime } from "@/lib/runtime";
import s from "./debug.module.css";

export function DebugRoute() {
  const platform = usePlatform();
  const { data: status } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const profile = useActiveProfileName();

  return (
    <div className={s.pageWrap}>
      <div className={s.pageContent}>
        <div className={s.hero}>
          <div className={s.num}>
            <span className={s.numTop}>№ 005</span>
            <span>调试</span>
          </div>
          <div>
            <h1 className={s.title}>调试入口</h1>
            <div className={s.lead}>调试入口已并入可观测；左侧栏保留常用诊断页面。</div>
          </div>
        </div>

        <section className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.tag}>[ 运行时 ]</span>
            <h2 className={s.sectionTitle}>当前进程</h2>
          </div>
          <div className={s.kv}>
            <div className={s.kvKey}>platform</div>
            <div className={s.kvVal}>{platform}</div>

            <div className={s.kvKey}>runtime.platform</div>
            <div className={s.kvVal}>{runtime.platform}</div>

            <div className={s.kvKey}>profile</div>
            <div className={s.kvVal}>{profile}</div>

            <div className={s.kvKey}>dashboard</div>
            <div className={s.kvVal}>{status ? "online" : "未响应"}</div>

            <div className={s.kvKey}>version</div>
            <div className={s.kvVal}>{status?.version ?? "—"}</div>

            <div className={s.kvKey}>release_date</div>
            <div className={s.kvVal}>{status?.release_date ?? "—"}</div>

            <div className={s.kvKey}>config_version</div>
            <div className={s.kvVal}>
              {status?.config_version != null ? status.config_version : "—"}
              {status?.latest_config_version != null && status?.config_version != null &&
                status.config_version !== status.latest_config_version &&
                ` (最新 ${status.latest_config_version})`}
            </div>

            <div className={s.kvKey}>hermes_home</div>
            <div className={s.kvVal}>{status?.hermes_home ?? "—"}</div>

            <div className={s.kvKey}>config_path</div>
            <div className={s.kvVal}>{status?.config_path ?? "—"}</div>

            <div className={s.kvKey}>env_path</div>
            <div className={s.kvVal}>{status?.env_path ?? "—"}</div>

            <div className={s.kvKey}>gateway_state</div>
            <div className={s.kvVal}>{status?.gateway_state || "—"}</div>

            <div className={s.kvKey}>gateway_pid</div>
            <div className={s.kvVal}>{status?.gateway_pid ?? "—"}</div>

            <div className={s.kvKey}>active_sessions</div>
            <div className={s.kvVal}>{status?.active_sessions ?? 0}</div>

            <div className={s.kvKey}>model</div>
            <div className={s.kvVal}>{modelInfo?.model ?? "—"}</div>

            <div className={s.kvKey}>build mode</div>
            <div className={s.kvVal}>{import.meta.env.DEV ? "DEV" : "PROD"}</div>
          </div>
        </section>
      </div>
    </div>
  );
}
