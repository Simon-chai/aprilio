# 设计系统

aprilio 的视觉规范与 token 约定。**token 唯一事实源是 `src/style.css` 的 `@theme`**（图表色例外：canvas 读不到 CSS var，唯一事实源为 `src/lib/chart-palette.ts`，见「图表色」小节）；本文只解释规则与用法，不再维护应用内展示页。改样式先看这里，再改 token。

## 一句话原则

单一强调色 Action Blue，层级靠底色分层与 1px 发丝线表达，不靠阴影和重色块。可操作语义用**渐变能量线**常显（见下节），不依赖悬浮。

## 校园气质（氛围色）

面向校园场景，清新感由**偏白、低饱和的绿**表达，而不是引入第二个强调色：

- 交互强调仍然只有 Action Blue 一种；绿只做氛围底色，绝不用于按钮实底、链接、选中态
- 氛围渐变统一为「白 → `mint`」：极淡、自上而下，如班级管理页快捷操作图标按钮的 `bg-gradient-to-b from-white to-mint`，hover 时整体收拢为 `mint`
- 表达「成功 / 正面」语义时仍走已有的 `success` / `tag-positive*`，不要用氛围绿顶替语义色
- 氛围色只允许沿绿色系在 `mint` 附近加深 / 减淡；新增色值必须登记到 `src/style.css` 的 `@theme` 与下方「底色分层」表

## 颜色

### 强调色（唯一的交互色）

| Token | 值 | 用途 |
| --- | --- | --- |
| `primary` | `#0066cc` | 唯一的交互色：主按钮、链接、选中态、今天列描边 |
| `primary-focus` | `#0071e3` | hover / focus 提亮 |
| `primary-on-dark` | `#2997ff` | **仅**深色底上的链接与强调 |
| `primary-soft` | `#eaf3fc` | 浅蓝标签底、悬浮胶囊底 |

### 文本灰阶

| Token | 值 | 用途 |
| --- | --- | --- |
| `ink` | `#1d1d1f` | 标题 / 正文 |
| `muted` | `#333333` | 次要正文 |
| `weak` | `#7a7a7a` | 弱化文本 / 占位符 |
| `faint` | `#cccccc` | 分隔点 / 禁用 |

### 底色分层

| Token | 值 | 用途 |
| --- | --- | --- |
| `canvas` | `#ffffff` | 内容底 |
| `parchment` | `#f5f5f7` | 侧栏 / 顶栏 |
| `pearl` | `#fafafc` | 表头 / 次级按钮底 |
| `mint` | `#e8f5ec` | 校园清新绿氛围底：白 → `mint` 淡渐变的落点，不做交互强调 |
| `chalkboard` | `#1d3b32` | 课堂模式沉浸底主色（黑板绿 = `mint` 的深色落点，绿色系同一脉） |
| `chalkboard-deep` | `#112620` | 课堂模式沉浸底纵深落点（`.classroom-immersive` 渐变下部） |
| `praise-on-dark` | `#4ec26f` | 沉浸底（黑板绿）上的表扬数字 / 状态字（比 `praise` 亮） |
| `improve-on-dark` | `#f0a63e` | 沉浸底（黑板绿）上的待改进数字 / 状态字（比 `improve` 亮） |
| `tile` | `#272729` | 深色块 / tooltip |

### 线条与语义色

| Token | 值 | 用途 |
| --- | --- | --- |
| `hairline` | `#e0e0e0` | 1px 边框（发丝线） |
| `divider` | `#f0f0f0` | 行分隔线 |
| `success` | `#248a3d` | 成功 / 已连接 |
| `danger` | `#d70015` | 删除 / 告警 |
| `danger-soft` | `#fdeef0` | 危险操作悬浮底 |

监护人风格标签（情感倾向，判定逻辑见 `src/lib/guardian-tags.ts`）：`tag-positive` / `tag-positive-soft`、`tag-negative` / `tag-negative-soft`。

### 表现三态（praise / improve / neutral）

与表现记录 schema 的 `type` 字段（`praise` / `improve` / `neutral`）一一对应，用于行为时间轴节点、筛选胶囊与统计着色：

