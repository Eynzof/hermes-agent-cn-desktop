# design-preview — Profile 改造 · 桌面保真静态稿

桌面端 Profile 功能改造的**视觉稿**。目标:对齐 App 的真实设计语言,让稿子 1:1 映射 React,
几乎零翻译成本。**这不是 App 的一部分**,不参与构建。

## 怎么看

浏览器直接打开 `profile/index.html`(支持 `file://`),从索引进入四屏。每页右上角可切换明/暗主题。

```
open web/design-preview/profile/index.html      # 或拖进浏览器
```

> 与运行中的 App 对照:在桌面 repo 起 `pnpm web:dev`(:9545,需先 `hermes dashboard --no-open`)。

## 设计基准(为什么这样画)

之前在 `hermes-cn-ui-prototypes-sans` 的稿子用了编辑/杂志风(Fraunces 大斜体、12 栏网格、页边码、
sparkline),已偏离桌面端实现、移植成本高。本目录改为**桌面保真**:

- **复用真实 token**:每个 HTML 直接 `<link>` 真实的 `packages/shared-ui/src/tokens/index.css`(零重复)。
- **镜像真实组件样式**:`preview.css` 逐字镜像各 `*.module.css` 的规则(只用 `--h-*` 与真实 px),
  因为 CSS Module 类名是 hash 的、无法直接引入,所以重声明并加前缀避免 `.row/.nav/.page` 冲突,
  每块都注明对应的真实 `源文件 .类名`。
- **保真红线**:纯无衬线(HarmonyOS Sans + Cascadia mono)、字号 ≤14px、圆角只用 `--h-r-*`、
  小边框按钮、单一柿色 `--h-accent` 强调、状态用 `--h-ok/warn/err` + `Dot`;**无** Fraunces/斜体大标题、
  **无** 12 栏网格/页边码/sparkline;弹窗是居中 560 `Dialog`。

## 四屏 → React 映射(落地指引)

| 稿 | 文件 | 落地到 |
|---|---|---|
| ① 档案列表 + 切换 | `profile/01-profiles-list.html` | `web/src/routes/profiles.tsx` + `components/sidebar/profile-selector.tsx`(补:头像、元数据/用量列、UI 内重命名入口) |
| ② 档案详情与编辑 | `profile/02-profile-detail.html` | 新建 `web/src/routes/profile-detail.tsx` + shared-ui `Dialog`(头像生成/上传、就地重命名、危险区:克隆/导出/导入/删除) |
| ③ 运行时健康 | `profile/03-runtime-health.html` | `web/src/routes/health.tsx` + 新建 `profile-runtime-grid.tsx`(克隆 `components/panel/health-grid.tsx`) |
| ④ 个人中心 | `profile/04-personal-center.html` | `web/src/routes/settings.tsx` 新增 `PersonalCenterSection`(并入设置页,非新大页) |

功能范围沿用 PRD:`../../..` 之外的 `hermes-cn-ui-prototypes-sans/docs/profile-overhaul/PRD.md`
(头像、运行时健康、克隆/导入导出、重命名 + 元数据/用量)。本目录只换**视觉语言**。

## 构建隔离

`web/design-preview/` 在 `web/tsconfig.json` 的 `include` 与 Vite 入口之外,不进 App bundle、
不影响 `pnpm typecheck` / `pnpm test:unit`。可安全保留在仓库里作为设计参考。

## 文件

```
web/design-preview/
  preview.css                  镜像真实 module.css 的样式(带源注释)
  profile/
    index.html                 索引 + 主题切换
    01-profiles-list.html      档案列表 + 切换
    02-profile-detail.html     档案详情与编辑(含 Dialog)
    03-runtime-health.html     运行时健康
    04-personal-center.html    个人中心(设置页内 section)
```
