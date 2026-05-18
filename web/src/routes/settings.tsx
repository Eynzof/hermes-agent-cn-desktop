import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useAtom } from "jotai";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, FolderOpen, RefreshCw } from "lucide-react";
import { useTheme, type ThemeConfig } from "@hermes/shared-ui";
import { useConfig, useConfigSchema, useSaveConfig } from "@/hooks/use-config";
import { useSkills, useToggleSkill } from "@/hooks/use-skills";
import { useCronJobs, useCreateCronJob, useDeleteCronJob, useCronAction } from "@/hooks/use-cron";
import { useLogs } from "@/hooks/use-logs";
import { useStatus } from "@/hooks/use-status";
import {
  useCheckRuntimeUpdate,
  useInstallRuntimeUpdate,
  useRollbackRuntime,
  useRuntimeInfo,
} from "@/hooks/use-runtime-update";
import { showReasoningAtom } from "@/stores/ui";
import { postJSON } from "@/lib/transport";
import { TopBarActions } from "@/components/top-bar/top-bar";
import type { ConfigSchemaField, RuntimeInfo, RuntimeUpdateCheckResult } from "@hermes/protocol";
import s from "./settings.module.css";

type Section = "general" | "config" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "常规" },
  { id: "config", label: "配置" },
  { id: "about", label: "关于" },
];

export function SettingsRoute() {
  const [section, setSection] = useState<Section>("general");
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const returnTarget = from && !from.startsWith("/settings") ? from : "/";

  return (
    <div className={s.page}>
      <div className={s.settingsTopBar} data-window-drag data-tauri-drag-region="deep">
        <button
          className={s.settingsBackIconButton}
          aria-label="返回对话"
          title="返回对话"
          onClick={() => navigate(returnTarget)}
        >
          <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <span className={s.settingsTitle}>设置</span>
        <span className={s.settingsTopBarSpacer} />
        <div className={s.settingsTopBarActions}>
          <TopBarActions />
        </div>
      </div>
      <div className={s.layout}>
        <nav className={s.nav}>
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              className={s.navItem}
              data-active={sec.id === section}
              onClick={() => setSection(sec.id)}
            >
              {sec.label}
            </button>
          ))}
        </nav>
        <div className={s.content}>
          {section === "general" && <GeneralSection />}
          {section === "config" && <ConfigSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

/* ── General ─────────────────────────────────────────────────────────── */

function GeneralSection() {
  const { config, update } = useTheme();
  const [showReasoning, setShowReasoning] = useAtom(showReasoningAtom);

  return (
    <div>
      <h2 className={s.heading}>常规</h2>
      <Row label="主题" right={
        <RadioGroup value={config.theme} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} onChange={(v) => update({ theme: v as ThemeConfig["theme"] })} />
      } />
      <Row label="信息密度" right={
        <RadioGroup value={config.density} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }]} onChange={(v) => update({ density: v as ThemeConfig["density"] })} />
      } />
      <Row label="显示推理过程" sub="在会话中展示模型的思考和推理内容" right={
        <RadioGroup value={showReasoning ? "on" : "off"} options={[{ value: "off", label: "隐藏" }, { value: "on", label: "显示" }]} onChange={(v) => setShowReasoning(v === "on")} />
      } />
    </div>
  );
}

/* ── Config (Full Config Editor — maps to /api/config) ──────────────── */

const CATEGORY_CN: Record<string, string> = {
  general: "常规", agent: "Agent", terminal: "终端", display: "显示",
  delegation: "委派", memory: "记忆", compression: "压缩", security: "安全",
  browser: "浏览器", voice: "语音", tts: "TTS", stt: "STT",
  logging: "日志记录", discord: "Discord", auxiliary: "辅助",
};

