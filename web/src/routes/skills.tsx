import { useMemo, useState } from "react";
import { Copy, Folder, Info, Languages, Lock, Package, Plus, RefreshCw, User } from "lucide-react";
import type { SkillInfo } from "@hermes/protocol";
import { useSkills, useToggleSkill } from "@/hooks/use-skills";
import { Pill, Dot } from "@/components/ui/pill";
import {
  categoryTranslations,
  skillTranslations,
  translateCategory,
  translateSkill,
} from "@/lib/skill-translations";
import { TopBarActions } from "@/components/top-bar/top-bar";
import s from "./skills.module.css";

type Tab = "builtin" | "user";
type Filter = "all" | "enabled" | "disabled";
type Lang = "zh" | "en";

/**
 * `/api/skills` 当前不返回 `origin` 字段，且 Hermes 安装的所有 skill 都来自
 * `~/.hermes/skills/`（即"内置"）。这里用前端启发式：以 `user/` 开头的 skill
 * name 视为"自建"，其余视为"内置"。等后端补 `origin` 字段后可以移除此函数。
 */
function isUserSkill(skill: SkillInfo): boolean {
  return skill.name.startsWith("user/");
}

export function SkillsRoute() {
  const { data: skills, isLoading, isFetching, isError, error, refetch } = useSkills();
  const toggleSkill = useToggleSkill();
  const [tab, setTab] = useState<Tab>("builtin");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("zh");

  const { builtin, user } = useMemo(() => {
    const all = skills ?? [];
    return {
      builtin: all.filter((sk) => !isUserSkill(sk)),
      user: all.filter((sk) => isUserSkill(sk)),
    };
  }, [skills]);

  const currentList = tab === "builtin" ? builtin : user;
  const enabledCount = (skills ?? []).filter((sk) => sk.enabled).length;

  // 过滤 + 搜索
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return currentList.filter((sk) => {
      if (filter === "enabled" && !sk.enabled) return false;
      if (filter === "disabled" && sk.enabled) return false;
      if (!q) return true;
      const tr = skillTranslations[sk.name];
      const haystack = [
        sk.name,
        sk.description,
        tr?.displayName ?? "",
        tr?.description ?? "",
        translateCategory(sk.category),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [currentList, filter, search]);

  // 按类目分组
  const grouped = useMemo(() => {
    const map = new Map<string, SkillInfo[]>();
    for (const sk of filtered) {
      const cat = sk.category ?? "other";
      const arr = map.get(cat) ?? [];
      arr.push(sk);
      map.set(cat, arr);
    }
    // 确保 categoryTranslations 里的顺序优先（已知类目按表序，未知类目按字母序）
    const knownOrder = Object.keys(categoryTranslations);
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ai = knownOrder.indexOf(a);
      const bi = knownOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [filtered]);

  // 选中态：默认选第一个
  const selected =
    filtered.find((sk) => sk.name === selectedName) ?? filtered[0] ?? null;

  return (
    <main className={s.page}>
      <div className={s.paneTop} data-window-drag data-tauri-drag-region="deep">
        <span className={s.paneTopTitle}>技能</span>
        <span className={s.paneTopMeta}>
          {skills
            ? `${builtin.length} 个内置 · ${user.length} 个自建 · ${enabledCount} 已启用`
            : isLoading
              ? "加载中…"
              : "—"}
        </span>
        <div className={s.paneTopActions}>
          <button
            className={s.btn}
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw size={13} />
            {isFetching ? "刷新中" : "同步内置"}
          </button>
          <TopBarActions />
        </div>
      </div>

      {/* 顶部 tab：内置 / 我的 */}
      <div className={s.toptabs}>
        <button
          type="button"
          className={s.toptab}
          data-active={tab === "builtin"}
          onClick={() => {
            setTab("builtin");
            setSelectedName(null);
          }}
        >
          <Package size={14} />
          内置 Skills
          <span className={s.toptabCount}>{builtin.length}</span>
        </button>
        <button
          type="button"
          className={s.toptab}
          data-active={tab === "user"}
          onClick={() => {
            setTab("user");
            setSelectedName(null);
          }}
        >
          <User size={14} />
          我的 Skills
          <span className={s.toptabCount}>{user.length}</span>
        </button>
        <span className={s.toptabSpacer} />
        <span className={s.toptabHint}>
          <Info size={13} />
          {tab === "builtin"
            ? "内置 Skill 由 Hermes 团队维护，仅可启用 / 禁用"
            : "自建 Skill 保存在"}
          {tab === "user" && <code>~/.hermes/skills/user/</code>}
        </span>
      </div>

      {/* 主体 */}
      {isLoading ? (
        <div className={s.statePane}>加载中…</div>
      ) : isError ? (
        <div className={s.statePane}>
          技能加载失败：{error instanceof Error ? error.message : "unknown error"}
        </div>
      ) : tab === "user" && user.length === 0 ? (
        <UserEmptyState />
      ) : (
        <div className={s.split}>
          <aside className={s.listSide}>
            <div className={s.listTools}>
              <div className={s.searchInput}>
                <span style={{ opacity: 0.6 }}>⌕</span>
                <input
                  placeholder={
                    tab === "builtin" ? "搜索 Skill 名 / 描述…" : "搜索我的 Skill…"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className={s.seg}>
                <button
                  type="button"
                  data-active={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  全部 {currentList.length}
                </button>
                <button
                  type="button"
                  data-active={filter === "enabled"}
                  onClick={() => setFilter("enabled")}
                >
                  已启用 {currentList.filter((sk) => sk.enabled).length}
                </button>
                <button
                  type="button"
                  data-active={filter === "disabled"}
                  onClick={() => setFilter("disabled")}
                >
                  已禁用 {currentList.filter((sk) => !sk.enabled).length}
                </button>
              </div>
            </div>

            <div className={s.skillsList}>
              {filtered.length === 0 ? (
                <div className={s.statePane}>没有匹配的技能。</div>
              ) : (
                grouped.map(([category, items]) => (
                  <div key={category}>
                    <div className={s.groupHead}>
                      <span className={s.groupHeadCn}>{translateCategory(category)}</span>
                      <span className={s.groupHeadEn}>{category}</span>
                      <span className={s.groupHeadNum}>{items.length}</span>
                    </div>
                    {items.map((sk) => (
                      <SkillRow
                        key={sk.name}
                        skill={sk}
                        active={selected?.name === sk.name}
                        onSelect={() => setSelectedName(sk.name)}
                        onToggle={() =>
                          toggleSkill.mutate({ name: sk.name, enabled: !sk.enabled })
                        }
                        showBuiltinTag={tab === "builtin" && selected?.name === sk.name}
                      />
                    ))}
                  </div>
                ))
              )}

              {tab === "builtin" && filtered.length > 0 && (
                <div className={s.listFooterHint}>
                  共 {filtered.length} 个内置 Skill。未翻译的会显示英文原名。
                </div>
              )}
            </div>
          </aside>

          {selected ? (
            <SkillDetail
              skill={selected}
              tab={tab}
              lang={lang}
              setLang={setLang}
              onToggle={() =>
                toggleSkill.mutate({ name: selected.name, enabled: !selected.enabled })
              }
            />
          ) : (
            <section className={s.detail}>
              <div className={s.detailEmpty}>从左侧选择一个技能查看详情</div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

/* ── Skill 行 ─────────────────────────────────────────────── */

interface SkillRowProps {
  skill: SkillInfo;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  showBuiltinTag: boolean;
}

function SkillRow({ skill, active, onSelect, onToggle, showBuiltinTag }: SkillRowProps) {
  const tr = translateSkill(skill.name, skill.description);
  const isTranslated = skill.name in skillTranslations;

  return (
    <button
      type="button"
      className={s.skillRow}
      data-active={active}
      data-disabled={!skill.enabled}
      onClick={onSelect}
    >
      <div className={s.skillRowHead}>
        <Dot tone={skill.enabled ? "ok" : "neutral"} />
        <span className={s.skillRowName}>{tr.displayName}</span>
        {showBuiltinTag && <span className={`${s.rowTag} ${s.rowTagBuiltin}`}>内置</span>}
        <span style={{ marginLeft: "auto" }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={s.toggle}
            data-on={skill.enabled}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label={skill.enabled ? "禁用" : "启用"}
          />
        </span>
      </div>
      {isTranslated && <div className={s.skillRowNameEn}>{skill.name}</div>}
      <div className={s.skillRowDesc}>{tr.description}</div>
    </button>
  );
}

/* ── 详情面板（内置 / 自建 共用骨架，按 tab 分支渲染） ─────── */

interface SkillDetailProps {
  skill: SkillInfo;
  tab: Tab;
  lang: Lang;
  setLang: (l: Lang) => void;
  onToggle: () => void;
}

function SkillDetail({ skill, tab, lang, setLang, onToggle }: SkillDetailProps) {
  const tr = translateSkill(skill.name, skill.description);
  const isTranslated = skill.name in skillTranslations;
  const cnCategory = translateCategory(skill.category);

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  return (
    <section className={s.detail}>
      <div className={s.detailHead}>
        <div className={s.detailHeadRow1}>
          <h1 className={s.detailHeadTitle}>{tr.displayName}</h1>
          <span className={`${s.rowTag} ${tab === "builtin" ? s.rowTagBuiltin : s.rowTagUser}`}>
            {tab === "builtin" ? "内置" : "自建"}
          </span>
          <div className={s.detailHeadActions}>
            <button
              type="button"
              className={s.btn}
              onClick={() => handleCopy(skill.name)}
              title="复制原文 ID"
            >
              <Copy size={13} />
              复制 ID
            </button>
            <button
              type="button"
              className={s.btn}
              onClick={onToggle}
              title={skill.enabled ? "禁用" : "启用"}
            >
              {skill.enabled ? "禁用" : "启用"}
            </button>
          </div>
        </div>
        {isTranslated && (
          <div className={s.nameEnBig}>
            <span>{skill.name}</span>
            <button
              type="button"
              className={s.nameEnCopy}
              onClick={() => handleCopy(skill.name)}
            >
              复制
            </button>
          </div>
        )}

        <div className={s.detailPills}>
          <Pill tone={skill.enabled ? "ok" : "neutral"}>
            <Dot tone={skill.enabled ? "ok" : "neutral"} />
            {skill.enabled ? "已启用" : "已禁用"}
          </Pill>
          <Pill>类目 · {cnCategory}</Pill>
          {!isTranslated && tab === "builtin" && (
            <Pill tone="warn">未翻译 · 显示英文原文</Pill>
          )}
        </div>

        {tab === "builtin" && (
          <div className={s.readonlyNotice}>
            <Lock size={14} className={s.readonlyLock} />
            <div>
              <strong>这是 Hermes 内置 Skill。</strong>
              只能启用 / 禁用，不能修改。下次执行 <code>同步内置</code> 时会被覆盖。
              如需自定义，请在「我的 Skills」里基于此 Skill 复制一份。
            </div>
          </div>
        )}

        <div className={s.metaRow}>
          <span className={s.metaItem}>
            <span className={s.metaK}>原文 ID</span>
            <span className={s.metaV}>{skill.name}</span>
          </span>
          <span className={s.metaItem}>
            <span className={s.metaK}>类目</span>
            <span className={s.metaV}>{skill.category ?? "other"}</span>
          </span>
          <span className={s.metaItem}>
            <span className={s.metaK}>来源</span>
            <span className={s.metaV}>{tab === "builtin" ? "Hermes 内置" : "用户自建"}</span>
          </span>
        </div>
      </div>

      <div className={s.detailBody}>
        <section className={s.sec}>
          <div className={s.secHead}>
            <h2>说明</h2>
            <div className={s.secHeadRight}>
              {isTranslated && (
                <>
                  <span>由 Hermes 中文社区维护翻译</span>
                  <div className={s.langSeg}>
                    <button
                      type="button"
                      data-active={lang === "zh"}
                      onClick={() => setLang("zh")}
                    >
                      中
                    </button>
                    <button
                      type="button"
                      data-active={lang === "en"}
                      onClick={() => setLang("en")}
                    >
                      EN 原文
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className={s.descriptionCard}>
            {lang === "zh" && isTranslated ? (
              <p>{tr.description}</p>
            ) : (
              <p className={s.descriptionCardOriginal}>{skill.description}</p>
            )}
            <div className={s.descriptionCardFooter}>
              <Languages size={13} />
              {isTranslated
                ? "中文版基于 SKILL.md description 字段翻译。完整 SKILL.md 内容请到来源目录查看。"
                : "此 Skill 暂未翻译，显示上游英文 description。"}
            </div>
          </div>
        </section>

        <section className={s.sec}>
          <div className={s.secHead}>
            <h2>来源目录</h2>
          </div>
          <div className={s.descriptionCard}>
            <p style={{ fontSize: 13, color: "var(--h-text-2)" }}>
              <Folder size={13} style={{ display: "inline", marginRight: 6, verticalAlign: "-2px" }} />
              来源由 Hermes 后端在 <code style={{ fontFamily: "var(--h-font-mono)", background: "var(--h-bg-code)", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>~/.hermes/skills/</code> 与外部目录中扫描得到。
              SKILL.md 全文、触发规则、文件清单等详细信息将在后端补 <code style={{ fontFamily: "var(--h-font-mono)", background: "var(--h-bg-code)", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>/api/skills/{`{name}`}</code> 端点后展示。
            </p>
          </div>
        </section>
      </div>
    </section>
  );
}

/* ── 「我的 Skills」空状态 ─────────────────────────────────── */

function UserEmptyState() {
  return (
    <div className={s.emptyState}>
      <div className={s.emptyStateIcon}>
        <User size={26} />
      </div>
      <h2 className={s.emptyStateTitle}>还没有自建 Skill</h2>
      <p className={s.emptyStateBody}>
        在 Hermes Agent 中沉淀你自己的工作流：写一份 <code>SKILL.md</code>，
        放到 <code>~/.hermes/skills/user/</code> 目录下，
        刷新就会出现在这里。
        <br />
        在线编辑器规划中——目前请通过文件系统手动管理。
      </p>
      <div className={s.emptyStateActions}>
        <button type="button" className={s.btn}>
          <Folder size={13} />
          打开 ~/.hermes/skills/
        </button>
        <button type="button" className={s.btnPrimary}>
          <Plus size={13} />
          基于内置 Skill 复制
        </button>
      </div>
    </div>
  );
}
