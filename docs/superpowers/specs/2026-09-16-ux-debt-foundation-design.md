# 交互基础组件还债设计规范（AppDialog / ConfirmDialog / Toast / 语义色 token / AppIcon）

> 文档状态：设计完成，待评审
> 日期：2026-09-16
> 目标：为「课堂模式」（点名 / 大屏点评 / 座位表 / 小组积分）铺交互基建——弹层、危险确认、轻反馈、语义色、图标五件套统一收敛；同时消除全应用 UI/UX 诊断发现的一致性裂缝。周期两周（10 个工作日），**视觉零回归**（除本文显式声明的 3 处微调）。

---

## 1. 背景与问题盘点

UI/UX 诊断（2026-09-16）发现，拼凑感的根源不是视觉 token（token 使用率很高），而是**基础交互组件层缺失**：

| # | 问题 | 规模（实测） |
| --- | --- | --- |
| 1 | 手写弹层遮罩参数漂移：遮罩色 3 种（`bg-black/30` 主流 / `bg-ink/45 backdrop-blur-sm` / `bg-black/40`）、padding 漂移、`role="dialog"` 仅 2 处、`aria-modal` 仅 1 处、无焦点圈定 | 13 个文件 18 处 `fixed inset-0` |
| 2 | 破坏性确认 5 种模式并存：自绘 modal / Tauri 原生 `confirm()` / `window.confirm` / 行内两步 / 时间轴 armed 两步点击。**同一「删除班级」在 ClassesView 与 ClassDetailView 表现完全不同** | 15 个确认交互点（10 处原生 confirm + 2 处自绘 modal + 3 处行内/armed 两步） |
| 3 | Toast 三份逐字拷贝（`.qb-toast` scoped transition + 相同模板）；SettingsView 用行内文字、MyTimetable 保存静默 | 3 份拷贝 + 2 处不一致 |
| 4 | 表现三态配色游离设计系统：praise/improve/neutral 及分类胶囊色、AI 推荐紫共 9 个未登记色值，在 3 个平行组件硬编码约 30 处；`bg-[#fdeef0]` 错误横幅 11 处（token `danger-soft` 同值）；散点 hex 约 60 处 | 31 个独立 hex 值 |
| 5 | 图标无体系：29 个文件内联 SVG，垃圾桶画 4 遍、chevron 6 处、返回按钮 3 种实现；属性色 `stroke="#1d1d1f"` 不用 `currentColor` | 约 60 处属性色 |

课堂模式必然要弹层（座位表编辑）、要确认（清空积分）、要反馈（+1 动效后落库提示）——先还债，再盖楼。

---

## 2. 目标与非目标

### 目标

1. 新增 5 个基础件：`AppDialog`、`ConfirmDialog`（含命令式 `confirmAction`）、`useToast` + `ToastHost`、语义色 token 家族、`AppIcon`，全部落在 `src/components/ui/` 与 `src/composables/`、`src/style.css`
2. 存量全量迁移：15 处弹层（18 处 `fixed inset-0` 减去 3 处不迁移：GlobalSearch、QuickBehaviorPopover 点击捕获层、TimetableGrid 死代码）、15 个确认交互点、5 处反馈收敛到新组件
3. 新增防退化测试 `tests/design-token-guard.test.ts`，禁止被替换 hex 回潮
4. 回填 `docs/DESIGN_SYSTEM.md`（颜色表、组件规范、弹层/确认/反馈/图标新约定）

### 非目标（明确不做）

- 信息架构重组（侧栏项调整、首页工作台）——课堂模式阶段做
- 大文件拆分（HomeView / ClassDetailView / ExamScorePanel）与死代码处置（TimetableGrid + TimetableCalendar 1677 行，**需单独决策**，本 spec 一律不碰、测试豁免）
- `AppSelect` / `AppTextarea` 表单组件族（后续独立小任务）
- 导入向导三件套的管道级重构（本轮只换弹层壳，向导步骤逻辑不动）
- Agent 聊天内确认门（`confirm: true` 工具拦截 UI，另一套体系，不动）
- 图表视觉重设计（只把硬编码色接到 `chart-palette.ts`，不改样式）
- 页头模式统一、页面底色层级统一（IA 级，下一阶段）

---