function ConfigSection() {
  const { data: config } = useConfig();
  const { data: schema } = useConfigSchema();
  const saveConfig = useSaveConfig();
  const [activeCategory, setActiveCategory] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const categories = useMemo(() => {
    if (!schema) return [];
    return schema.category_order.length > 0
      ? schema.category_order
      : [...new Set(Object.values(schema.fields).map((f) => f.category))];
  }, [schema]);

  const categoryCounts = useMemo(() => {
    if (!schema) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const f of Object.values(schema.fields)) {
      counts[f.category] = (counts[f.category] || 0) + 1;
    }
    return counts;
  }, [schema]);

  useEffect(() => {
    if (categories.length > 0 && !activeCategory) setActiveCategory(categories[0]);
  }, [categories, activeCategory]);

  if (!config || !schema) return <div className={s.desc}>加载中…</div>;

  const isSearching = searchQuery.trim().length > 0;
  const lowerSearch = searchQuery.toLowerCase();

  const displayFields = isSearching
    ? Object.entries(schema.fields).filter(([key, f]) => {
        const label = key.split(".").pop()?.replace(/_/g, " ") ?? key;
        return key.toLowerCase().includes(lowerSearch)
          || label.toLowerCase().includes(lowerSearch)
          || f.description.toLowerCase().includes(lowerSearch)
          || (CATEGORY_CN[f.category] ?? f.category).toLowerCase().includes(lowerSearch);
      })
    : Object.entries(schema.fields).filter(([, f]) => f.category === activeCategory);

  return (
    <div>
      <h2 className={s.heading}>配置</h2>
      <p className={s.desc}>
        Hermes Agent 全部 {Object.keys(schema.fields).length} 个配置项，
        共 {categories.length} 个分类。修改后点击字段旁的"保存"按钮生效。
      </p>

      <div style={{ marginBottom: 12 }}>
        <input className={s.fieldInput} placeholder="搜索配置项…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      </div>

      {!isSearching && (
        <div className={s.configTabs}>
          {categories.map((cat) => (
            <button key={cat} className={s.configTab} data-active={cat === activeCategory} onClick={() => setActiveCategory(cat)}>
              {CATEGORY_CN[cat] ?? cat}
              <span className={s.configTabCount}>{categoryCounts[cat] || 0}</span>
            </button>
          ))}
        </div>
      )}

      {isSearching && (
        <div className={s.modelsLabel}>搜索结果: {displayFields.length} 项</div>
      )}

      <div style={{ marginTop: 8 }}>
        {displayFields.map(([key, field]) => (
          <ConfigFieldRow
            key={key}
            fieldKey={key}
            field={field}
            value={getNestedValue(config, key)}
            onSave={(val) => saveConfig.mutate(buildConfigUpdate(key, val))}
            showCategory={isSearching}
          />
        ))}
        {displayFields.length === 0 && (
          <div className={s.desc}>{isSearching ? `未找到匹配 "${searchQuery}" 的配置项。` : "此分类下暂无配置项。"}</div>
        )}
      </div>
    </div>
  );
}

/* ── Skills ───────────────────────────────────────────────────────────── */