| Token | 值 | 用途 |
| --- | --- | --- |
| `praise` | `#248a3d` | 表扬文字 / 节点（与 `success` 同源） |
| `praise-soft` | `#e8f5e9` | 表扬胶囊底 |
| `praise-line` | `#a3e635` | 表扬筛选胶囊选中描边 |
| `improve` | `#d97706` | 待改进文字 / 节点 |
| `improve-soft` | `#fff3e0` | 待改进胶囊底 |
| `improve-line` | `#fcd34d` | 待改进筛选胶囊选中描边 |
| `neutral` | `#52525b` | 中立文字 / 节点 |
| `neutral-soft` | `#f4f4f5` | 中立胶囊底 |
| `neutral-line` | `#d4d4d8` | 中立筛选胶囊选中描边 |

### 表现分类胶囊

表现记录分类筛选胶囊的选中色。`study`（学习）分类沿用 `primary`，无需单独 token：

| Token | 值 | 用途 |
| --- | --- | --- |
| `category-behavior` | `#059669` | 行为习惯分类胶囊选中 |
| `category-other` | `#7c3aed` | 其他分类胶囊选中 |

### AI 生成内容标识

AI 生成 / 推荐内容（如快捷记表现的 AI 推荐评语 chips）的标识色，用于与人工内容区分：

| Token | 值 | 用途 |
| --- | --- | --- |
| `ai` | `#6d28d9` | AI 标识文字 |
| `ai-soft` | `#f5f1ff` | AI 胶囊底 |
| `ai-line` | `#e3d9ff` | AI 胶囊描边 |
| `ai-hover` | `#ede4ff` | AI 胶囊 hover 底 |

### 散点归位

原先硬编码在组件里的色值已登记为 token（值沿用原值）：

| Token | 值 | 用途 |
| --- | --- | --- |
| `ink-deep` | `#000000` | `AppButton` dark variant 的 hover 底 |
| `primary-on-dark-hover` | `#4da5ff` | `AppLink` 深色底胶囊 hover |

### 图表色（不进 @theme）

canvas 绘制的图表**读不到 CSS 变量**，图表配色不登记在 `@theme`，图表侧唯一事实源是 `src/lib/chart-palette.ts`：

| 导出 | 值 | 用途 |
| --- | --- | --- |
| `CHART_PALETTE` | 8 色序列（`#0066cc` 起） | 各科目折线 / 柱状图颜色，同一科目跨图表一致 |
| `CHART_PRIMARY` | `#0066cc` | 图表主色（选中参考线 / 走势线），与 `--color-primary` 同值 |
| `CHART_AXIS_LINE` | `#e5e5e7` | 坐标轴网格线 |
| `CHART_AXIS_TEXT` | `#a1a1a6` | 坐标轴次要文字 |
| `CHART_TEXT_WEAK` | `#7a7a7a` | 图表弱化文字（纵轴刻度 / 参照线），与 `--color-weak` 同值 |

改图表配色只改 `chart-palette.ts`；`CHART_PRIMARY` / `CHART_TEXT_WEAK` 与 `@theme` 同值的项，改 `@theme` 时要同步改这里。

### 渐变能量线（可操作语义层）

方案 C（详见 [docs/interaction-style-proposal.html](interaction-style-proposal.html)，2026-09 采纳）：主色沿自身色系提亮做微渐变，让「能点」在静止状态下就被识别。**不引入第二强调色**。

| Token | 值 | 用途 |
| --- | --- | --- |
| `--grad-primary` | `linear-gradient(135deg,#0066cc,#0091ff)` | 主按钮渐变实底（叠在 `bg-primary` 之上）、Tab 能量线 |
| `--grad-border-primary` | `rgba(0,102,204,.65) → rgba(0,145,255,.45)` | 渐变描边：次级按钮 / 图标按钮 / 跳转胶囊 |
| `--grad-border-danger` | `rgba(215,0,21,.55) → rgba(255,90,60,.4)` | 危险操作渐变描边 |

工具类（`src/style.css` @layer utilities）：`grad-border`（白底填充）、`grad-border-soft`（`primary-soft` 填充，组内选中态）、`grad-border-danger`、`btn-grad`（主按钮渐变）、`tab-energy`（Tab 底部渐变指示线，按钮需 `-mb-px` 贴住容器 `border-b`）、`metric-energy`（概览卡顶部渐变细线）。

选中态语言：**Tab 用能量线，分段/筛选胶囊用 `grad-border-soft`，一律不再用 `bg-ink` 黑底**。侧边导航例外：选中项用「提起感」（见组件规范）。

## 字体

字体族 `font-sans`：Inter → system-ui → PingFang SC / Microsoft YaHei。字号 token 自带行高与字距，**负字距是这套视觉的灵魂**，不要手动覆盖。

