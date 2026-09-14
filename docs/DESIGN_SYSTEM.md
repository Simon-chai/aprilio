# 设计系统

aprilio 的视觉规范与 token 约定。**唯一事实源是 `src/style.css` 的 `@theme`**；本文只解释规则与用法，不再维护应用内展示页。改样式先看这里，再改 token。

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

### 侧边导航「提起感」（专属例外）

`AppSidebar` 选中项不使用方案 C 皮肤：整行 `origin-left scale-[1.04] -translate-x-0.5 -translate-y-0.5` + `shadow-[0_4px_12px_rgba(29,29,31,0.10)]`，像被从导航里轻轻拎起；浅影只属于这个提起瞬间。

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