export function SkillsSection() {
  const { data: skills, isLoading, isFetching, isError, error, refetch } = useSkills();
  const toggleSkill = useToggleSkill();
  const [filter, setFilter] = useState("");
  const refreshButton = (
    <button className={s.btn} type="button" onClick={() => void refetch()} disabled={isFetching}>
      <RefreshCw size={13} />
      {isFetching ? "刷新中" : "刷新"}
    </button>
  );

  if (isLoading) return <div className={s.desc}>加载中…</div>;
  if (isError) {
    const message = error instanceof Error ? error.message : "unknown error";
    return (
      <div>
        <div className={s.sectionTitleRow}>{refreshButton}</div>
        <p className={s.desc}>技能加载失败：{message}</p>
      </div>
    );
  }
  if (!skills) return null;

  const filtered = filter
    ? skills.filter((sk) => sk.name.includes(filter) || sk.description.includes(filter) || (sk.category ?? "").includes(filter))
    : skills;

  const grouped = groupBy(filtered, (sk) => sk.category ?? "other");

  return (
    <div>
      <div className={s.sectionTitleRow}>{refreshButton}</div>
      <p className={s.desc}>{skills.length} 个可用技能。启用/禁用后立即生效。</p>
      <div style={{ marginBottom: 16 }}>
        <input className={s.fieldInput} placeholder="搜索技能…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {skills.length === 0 && <div className={s.desc}>未发现已安装技能。后端当前返回 0 项，请检查 Hermes home 的 skills 同步。</div>}
      {skills.length > 0 && filtered.length === 0 && <div className={s.desc}>没有匹配的技能。</div>}
      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} style={{ marginBottom: 16 }}>
          <div className={s.modelsLabel}>{category} ({items.length})</div>
          {items.map((sk) => (
            <div key={sk.name} className={s.row}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>{sk.name}</div>
                <div className={s.rowSub}>{sk.description}</div>
              </div>
              <div className={s.rowRight}>
                <button className={s.toggle} data-on={sk.enabled} onClick={() => toggleSkill.mutate({ name: sk.name, enabled: !sk.enabled })}>
                  <span className={s.toggleThumb} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Cron Jobs ───────────────────────────────────────────────────────── */

export function CronSection() {
  const { data: jobs, isLoading } = useCronJobs();
  const createJob = useCreateCronJob();
  const deleteJob = useDeleteCronJob();
  const cronAction = useCronAction();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSchedule, setNewSchedule] = useState("");
  const [newPrompt, setNewPrompt] = useState("");

  const handleCreate = () => {
    if (!newSchedule || !newPrompt) return;
    createJob.mutate({ name: newName || undefined, schedule: newSchedule, prompt: newPrompt });
    setShowNew(false);
    setNewName("");
    setNewSchedule("");
    setNewPrompt("");
  };

  return (
    <div>
      <p className={s.desc}>Agent 会按计划自动执行这些任务。</p>
      {isLoading && <div className={s.desc}>加载中…</div>}
      {jobs && jobs.length === 0 && !showNew && <div className={s.desc}>暂无定时任务。</div>}
      {jobs?.map((job) => (
        <div key={job.id} className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>{job.name || job.id}</div>
            <div className={s.rowSub}>{job.schedule} · {job.prompt?.slice(0, 60)}</div>
          </div>
          <div className={s.rowRight} style={{ gap: 6 }}>
            <span className={s.statusBadge} data-on={job.enabled}>{job.enabled ? "启用" : "暂停"}</span>
            <button className={s.btn} onClick={() => cronAction.mutate({ id: job.id, action: job.enabled ? "pause" : "resume" })}>
              {job.enabled ? "暂停" : "恢复"}
            </button>
            <button className={s.btn} onClick={() => cronAction.mutate({ id: job.id, action: "trigger" })}>触发</button>
            <button className={s.btnDanger} onClick={() => deleteJob.mutate(job.id)}>删除</button>
          </div>
        </div>
      ))}
      {showNew ? (
        <div className={s.providerDetail} style={{ marginTop: 12 }}>
          <FieldRow label="名称（可选）" value={newName} onChange={setNewName} />
          <FieldRow label="Cron 表达式" value={newSchedule} onChange={setNewSchedule} placeholder="0 9 * * *" />
          <FieldRow label="Prompt" value={newPrompt} onChange={setNewPrompt} placeholder="每天执行的任务描述…" />
          <div className={s.providerActions}>
            <button className={s.btnPrimary} onClick={handleCreate}>创建</button>
            <button className={s.btn} onClick={() => setShowNew(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className={s.btnPrimary} style={{ marginTop: 12 }} onClick={() => setShowNew(true)}>＋ 新建定时任务</button>
      )}
    </div>
  );
}

/* ── Logs ─────────────────────────────────────────────────────────────── */

const LOG_FILES = ["agent", "errors", "gateway"] as const;
const LOG_LEVELS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR"] as const;
const LOG_COMPONENTS = ["all", "gateway", "agent", "tools", "cli", "cron"] as const;
const LOG_LINE_COUNTS = [50, 100, 200, 500] as const;

function classifyLine(line: string): "error" | "warning" | "debug" | "info" {
  const upper = line.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("CRITICAL") || upper.includes("FATAL")) return "error";
  if (upper.includes("WARNING") || upper.includes("WARN")) return "warning";
  if (upper.includes("DEBUG")) return "debug";
  return "info";
}

export function LogsSection() {
  const [file, setFile] = useState<string>("agent");
  const [level, setLevel] = useState<string>("ALL");
  const [component, setComponent] = useState<string>("all");
  const [lineCount, setLineCount] = useState<number>(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, refetch } = useLogs(file, lineCount, level, component);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => refetch(), 5000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  useEffect(() => {
    if (data && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div>
      <div className={s.filterBar}>
        <FilterGroup label="文件">
          {LOG_FILES.map((f) => (
            <button key={f} className={s.segmentBtn} data-active={f === file} onClick={() => setFile(f)}>{f}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="级别">
          {LOG_LEVELS.map((l) => (
            <button key={l} className={s.segmentBtn} data-active={l === level} onClick={() => setLevel(l)}>{l}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="组件">
          {LOG_COMPONENTS.map((c) => (
            <button key={c} className={s.segmentBtn} data-active={c === component} onClick={() => setComponent(c)}>{c}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="行数">
          {LOG_LINE_COUNTS.map((n) => (
            <button key={n} className={s.segmentBtn} data-active={n === lineCount} onClick={() => setLineCount(n)}>{n}</button>
          ))}
        </FilterGroup>
      </div>

      <div className={s.logToolbar}>
        <label className={s.autoRefreshLabel}>
          <button className={s.toggle} data-on={autoRefresh} onClick={() => setAutoRefresh(!autoRefresh)}>
            <span className={s.toggleThumb} />
          </button>
          <span>自动刷新</span>
          {autoRefresh && <span className={s.liveDot} />}
        </label>
        <button className={s.btn} onClick={() => refetch()} disabled={isLoading}>
          {isLoading ? "加载中…" : "刷新"}
        </button>
      </div>

      <div className={s.logBlock} ref={scrollRef} style={{ maxHeight: "calc(100vh - 340px)", minHeight: 300 }}>
        {data?.lines.map((line, i) => {
          const cls = classifyLine(line);
          return <div key={i} className={`${s.logLine} ${s[`logLine_${cls}`] ?? ""}`}>{line}</div>;
        })}
        {data && data.lines.length === 0 && <div className={s.logLine}>（无日志）</div>}
        {!data && isLoading && <div className={s.logLine}>加载中…</div>}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={s.filterGroup}>
      <span className={s.filterLabel}>{label}</span>
      <div className={s.segmented}>{children}</div>
    </div>
  );
}

/* ── About ───────────────────────────────────────────────────────────── */

function AboutSection() {
  const { data: status } = useStatus();
  const runtimeInfo = useRuntimeInfo();
  const checkRuntimeUpdate = useCheckRuntimeUpdate();
  const installRuntimeUpdate = useInstallRuntimeUpdate();
  const rollbackRuntime = useRollbackRuntime();
  const [restarting, setRestarting] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [aboutMessage, setAboutMessage] = useState("");

  const handleRestart = async () => {
    setRestarting(true);
    try { await postJSON("/api/gateway/restart", {}); }
    finally { setTimeout(() => setRestarting(false), 3000); }
  };

  const handleCheckRuntime = async () => {
    setRuntimeMessage("");
    const result = await checkRuntimeUpdate.mutateAsync();
    setRuntimeMessage(formatRuntimeUpdateResult(result));
  };

  const handleInstallRuntime = async () => {
    setRuntimeMessage("");
    const result = await installRuntimeUpdate.mutateAsync();
    setRuntimeMessage(result.ok
      ? `已切换到 runtime ${result.installed?.version ?? ""}`.trim()
      : result.error ?? "runtime 更新失败");
  };

  const handleRollbackRuntime = async () => {
    setRuntimeMessage("");
    const result = await rollbackRuntime.mutateAsync();
    setRuntimeMessage(result.ok
      ? `已回滚到 runtime ${result.installed?.version ?? ""}`.trim()
      : result.error ?? "runtime 回滚失败");
  };

  const info = runtimeInfo.data;
  const hermesHomePath = status?.hermes_home;
  const runtimeRootPath = info?.current?.path ?? info?.runtimeRoot;
  const updateResult = checkRuntimeUpdate.data;
  const installing = installRuntimeUpdate.isPending;
  const checking = checkRuntimeUpdate.isPending;
  const rollingBack = rollbackRuntime.isPending;
  const hasRuntimeBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.getRuntimeInfo);
  const canInstall = Boolean(updateResult?.ok && updateResult.updateAvailable && info?.updatesConfigured);

  const handleOpenRuntimeRoot = async () => {
    if (!runtimeRootPath || !window.hermesDesktop?.openWorkspacePath) return;
    setRuntimeMessage("");
    const result = await window.hermesDesktop.openWorkspacePath({ path: runtimeRootPath });
    if (!result.ok) {
      setRuntimeMessage(result.body || "打开内置 Hermes 根目录失败");
    }
  };

  const handleOpenHermesHome = async () => {
    if (!hermesHomePath || !window.hermesDesktop?.openWorkspacePath) return;
    setAboutMessage("");
    const result = await window.hermesDesktop.openWorkspacePath({ path: hermesHomePath });
    if (!result.ok) {
      setAboutMessage(result.body || "打开 HERMES_HOME 失败");
    }
  };

  return (
    <div>
      <h2 className={s.heading}>关于</h2>
      <div className={s.aboutText}>
        <div><b>Hermes Agent</b> · {status?.version ?? "…"} ({status?.release_date ?? ""})</div>
        <div>Gateway: {status?.gateway_state ?? "unknown"} {status?.gateway_pid ? `(PID ${status.gateway_pid})` : ""}</div>
        <div>活跃会话: {status?.active_sessions ?? 0}</div>
        <div>HERMES_HOME: {hermesHomePath ?? "…"}</div>
        {status?.gateway_platforms && Object.entries(status.gateway_platforms).map(([name, plat]) => (
          <div key={name}>平台: {name} — {plat.state}</div>
        ))}
      </div>
      <div className={s.providerActions} style={{ marginTop: 16 }}>
        <button
          className={s.btn}
          type="button"
          onClick={handleOpenHermesHome}
          disabled={!hermesHomePath || !window.hermesDesktop?.openWorkspacePath}
        >
          <FolderOpen size={13} />
          打开 HERMES_HOME
        </button>
        <button className={s.btnPrimary} onClick={handleRestart} disabled={restarting}>
          {restarting ? "重启中…" : "重启 Gateway"}
        </button>
      </div>
      {aboutMessage && <div className={s.runtimeMessage} data-tone="error">{aboutMessage}</div>}

      {hasRuntimeBridge && (
        <div className={s.runtimePanel}>
          <div className={s.sectionTitleRow}>
            <h3 className={s.runtimeHeading}>内置 Hermes Runtime</h3>
            <span className={s.statusBadge} data-on={info?.mode === "managed"}>
              {info ? runtimeModeLabel(info.mode) : "读取中"}
            </span>
          </div>
          <div className={s.runtimeGrid}>
            <RuntimeField label="版本" value={info?.current?.version ?? "未安装"} />
            <RuntimeField label="来源" value={info?.current?.source ?? info?.mode ?? "unknown"} />
            <RuntimeField label="平台" value={info ? `${info.platform}-${info.arch}` : "…"} />
            <RuntimeField label="上游提交" value={shortCommit(info?.current?.upstreamCommit)} />
            <RuntimeField label="更新源" value={info?.updatesConfigured ? "已配置" : "未配置"} />
            <RuntimeField label="运行目录" value={info?.current?.path ?? info?.runtimeRoot ?? "…"} mono />
          </div>
          {info?.lastError && <div className={s.runtimeMessage} data-tone="error">{info.lastError}</div>}
          {runtimeMessage && (
            <div className={s.runtimeMessage} data-tone={runtimeMessage.includes("失败") ? "error" : "normal"}>
              {runtimeMessage}
            </div>
          )}
          <div className={s.providerActions}>
            <button
              className={s.btn}
              type="button"
              onClick={handleOpenRuntimeRoot}
              disabled={!runtimeRootPath || !window.hermesDesktop?.openWorkspacePath}
            >
              <FolderOpen size={13} />
              打开内置 Hermes 根目录
            </button>
            <button
              className={s.btn}
              type="button"
              onClick={handleCheckRuntime}
              disabled={!info?.updatesConfigured || checking}
            >
              <RefreshCw size={13} />
              {checking ? "检查中" : "检查更新"}
            </button>
            <button
              className={s.btnPrimary}
              type="button"
              onClick={handleInstallRuntime}
              disabled={!canInstall || installing}
            >
              {installing ? "安装中…" : "安装更新"}
            </button>
            <button
              className={s.btn}
              type="button"
              onClick={handleRollbackRuntime}
              disabled={!info?.current?.previousVersion || rollingBack}
            >
              {rollingBack ? "回滚中…" : "回滚 Runtime"}
            </button>
          </div>
          {!info?.updatesConfigured && (
            <p className={s.desc}>
              桌面端未配置 runtime 更新 manifest 或公钥，当前只能使用安装包内置版本。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimeField({ label, value, mono }: { label: string; value: string | undefined; mono?: boolean }) {
  return (
    <div className={s.runtimeField}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{value || "—"}</b>
    </div>
  );
}

function runtimeModeLabel(mode: RuntimeInfo["mode"]): string {
  switch (mode) {
    case "managed": return "托管运行";
    case "dev-command": return "开发命令";
    case "dev-source": return "源码模式";
    case "path-fallback": return "PATH 回退";
    case "missing": return "未找到";
  }
}

function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : "";
}

function formatRuntimeUpdateResult(result: RuntimeUpdateCheckResult): string {
  if (!result.ok) return result.error ?? "runtime 更新检查失败";
  if (!result.updateAvailable) return `已是最新版本 ${result.currentVersion ?? ""}`.trim();
  return `发现新 runtime ${result.manifest?.version ?? ""}`.trim();
}

/* ── Shared Components ───────────────────────────────────────────────── */

function Row({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowLeft}>
        <div className={s.rowLabel}>{label}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      <div className={s.rowRight}>{right}</div>
    </div>
  );
}

function RadioGroup({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className={s.radioGroup}>
      {options.map((o) => (
        <button key={o.value} className={s.radioBtn} data-active={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function ConfigFieldRow({ fieldKey, field, value, onSave, showCategory }: {
  fieldKey: string; field: ConfigSchemaField; value: any; onSave: (val: any) => void; showCategory?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(String(value ?? ""));

  const handleSave = () => {
    let parsed: any = localVal;
    if (field.type === "number") parsed = Number(localVal);
    if (field.type === "boolean") parsed = localVal === "true";
    onSave(parsed);
    setEditing(false);
  };

  const label = field.description || fieldKey;

  if (field.type === "select" && field.options) {
    return (
      <Row
        label={label}
        sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
        right={<select className={s.select} value={String(value ?? "")} onChange={(e) => onSave(e.target.value)}>{field.options.map((o) => <option key={o} value={o}>{o || "(默认)"}</option>)}</select>}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <Row
        label={label}
        sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
        right={<button className={s.toggle} data-on={!!value} onClick={() => onSave(!value)}><span className={s.toggleThumb} /></button>}
      />
    );
  }

  return (
    <Row
      label={label}
      sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
      right={editing ? (
        <div style={{ display: "flex", gap: 6 }}>
          <input className={s.input} data-mono value={localVal} onChange={(e) => setLocalVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()} autoFocus style={{ width: 200 }} />
          <button className={s.btnPrimary} onClick={handleSave}>保存</button>
          <button className={s.btn} onClick={() => setEditing(false)}>取消</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--h-font-mono)", fontSize: 12, color: "var(--h-text-2)" }}>{value != null ? String(value) : "—"}</span>
          <button className={s.btn} onClick={() => { setLocalVal(String(value ?? "")); setEditing(true); }}>编辑</button>
        </div>
      )}
    />
  );
}

function FieldRow({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className={s.fieldRow}>
      <div className={s.fieldLabel}>{label}</div>
      <input className={s.fieldInput} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

/* ── Utilities ───────────────────────────────────────────────────────── */

function getNestedValue(obj: any, path: string): any {
  if (!obj) return undefined;
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function buildConfigUpdate(key: string, value: any): Record<string, any> {
  const parts = key.split(".");
  if (parts.length === 1) return { [key]: value };
  const root: any = {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}