## 3. 组件方案

### 3.1 AppDialog —— 统一弹层壳

只做「壳」：遮罩、居中/抽屉容器、Esc、焦点、aria、过渡。内容与底部操作区全走插槽，**迁移时弹窗内容原样搬，`data-test` 全部保留**（存量测试零改动目标）。

**API：**

```ts
// src/components/ui/AppDialog.vue
defineProps<{
  open: boolean;
  title: string;                 // aria-labelledby 自动关联
  description?: string;          // 标题下的弱化说明（可选）
  variant?: "center" | "drawer"; // drawer = 右侧抽屉（MemoHistoryDrawer）
  width?: "sm" | "md" | "lg";    // 440 / 560 / 720px，默认 md；就近归档，差异过大时用 class 透传覆盖
  z?: number;                    // 默认 50；嵌套弹层透传（ImageCropDialog 传 60）
  closeOnOverlay?: boolean;      // 默认 true；导入向导等防误关场景传 false
}>();
defineEmits<{ close: [] }>();
// slots: default（内容）、footer（操作区，可选；ConfirmDialog 之外的业务弹窗自行摆放）
```

**行为规范：**

| 项 | 规则 |
| --- | --- |
| Esc | 只关**栈顶**弹层。模块级 `dialogStack` 记录挂载顺序，keydown 只在自己是栈顶时 emit `close` |
| 焦点圈定 | 打开时记住 `document.activeElement` → 聚焦面板（`tabindex="-1"`）或首个 `[autofocus]` 元素；Tab / Shift+Tab 在弹层内循环；关闭后焦点还原。纯 DOM API 实现，不引依赖 |
| aria | 根节点 `role="dialog"` `aria-modal="true"`，标题 `aria-labelledby` 指向自动生成的 id（`useId`） |
| 过渡 | 遮罩淡入 + 面板上浮 `duration-150`；drawer 右滑入。全局 `prefers-reduced-motion` 降级已由 `style.css` 兜底 |
| 滚动 | 根容器 `overflow-y-hidden` 本就不滚（App.vue:26），**不做滚动锁**；面板内容超高时内部 `scroll-thin`（维持现状） |
| 视觉 | 遮罩统一 `bg-black/30`；面板 `rounded-lg bg-canvas shadow-window`；padding 归一到面板 `p-6`（内容区自定） |

**迁移清单（15 处，12 个文件）：**

| 文件 | 弹窗 | 迁移为 |
| --- | --- | --- |
| SettingsView.vue:445 | AI 添加/编辑模型 | AppDialog `md` |
| ClassesView.vue:601 | 归档班级确认 | ConfirmDialog（见 3.2） |
| ClassesView.vue:623 | 删除班级确认（三按钮） | ConfirmDialog 组件形态 + footer 插槽 |
| BackgroundPickerDialog.vue | 背景选择 | AppDialog `lg` |
| ClassFormDialog.vue | 新建/改名班级 | AppDialog `sm` |
| ExamScorePanel.vue:1106/1152/1198 | 编辑考试 / 改分 / 等级映射 | AppDialog `sm`/`sm`/`md` |
| HomeworkPanel.vue:164 | 作业记录表单 | AppDialog `sm` |
| ImportRosterDialog.vue | 花名册导入向导 | AppDialog `lg`，`closeOnOverlay=false` |
| ImportScoreDialog.vue | 成绩导入向导 | AppDialog `lg`，`closeOnOverlay=false` |
| ImportTimetableDialog.vue | 课表导入向导 | AppDialog `lg`，`closeOnOverlay=false` |
| ImageCropDialog.vue | 图片裁剪 | AppDialog `lg`，`:z="60"` |
| MemoHistoryDrawer.vue | 备忘历史 | AppDialog `variant="drawer"` |
| StudentFormDialog.vue | 学生表单 | AppDialog `md` |

**不迁移（维持现状）：** GlobalSearch（命令面板形态，自管理焦点与键盘导航）、QuickBehaviorPopover 的 `fixed inset-0 z-40`（点击捕获层，非模态）、HomeView 烘焙钟（全屏沉浸层）、AgentChat（悬浮窗）、AnalyzingOverlay（处理遮罩）。

### 3.2 ConfirmDialog + confirmAction —— 破坏性确认唯一模式

