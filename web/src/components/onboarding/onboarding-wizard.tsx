import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Settings2, Sparkles, CheckCircle2, AlertTriangle, XCircle, ArrowRight, ArrowLeft, ExternalLink } from "lucide-react";
import { useModelInfo } from "@/hooks/use-config";
import type { EnvironmentCheckResult, ConfigMigrationScanResult } from "@hermes/protocol";
import s from "./onboarding-wizard.module.css";

const SKIP_KEY = "hermes-onboarding-skipped";

function getSkipState(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === "true";
  } catch {
    return false;
  }
}

function setSkipState() {
  try {
    localStorage.setItem(SKIP_KEY, "true");
  } catch { /* ignore */ }
}

export function OnboardingWizard() {
  const navigate = useNavigate();
  const { data: modelInfo, isLoading: modelLoading } = useModelInfo();
  const configured = Boolean(modelInfo?.model?.trim() && modelInfo?.provider?.trim());

  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(() => getSkipState());

  // Step 1 state
  const [envCheck, setEnvCheck] = useState<EnvironmentCheckResult | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);

  // Step 2 state
  const [migrationScan, setMigrationScan] = useState<ConfigMigrationScanResult | null>(null);
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const hasEnvAPI = typeof window !== "undefined" && window.hermesDesktop?.environmentCheck;
  const hasMigrationAPI = typeof window !== "undefined" && window.hermesDesktop?.scanConfigMigration;

  const hasCandidates = migrationScan && migrationScan.candidates && migrationScan.candidates.length > 0;

  const runEnvCheck = useCallback(async () => {
    if (envCheck || !hasEnvAPI) return;
    setEnvLoading(true);
    setEnvError(null);
    try {
      const result = await window.hermesDesktop!.environmentCheck();
      setEnvCheck(result);
    } catch (e) {
      setEnvError(e instanceof Error ? e.message : "环境检测失败");
    } finally {
      setEnvLoading(false);
    }
  }, [envCheck, hasEnvAPI]);

  const runMigrationScan = useCallback(async () => {
    if (migrationScan || !hasMigrationAPI) return;
    setMigrationLoading(true);
    setMigrationError(null);
    try {
      const result = await window.hermesDesktop!.scanConfigMigration();
      setMigrationScan(result);
    } catch (e) {
      setMigrationError(e instanceof Error ? e.message : "配置扫描失败");
    } finally {
      setMigrationLoading(false);
    }
  }, [migrationScan, hasMigrationAPI]);

  // Auto-run environment check on step 1
  useEffect(() => {
    if (step === 0) runEnvCheck();
  }, [step, runEnvCheck]);

  // Auto-run migration scan on step 2
  useEffect(() => {
    if (step === 1) runMigrationScan();
  }, [step, runMigrationScan]);

  // Re-check dismissed state when model becomes configured
  useEffect(() => {
    if (!configured) return;
    try { localStorage.removeItem(SKIP_KEY); } catch { /* ignore */ }
    setDismissed(false);
  }, [configured]);

  const skip = () => {
    setSkipState();
    setDismissed(true);
  };

  const next = () => setStep((s) => Math.min(s + 1, 3));
  const prev = () => setStep((s) => Math.max(s - 1, 0));

  const goModels = () => navigate("/models#provider-deepseek");
  const goMigration = () => navigate("/config-migration");

  const envErrors = envCheck?.items?.filter((i) => i.status === "Error" || i.status === "error") ?? [];
  const envWarnings = envCheck?.items?.filter((i) => i.status === "Warning" || i.status === "warning") ?? [];
  const envOk = envCheck?.items?.filter((i) => i.status === "Ok" || i.status === "ok") ?? [];

  // Don't show if model is loading, already configured, or dismissed
  if (modelLoading || configured || dismissed) return null;

  return (
    <div className={s.backdrop} role="presentation">
      <div className={s.card} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        {/* Step indicators */}
        <div className={s.steps}>
          {["环境检测", "配置发现", "模型配置", "完成"].map((label, i) => (
            <div key={label} className={i === step ? s.stepActive : i < step ? s.stepDone : s.stepPending}>
              <span className={s.stepDot}>{i < step ? <CheckCircle2 size={14} /> : i + 1}</span>
              <span className={s.stepLabel}>{label}</span>
            </div>
          ))}
        </div>

        {/* Step 1: Environment check */}
        {step === 0 && (
          <>
            <h2 id="onboarding-title">检测本机环境</h2>
            <p className={s.desc}>检查桌面端运行环境是否满足 Hermes Agent 的要求。</p>
            <div className={s.content}>
              {envLoading && <p className={s.loading}>正在检测…</p>}
              {envError && <p className={s.error}><XCircle size={14} /> {envError}</p>}
              {envCheck && (
                <div className={s.results}>
                  {envErrors.length > 0 && (
                    <div className={s.group}>
                      <div className={s.groupTitle}><XCircle size={14} className={s.iconErr} /> 需要修复 ({envErrors.length})</div>
                      {envErrors.map((item) => (
                        <div key={item.id} className={s.item}>
                          <span>{item.label}</span>
                          {item.recommendation && <span className={s.hint}>{item.recommendation}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {envWarnings.length > 0 && (
                    <div className={s.group}>
                      <div className={s.groupTitle}><AlertTriangle size={14} className={s.iconWarn} /> 建议检查 ({envWarnings.length})</div>
                      {envWarnings.map((item) => (
                        <div key={item.id} className={s.item}>
                          <span>{item.label}</span>
                          {item.summary && <span className={s.hint}>{item.summary}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {envOk.length > 0 && (
                    <div className={s.group}>
                      <div className={s.groupTitle}><CheckCircle2 size={14} className={s.iconOk} /> 正常 ({envOk.length})</div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className={s.actions}>
              <button type="button" className={s.secondary} onClick={skip}>跳过设置</button>
              <button type="button" className={s.primary} onClick={next} disabled={envLoading}>
                下一步 <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}

        {/* Step 2: Config discovery */}
        {step === 1 && (
          <>
            <h2>发现已有配置</h2>
            <p className={s.desc}>检测到本机已安装 Hermes，可一键迁移配置到桌面端。</p>
            <div className={s.content}>
              {migrationLoading && <p className={s.loading}>正在扫描…</p>}
              {migrationError && <p className={s.error}><XCircle size={14} /> {migrationError}</p>}
              {migrationScan && !hasCandidates && (
                <div className={s.empty}>
                  <CheckCircle2 size={20} className={s.iconOk} />
                  <p>未发现已有 Hermes 配置，可以全新开始。</p>
                </div>
              )}
              {hasCandidates && (
                <div className={s.results}>
                  <p className={s.info}>桌面端使用<strong>独立的 hermes-home</strong>，与现有 CLI / 终端版并存、不冲突。</p>
                  {migrationScan.candidates.map((c, i) => (
                    <div key={c.id || i} className={s.candidate}>
                      <div className={s.candidatePath}>{c.path}</div>
                      <div className={s.tags}>
                        {c.hasConfig && <span className={s.tag}>config.yaml</span>}
                        {c.hasEnv && <span className={s.tag}>.env</span>}
                        {c.hasAuth && <span className={s.tag}>auth</span>}
                        {c.hasSkills && <span className={s.tag}>skills</span>}
                        {c.hasMemories && <span className={s.tag}>memories</span>}
                      </div>
                    </div>
                  ))}
                  {migrationScan.warnings?.map((w, i) => (
                    <p key={i} className={s.warn}><AlertTriangle size={12} /> {w}</p>
                  ))}
                </div>
              )}
            </div>
            <div className={s.actions}>
              <button type="button" className={s.secondary} onClick={prev}><ArrowLeft size={14} /> 上一步</button>
              <button type="button" className={s.secondary} onClick={skip}>跳过设置</button>
              {hasCandidates ? (
                <button type="button" className={s.primary} onClick={goMigration}>
                  迁移已有配置 <ExternalLink size={13} />
                </button>
              ) : (
                <button type="button" className={s.primary} onClick={next}>
                  全新开始 <ArrowRight size={14} />
                </button>
              )}
            </div>
          </>
        )}

        {/* Step 3: Model config */}
        {step === 2 && (
          <>
            <div className={s.iconWrap} aria-hidden="true"><Sparkles size={22} /></div>
            <h2>配置模型 API Key</h2>
            <p className={s.desc}>
              请进入模型页选择服务商，粘贴 API Key，保存后设为当前模型。
            </p>
            <div className={s.stepsList}>
              <span><KeyRound size={13} /> 填写 API Key</span>
              <span><Settings2 size={13} /> 保存配置</span>
              <span><Sparkles size={13} /> 设为当前模型</span>
            </div>
            <div className={s.actions}>
              <button type="button" className={s.secondary} onClick={prev}><ArrowLeft size={14} /> 上一步</button>
              <button type="button" className={s.secondary} onClick={skip}>稍后再说</button>
              <button type="button" className={s.primary} onClick={goModels} autoFocus>进入模型页</button>
            </div>
          </>
        )}

        {/* Step 4: Summary */}
        {step === 3 && (
          <>
            <div className={s.iconWrap} aria-hidden="true"><CheckCircle2 size={22} /></div>
            <h2>设置完成</h2>
            <p className={s.desc}>
              环境检测通过，模型已就绪。可以开始使用 Hermes Agent 了。
            </p>
            {envCheck && (
              <div className={s.summary}>
                <div className={s.summaryRow}>
                  <span>环境检测</span>
                  <span className={envErrors.length > 0 ? s.badgeWarn : s.badgeOk}>
                    {envErrors.length > 0 ? `${envErrors.length} 项需修复` : "通过"}
                  </span>
                </div>
                {modelInfo?.model && (
                  <div className={s.summaryRow}>
                    <span>当前模型</span>
                    <span className={s.badgeOk}>{modelInfo.model}</span>
                  </div>
                )}
              </div>
            )}
            <div className={s.actions}>
              <button type="button" className={s.primary} onClick={skip} autoFocus>开始使用</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