| Token | 字号 / 行高 / 字距 | 用途 |
| --- | --- | --- |
| `text-mega` | 56 / 1.1 / -1.2px | 首页问候语 |
| `text-hero` | 40 / 1.1 / -0.4px | 首屏大标题 |
| `text-display` | 34 / 1.25 / -0.37px | 页面级标题 |
| `text-stat` | 28 / 1.1 / -0.3px | 数字统计 |
| `text-airy` | 24 / 1.5 / +0.2px | 首页格言等轻量长句 |
| `text-tagline` | 21 / 1.3 / +0.23px | 卡片标题 / 区块标题 |
| `text-body` | 17 / 1.47 / -0.37px | 正文（比常见 16px 高一档，更从容） |
| `text-caption` | 14 / 1.43 / -0.22px | 表格、按钮、次要说明 |
| `text-fine` | 12 / 1.3 / -0.12px | 标签、时间戳、脚注 |

## 圆角

| Token | 值 | 语义 |
| --- | --- | --- |
| `rounded-sm` | 8px | 缩略图、输入、小控件 |
| `rounded-md` | 11px | 图标按钮、中等容器 |
| `rounded-lg` | 18px | 卡片 |
| `rounded-pill` | 9999px | 主操作按钮、胶囊标签 |

## 阴影

全站投影分三类，卡片、文字一律不加：

| Token | 值 | 用途 |
| --- | --- | --- |
| `shadow-photo` | `3px 5px 30px rgba(0,0,0,.22)` | 图片 |
| `shadow-window` | `0 24px 60px -12px rgba(0,0,0,.18)` | 窗口 / 浮层 |
| `shadow-glow` / `shadow-halo(-danger)` | 渐变按钮光晕 / 描边元素光环 | **仅 hover 反馈**（方案 C），不做层级表达 |

层级靠底色切换（`canvas` / `parchment` / `tile`）与 1px 发丝线表达，而不是阴影。

## 窄窗口策略（小屏不竖排、不隐藏）

窗口变窄时**一律横向滚动，不压缩、不换行、不隐藏**——字段和操作按钮永远要能查看与点击。参考实现：`StudentTable.vue`（表格）、`StudentDetailView.vue`（页头 + 内容兜底）。

- **外壳兜底**：`App.vue` 主内容保底 `min-w-[880px]`，根容器 `overflow-x-auto`，侧栏 `sticky left-0` 常驻
- **表格/矩阵**：单元格 `whitespace-nowrap`，容器 `overflow-x-auto`（需要时加 `min-w-[...]` 撑出列宽），禁止 `overflow-hidden` 裁切、禁止小屏隐藏列
- **结构性行**（页头、工具栏、卡片头、筛选条、统计条）：容器 `flex items-center ... overflow-x-auto`（配 `scrollbar-none`），子项 `shrink-0 whitespace-nowrap`，**不用 `flex-wrap`**
- **标签云 / 图例 / 表单字段组**（弹窗内、卡片内容里）：允许换行，不属于本条约束
- 断点类（`sm:` `lg:`）只允许整卡重排（如指标卡 1→2→4 列），不允许隐藏字段或操作

## 组件规范

统一走 `src/components/ui/`，禁止在业务里手搓原生未样式化控件。

| 组件 | 变体 / 要点 |
| --- | --- |
| `AppButton` | `primary`（渐变实底 + hover 光晕上浮）/ `secondary`（渐变描边胶囊）/ `pearl`（渐变描边方角）/ `dark` / `danger`（红渐变描边）/ `link` |
| `AppLink` | `variant="chip"` = 跳转胶囊（默认；primary/danger 为渐变描边）；`variant="action"` = 原地动作轻文字；`tone` 处理深色底与危险色 |
| `AppInput` | `variant="search"`（胶囊）/ `variant="field"`（方角） |
| `AppCard` | 18px 圆角 + 发丝线，不加阴影 |
| `AppIconButton` | 渐变描边图标按钮；`show-label` 升级为「图标+文字」胶囊；`tone="danger"`；`size="sm"` 卡片行内小号。极低频操作（一个对象生命周期约一次，如班级归档/删除）优先收进「⋯」溢出菜单，不与标题争空间 |
| `StatusChip` | `info` / `neutral` / `success` 状态胶囊 |
| `EmptyState` | 空态占位 |
| `AppDialog` | 统一弹层壳（详见下文「交互基建四件套」）：`variant="center"/"drawer"`、`width="sm"/"md"/"lg"`（440/560/720）、Esc 只关栈顶、焦点圈定 |
| `ConfirmDialog` | 破坏性确认·组件形态：`tone="danger"` 红确认按钮，`footer` 插槽放自定义按钮组（如 ClassesView 三按钮）；日常场景用命令式 `confirmAction` |
| `confirmAction` | 破坏性确认·命令式（`composables/useConfirm.ts`）：`await confirmAction({ ... }) → boolean`，宿主 `ConfirmHost` 已挂 `App.vue` |
| `useToast` + `ToastHost` | 全局轻反馈唯一模式：`toast("已保存")`，顶部居中、`z-[70]` 高于一切弹层 |
| `AppIcon` | 轻量图标注册表（不引图标库）：`<AppIcon name="trash" :size="16" />`，`currentColor` 继承文字色 |