**两种形态，一套视觉：**

1. **命令式**（替换全部原生 confirm，日常 90% 场景）：

```ts
// src/composables/useConfirm.ts —— 单例，宿主组件挂载在 App.vue
const ok = await confirmAction({
  title: "删除学生「林知远」",
  message: "删除后将移入回收站，保留 7 天，期间可恢复。",
  tone: "danger",            // default | danger（danger = 确认按钮 variant="danger" + 图标强调）
  confirmText: "删除",       // 默认「确认」
  cancelText: "取消",
});
```

2. **组件形态**（需要自定义操作区的复杂确认，如 ClassesView「删除并重建」第三按钮）：`<ConfirmDialog :open title message tone>` + `footer` 插槽扩展。

**行为规范：**

- 单例防重入：上一个确认未关闭时，再次调用**返回同一个进行中的 Promise**（禁止叠弹）
- 确认按钮 danger tone 下默认文案「删除」，与现有文案对齐
- `Esc` / 遮罩点击 = 取消（resolve false）

**迁移映射（15 个交互点按调用场景归并为 11 行 → 统一模式）：**

| 调用点 | 现状 | 迁移 |
| --- | --- | --- |
| StudentDetailView.vue:179/183/193 | Tauri `confirm` / `window.confirm`（删照片 ×2、删学生） | `confirmAction` danger |
| ClassDetailView.vue:345/373 | Tauri `confirm`（归档/删除班级） | `confirmAction`；**与 ClassesView 同一文案模板** |
| SettingsView.vue:305 | `window.confirm`（清空数据） | `confirmAction` danger |
| RecycleBinView.vue:18 | 封装 `askConfirm` helper | 删 helper，直用 `confirmAction` |
| ExamScorePanel.vue:552 | Tauri `confirm`（删考试） | `confirmAction` danger |
| EvalReportPanel.vue:165 | `window.confirm`（删报告） | `confirmAction` danger |
| HomeworkPanel.vue:116 | `window.confirm`（删作业记录） | `confirmAction` danger |
| ClassesView.vue:601/623 | 自绘 modal ×2 | 命令式（归档）+ 组件形态（删除，三按钮） |
| SettingsView.vue:389 | AI 方案删除行内两步 | `confirmAction` danger（行内模式退役） |
| Student/ClassBehaviorTimeline | armed 两步点击删除 | `confirmAction` danger（armed 模式退役） |
| ProfileView.vue:356 | `onBeforeRouteLeave` 未保存确认 | P3 可选：守卫返回 Promise 走 `confirmAction`；若守卫期间交互体验不佳则保留原生，**实施时验证后定** |

**行为变化声明（评审确认点）：** ①桌面端原生系统对话框全部换成应用内自绘（跨桌面/浏览器双态统一，删除所有 `isTauri ? confirm : window.confirm` 分支）；②AI 方案删除与时间轴删除的行内两步/armed 模式退役，统一弹层确认。

### 3.3 useToast + ToastHost —— 全局轻反馈

```ts
// src/composables/useToast.ts（单例） + src/components/ui/ToastHost.vue（App.vue 挂载，z-[70] 常最高）
import { useToast } from "../composables/useToast";
const toast = useToast();
toast("已保存");                          // 默认 info
toast("已归档", { tone: "success" });
toast("删除失败", { tone: "error" });      // error 默认时长更长
```

| 项 | 规则 |
| --- | --- |
| 视觉 | 沿用现有 qb-toast：顶部居中 pill、`bg-tile` 白字、淡入下移过渡——**零视觉变化** |
| 堆叠 | 同屏最多 3 条纵向堆叠，超出丢弃最旧 |
| 时长 | info/success 2400ms，error 3600ms；`duration` 可覆盖 |
| 层级 | `z-[70]`，高于一切弹层（弹层内操作成功也要可见） |

**迁移点：** ClassDetailView / StudentDetailView / StudentTable 三份 qb-toast 拷贝删除（`data-test="quick-toast"` 移到 ToastHost 条目，存量测试改查 ToastHost）；SettingsView `savedMsg` 行内文字 → toast；MyTimetableView 备忘保存静默 → toast（P3，顺手）。

### 3.4 语义色 token —— @theme 新增与散点归位

