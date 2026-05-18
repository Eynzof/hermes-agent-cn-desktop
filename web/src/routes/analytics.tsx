import { AnalyticsSection } from "./settings-analytics-section";
import s from "./debug.module.css";

export function AnalyticsRoute() {
  return (
    <div className={s.pageWrap}>
      <div className={s.pageContent}>
        <div className={s.hero}>
          <div className={s.num}>
            <span className={s.numTop}>№ 004</span>
            <span>分析</span>
          </div>
          <div>
            <h1 className={s.title}>数据分析</h1>
            <div className={s.lead}>查看 Token、费用、会话与模型维度的使用趋势。</div>
          </div>
        </div>

        <section className={s.section}>
          <AnalyticsSection showHeading={false} />
        </section>
      </div>
    </div>
  );
}
