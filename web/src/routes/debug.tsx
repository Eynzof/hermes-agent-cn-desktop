import { DebugSection } from "./settings-debug-section";
import s from "./debug.module.css";

export function DebugRoute() {
  return (
    <div className={s.pageWrap}>
      <div className={s.pageContent}>
        <div className={s.hero}>
          <div className={s.num}>
            <span className={s.numTop}>№ 005</span>
            <span>调试</span>
          </div>
          <div>
            <h1 className={s.title}>Debug</h1>
            <div className={s.lead}>前端事件、REST / Gateway 失败、Console 错误与异常捕获。</div>
          </div>
        </div>

        <section className={s.section}>
          <DebugSection showHeading={false} />
        </section>
      </div>
    </div>
  );
}