**新增 token（值全部沿用现值，除标注外零视觉变化）：**

```css
/* 表现三态（与 schema type 字段 praise/improve/neutral 一一对应） */
--color-praise: #248a3d;        /* 表扬文字/节点，与 success 同源 */
--color-praise-soft: #e8f5e9;
--color-praise-line: #a3e635;   /* 筛选胶囊选中描边 */
--color-improve: #d97706;
--color-improve-soft: #fff3e0;
--color-improve-line: #fcd34d;
--color-neutral: #52525b;
--color-neutral-soft: #f4f4f5;
--color-neutral-line: #d4d4d8;

/* 表现分类胶囊选中色（study 分类沿用 primary，无需新增） */
--color-category-behavior: #059669;
--color-category-other: #7c3aed;

/* AI 生成内容标识（QuickBehaviorPopover 的 AI 推荐评语 chips） */
--color-ai: #6d28d9;
--color-ai-soft: #f5f1ff;
--color-ai-line: #e3d9ff;
--color-ai-hover: #ede4ff;

/* 散点归位 */
--color-ink-deep: #000000;          /* AppButton dark hover */
--color-primary-on-dark-hover: #4da5ff; /* AppLink 深底胶囊 hover */
```

**归位清单（全量 hex → token 映射，31 值 → 0 散点）：**

| 现值（出现次数） | 替换为 | 涉及文件 |
| --- | --- | --- |
| `#fdeef0` (11) | `bg-danger-soft` | StudentDetailView、RecycleBinView、ImportRosterDialog、ImportScoreDialog、ImportTimetableDialog、ExamScorePanel 等 |
| `#e8f5e9`/`#248a3d`/`#a3e635` (5/7/2) | `praise` 家族 | ClassBehaviorTimeline、StudentBehaviorTimeline、QuickBehaviorPopover |
| `#fff3e0`/`#d97706`/`#fcd34d` (4/6/2) | `improve` 家族 | 同上 |
| `#f4f4f5`/`#52525b`/`#d4d4d8`/`#71717a` (4/4/2/2) | `neutral` 家族（`#71717a` 节点点色统一用 `neutral`，微调 ①） | 同上 |
| `#059669`/`#7c3aed` (1/1) | `category-behavior`/`category-other` | ClassBehaviorTimeline |
| `#6d28d9`/`#f5f1ff`/`#e3d9ff`/`#ede4ff` (1×4) | `ai` 家族 | QuickBehaviorPopover |
| `#e8e8ed` (1) | `neutral-soft`（微调 ②） | QuickBehaviorPopover:396 |
| `#e8f5ea` (1) | `tag-positive-soft`（微调 ③，语义 = 正面状态） | StatusChip.vue:10 |
| `#000000` (1) | `ink-deep` | AppButton.vue:24 |
| `#4da5ff` (1) | `primary-on-dark-hover` | AppLink.vue:43 |
| `#0066cc`(15)/`#1d1d1f`(14)/`#333333`(15)/`#7a7a7a`(9)/`#cccccc`(5) | SVG 属性色 → `currentColor` + 文字 token 类（`text-primary`/`text-ink`/`text-muted`/`text-weak`/`text-faint`） | 随 AppIcon 替换消化（见 3.5） |
| `#e5e5e7`/`#a1a1a6` (1/1) | `chart-palette.ts` 新增导出 `CHART_AXIS_LINE`/`CHART_AXIS_TEXT`（canvas 无法读 CSS var，图表色以 palette 为唯一事实源） | ScoreLineChart；ScoreTrendSparkline/SubjectTrendView 中 `#0066cc`/`#7a7a7a` 同步改 import palette |
| `#fff`/`#ffffff`/`#d70015` 等 | 深底图标白 → `currentColor` + `text-white`；`#d70015` → `text-danger` | 随图标替换消化 |

**视觉微调仅 3 处（评审可否决，否决则改为登记独立 token）：** ①时间轴中立节点 `#71717a`→`#52525b`；②快捷记表现中性胶囊底 `#e8e8ed`→`#f4f4f5`；③StatusChip success 底 `#e8f5ea`→`#e7f3ea`。三者色差肉眼难辨。

### 3.5 AppIcon —— 轻量图标注册表