### 侧边导航「提起感」（专属例外）

`AppSidebar` 选中项不使用方案 C 皮肤：整行 `origin-left scale-[1.04] -translate-x-0.5 -translate-y-0.5` + `shadow-[0_4px_12px_rgba(29,29,31,0.10)]`，像被从导航里轻轻拎起；浅影只属于这个提起瞬间。

### 交互基建四件套（弹层 / 确认 / 反馈 / 图标）

2026-09 交互还债引入（设计文档：[docs/superpowers/specs/2026-09-16-ux-debt-foundation-design.md](superpowers/specs/2026-09-16-ux-debt-foundation-design.md)）。核心原则：**弹层、确认、反馈、图标各自只有一种模式**，业务组件不再手搓。

#### AppDialog —— 弹层唯一壳

只做「壳」：遮罩、居中 / 抽屉容器、Esc、焦点圈定、aria、过渡。内容与底部操作区全走插槽，迁移弹窗时内容原样搬、`data-test` 全保留。

| 项 | 规则 |
| --- | --- |
| Props | `open`；`title`（面板自带 `h2`，`aria-labelledby` 自动关联）；`description?` 标题下弱化说明；`variant` `"center" \| "drawer"`（默认 center，drawer = 右侧全高抽屉）；`width` `"sm" \| "md" \| "lg"` = 440 / 560 / 720px（默认 md）；`z` 默认 50，嵌套弹层透传抬高（如图片裁剪传 60）；`closeOnOverlay` 默认 true，导入向导等防误关场景传 false |
| Emit | `close`（Esc / 遮罩 / 业务触发的统一出口） |
| 插槽与透传 | `default` 内容、`footer` 操作区（可选）；`$attrs`（class / `data-test`）落在面板上 |
| 遮罩 | 统一 `bg-black/30`，`mousedown` 即关（比 click 跟手，不误触拖拽释放） |
| Esc | 只关**栈顶**：模块级 `dialogStack` 记录挂载顺序，非栈顶不响应 |
| 焦点圈定 | 打开时记住 `activeElement` → 聚焦面板（或首个 `[autofocus]`）；Tab / Shift+Tab 在面板内循环；关闭还原。纯 DOM API，不引依赖 |

#### ConfirmDialog + confirmAction —— 破坏性确认唯一模式

两种形态、一套视觉，按需选用：

- **命令式 `confirmAction`**（日常 90% 场景，替换全部原生 confirm）：`const ok = await confirmAction({ title, message?, tone?, confirmText?, cancelText? })`，resolve `true` = 确认、`false` = 取消。宿主 `ConfirmHost` 已挂 `App.vue`，业务侧只管调用；回车 = 确认（对齐原生 confirm 的键盘习惯）；未决期间重复调用返回**同一个进行中的 Promise**，禁止叠弹
- **组件形态 `<ConfirmDialog>`**：需要自定义操作区的复杂确认（如 ClassesView「删除并重建」三按钮）。props：`open` / `title` / `message?` / `tone` / `confirmText?` / `cancelText?`；emit `confirm` / `cancel`；`footer` 插槽放自定义按钮组

| 项 | 规则 |
| --- | --- |
| `tone` | `"default" \| "danger"`；danger = 确认按钮 danger variant + warn 图标强调，确认文案默认「删除」（default 默认「确认」） |
| 取消路径 | Esc / 遮罩点击一律映射为 `cancel`（命令式 resolve `false`） |

#### useToast + ToastHost —— 轻反馈唯一模式