**不引入图标库**（10MB 约束 + 保持现有手绘细线条风格），自建注册表：

```ts
// src/components/ui/icons.ts —— name → svg 内部元素字符串（静态常量，v-html 渲染，无外部输入）
// src/components/ui/AppIcon.vue
<AppIcon name="trash" :size="16" class="text-danger" />
```

| 项 | 规则 |
| --- | --- |
| 渲染约定 | `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.5"`；颜色永远继承文字色，**图标本身不含任何色值** |
| 未知 name | 渲染空 + dev 环境 `console.warn`（不崩溃，对齐 Agent 未知工具兜底原则） |
| 尺寸 | `size` 默认 16，映射 width/height |

**首批图标清单（从重复盘点归纳）：** `trash`（现重复 4 次）、`chevron-left`/`chevron-right`/`chevron-down`（6 处）、`close`、`arrow-left`（返回）、`plus`、`gear`、`podium`（班级，现 2 份）、`photo`、`person`、`home`、`calendar`、`clock`、`more-horiz`（⋯）、`edit`、`archive`、`restore`、`warn`、`check`。

**替换范围：**

- P1 高重复：垃圾桶 ×4 文件、chevron ×6、返回按钮 3 种实现统一（ClassesView 硬编码 `#0066cc` SVG / StudentDetailView 硬编码 `#1d1d1f` SVG → `AppIcon name="arrow-left"`，与 AppLink 现有 back 图标视觉对齐）
- P2 顺带：AppSidebar 全部图标（属性色 → currentColor + token 类，零视觉变化）、EmptyState 内联 SVG、关闭按钮 `✕` 文字形 → `close` 图标
- 其余存量**不强求一次换完**（FeatureIcon 属首页多色插画，豁免）；规则写入 DESIGN_SYSTEM.md：**新代码一律 AppIcon，禁止业务组件内联单色 SVG**

---

## 4. 防退化：design-token-guard

`tests/design-token-guard.test.ts`（对齐 `schema-sync.test.ts` 的对账思路）：

- 扫描 `src/**/*.vue`，断言**禁用 hex 清单**零命中：上表全部被替换值 + token 同值色（`#0066cc` `#1d1d1f` `#333333` `#7a7a7a` `#cccccc` `#248a3d` `#d97706` `#d70015` `#fdeef0` 等 31 项）
- **豁免清单**（显式维护，逐文件注明理由）：`TimetableGrid.vue`、`TimetableCalendar.vue`（死代码待决策）、`FeatureIcon.vue` 与 HomeView 品牌装饰（多色插画）、`lib/chart-palette.ts`（.ts 不在扫描范围，天然豁免）
- 违例输出「文件:行号 + 色值 + 建议 token」，新增 hex 不登记 @theme 就无法过 CI——把 DESIGN_SYSTEM.md 的维护约定从文档变成门禁

---

## 5. 测试计划（TDD，先写失败测试）

| 测试文件 | 用例 |
| --- | --- |
| `tests/app-dialog.test.ts` | open 渲染 + `role="dialog"`/`aria-modal`/标题 id 关联；Esc emit close；遮罩点击关闭；`closeOnOverlay=false` 不关；双弹层嵌套时 Esc 只关栈顶；打开前焦点元素在关闭后还原；footer 插槽透传；drawer variant 类名 |
| `tests/confirm-dialog.test.ts` | danger tone 确认按钮为 danger variant；`confirmAction` resolve true/false；进行中重复调用返回同一 Promise；自定义按钮文案；三按钮组件形态（ClassesView 场景） |
| `tests/toast.test.ts` | push 渲染与 tone 类名；假时钟验证自动消失与 error 时长；上限 3 条淘汰最旧；ToastHost 全局唯一实例 |
| `tests/app-icon.test.ts` | 已知 name 渲染 svg 且 stroke=currentColor；未知 name 空 + warn；size 透传 |
| `tests/design-token-guard.test.ts` | 见第 4 节 |

**存量测试兼容：** ①弹窗内容与 `data-test` 原样迁移（classes-view / class-detail-view / settings-view / import-* 等用例不动）；②原生 confirm 替换点，测试中 `window.confirm` mock 改为 `confirmAction` mock；③`quick-toast` 断言改查 ToastHost。测试适配计入各迁移任务，**不靠删断言转绿**。