`const toast = useToast(); toast("已保存"); toast("删除失败", { tone: "error" })`。宿主 `ToastHost` 已挂 `App.vue`。

| 项 | 规则 |
| --- | --- |
| tone | `info` / `success` / `error`，默认 info |
| 时长 | info / success 2400ms、error 3600ms（保证读得完）；`duration` 可覆盖 |
| 堆叠 | 同屏最多 3 条纵向堆叠，超出丢弃最旧 |
| 层级与视觉 | 顶部居中、`z-[70]` 高于一切弹层（弹层内操作成功也可见）；`bg-tile` 白字 pill、淡入下移过渡 |

#### AppIcon —— 图标唯一入口

轻量图标注册表，**不引图标库**（保持现有手绘细线条风格）：`<AppIcon name="trash" :size="16" class="text-danger" />`。

- `stroke="currentColor"` 永远继承文字色，**组件本身零色值**；需要变色在使用处加 `text-*` token 类
- `size` 默认 16；统一 24×24 网格、`stroke-width="1.5"`（个别图标按来源保留原粗细）
- 未知 name 渲染空 + dev 环境 `console.warn`，不崩溃
- 首批 20 个 name：`trash` / `chevron-left` / `chevron-right` / `chevron-down` / `close` / `arrow-left` / `plus` / `gear` / `podium` / `photo` / `person` / `home` / `calendar` / `clock` / `more-horiz` / `edit` / `archive` / `restore` / `warn` / `check`
- 新增图标在 `src/components/ui/icons.ts` 登记静态常量；注册表全部为编译期常量、不接收任何外部 SVG 输入，`v-html` 渲染安全

### 交互模式唯一约定

| 场景 | 唯一模式 | 禁止（与例外） |
| --- | --- | --- |
| 弹层 | `AppDialog` | 业务里自绘 `fixed inset-0` 遮罩 / 自管理 Esc。非模态例外维持现状：GlobalSearch（命令面板）、QuickBehaviorPopover 点击捕获层、HomeView 沉浸层、AgentChat 悬浮窗、AnalyzingOverlay 处理遮罩 |
| 破坏性确认 | `confirmAction`（复杂操作区用 `ConfirmDialog` 组件形态） | `window.confirm` / Tauri 原生 `confirm`（含 `isTauri ? ... : ...` 双态分支）/ 行内两步确认 / armed 两步点击 |
| 轻反馈 | `useToast` → `ToastHost` | 业务组件自绘 toast（原 qb-toast 拷贝已全数退役）、行内文字反馈、静默成功 |
| 图标 | `AppIcon` | 业务组件内联单色 SVG；`FeatureIcon` 等多色插画豁免 |

## 动效

- 交互反馈克制：`duration-150`，`active:scale-[0.95~0.99]`
- 全站遵循 `prefers-reduced-motion`：动画与过渡自动降级（见 `style.css` 尾部）
- 深色玻璃浮层统一用 `glass-dark` utility，不要各写各的 `backdrop-filter`

## 维护约定

- 新增颜色 / 字号 / 圆角 / 阴影 / 渐变 **只加到 `src/style.css` 的 `@theme`**，并同步更新本表
- 不新增第二强调色；确需语义色时优先复用 `success` / `danger` 或新增带语义命名的 token
- 不给卡片、按钮、文字加静态阴影；`shadow-glow` / `shadow-halo` 仅限 hover 反馈
- 深浅底切换用 token，不写死 `#fff` / `#000`
- 可操作元素必须常显可点信号（渐变描边 / 图标+文字），**「悬浮才出现」只允许作为熟练用户的快捷路径补充**

### 防退化门禁（design-token-guard）

`tests/design-token-guard.test.ts` 把颜色约定从文档变成门禁：

- 扫描 `src/**/*.vue`，断言除豁免清单外**零 hex 色值**
- 新增颜色的流程：先登记 `src/style.css` 的 `@theme`（并同步更新本表），再使用类名——不登记直接写 hex 无法过 CI
- 违例输出「文件:行号 + 色值 + 建议 token」，按提示归位即可
- 豁免清单显式维护，逐文件注明理由：
  - `TimetableGrid.vue` / `TimetableCalendar.vue` —— 死代码待决策（处置是单独议题，暂不迁移）
  - `FeatureIcon.vue` 与 HomeView 品牌装饰 —— 多色插画，非 token 化对象
  - `src/lib/chart-palette.ts` —— `.ts` 不在扫描范围，图表色以它为唯一事实源（见「图表色」小节）