---

## 6. 任务拆解与排期（10 个工作日）

| 任务 | 内容 | 天 |
| --- | --- | --- |
| T1 | AppDialog 组件 + dialogStack + 测试 | 1.5 |
| T2 | ConfirmDialog + useConfirm + ToastHost/useToast + 测试（三者共用弹层基建，同批做） | 1.5 |
| T3 | 确认场景迁移：15 个确认交互点 → confirmAction / ConfirmDialog（ProfileView 为 P3 可选） | 1.5 |
| T4 | 弹层迁移：12 个文件 15 处业务弹窗 → AppDialog 壳（data-test 保留） | 2 |
| T5 | @theme token 新增 + 三态/分类/AI/散点归位 + chart-palette 接线 + StatusChip | 1 |
| T6 | AppIcon + icons.ts + P1/P2 图标替换 + 侧栏 currentColor | 1 |
| T7 | design-token-guard + EmptyState 补齐（ClassesView、StudentDetailView 图片 tab）+ 存量测试适配 | 1 |
| T8 | DESIGN_SYSTEM.md 回填（颜色表/组件表/弹层·确认·反馈·图标约定）+ 全量回归 + 缓冲 | 0.5 |

每任务独立可交付，完成即过 `npm run typecheck` + `npm test` 门禁（本次不动 Rust，`cargo check` 免）。

---

## 7. 验收清单

- [ ] `npm run typecheck` 全绿；`npm test` 全绿（新增 5 个测试文件）
- [ ] 全应用任意弹层：Esc 只关顶层；打开后 Tab 焦点圈定、关闭还原；均有 `role="dialog"` + `aria-modal`
- [ ] 破坏性确认唯一模式：任一「删除/归档/清空」入口交互一致，同一操作（删除班级）两入口体验完全相同
- [ ] Toast：三处原拷贝场景 + Settings 保存 + 课表备忘保存，反馈形态一致，`z-[70]` 弹层之上可见
- [ ] `design-token-guard` 零违例；`grep -E '#[0-9a-fA-F]{3,8}'` 扫描 .vue 仅剩豁免清单文件
- [ ] 视觉走查：除声明 3 处微调外零变化（迁移前后截图对照 HomeView / ClassDetailView / SettingsView / 快捷记表现）
- [ ] `docs/DESIGN_SYSTEM.md` 颜色表与组件规范表包含全部新增项

---

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 迁移面广（13 文件 18 弹层 + 11 确认），改坏存量交互 | 弹窗只换壳内容不动；data-test 全保留；T3/T4 各自独立提交，每批全量测试门禁 |
| `confirmAction` 单例在快速连点下重入 | 未决时二次调用复用进行中 Promise，禁止叠弹（测试覆盖） |
| 原生确认 → 自绘是桌面端行为变化（失去系统级阻塞） | 方向已在评审确认；自绘双态统一是收益；实施后人工走查防双击双删 |
| ProfileView 路由守卫 Promise 化有边界（守卫期间 UI 仍可交互） | 列为 P3 可选，实施验证体验，不佳则保留原生并在本文回填决策 |
| `v-html` 渲染图标注册表的安全性 | 注册表全部编译期静态常量，不接收任何外部 SVG 输入；无用户内容注入面 |
| jsdom 无真实布局，焦点圈定测试受限 | 实现限定为标准 DOM API（activeElement / keydown），用例只断言可测行为，不做视觉断言 |
| 图表 canvas 读不到 CSS var | 图表色不进 @theme，`chart-palette.ts` 为图表侧唯一事实源（维持现有先例） |

---

## 9. 后续（移出本次，防止范围蔓延）

- 信息架构重组（侧栏 5 项 → 首页/班级/课表与日程/照片/设置；回收站降级）→ 课堂模式阶段一并做
- TimetableGrid / TimetableCalendar 死代码决策（恢复班级课表编辑 or 删除）→ 单独议题，座位表网格交互可参考其实现
- `AppSelect` / `AppTextarea` / 表单类串收敛 → 独立小任务
- 大文件拆分（HomeView 1139 / ClassDetailView 1054 / ExamScorePanel 1289）→ 课堂模式前哨任务
