# 设计系统

aprilio 的视觉规范与 token 约定。**唯一事实源是 `src/style.css` 的 `@theme`**；本文只解释规则与用法，不再维护应用内展示页。改样式先看这里，再改 token。

## 一句话原则

单一强调色 Action Blue，层级靠底色分层与 1px 发丝线表达，不靠阴影和重色块。

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

**全站只有两处投影**，卡片、按钮、文字一律不加：

| Token | 值 | 用途 |
| --- | --- | --- |
| `shadow-photo` | `3px 5px 30px rgba(0,0,0,.22)` | 图片 |
| `shadow-window` | `0 24px 60px -12px rgba(0,0,0,.18)` | 窗口 / 浮层 |

层级靠底色切换（`canvas` / `parchment` / `tile`）与 1px 发丝线表达，而不是阴影。

## 组件规范

统一走 `src/components/ui/`，禁止在业务里手搓原生未样式化控件。

| 组件 | 变体 / 要点 |
| --- | --- |
| `AppButton` | `primary`（实底主操作）/ `secondary`（描边）/ `pearl` / `dark` / `danger` / `link` |
| `AppLink` | `variant="chip"` = 跳转胶囊（默认）；`variant="action"` = 原地动作轻文字；`tone` 处理深色底与危险色 |
| `AppInput` | `variant="search"`（胶囊）/ `variant="field"`（方角） |
| `AppCard` | 18px 圆角 + 发丝线，不加阴影 |
| `AppIconButton` | 图标按钮，自带 tooltip |
| `StatusChip` | `info` / `neutral` / `success` 状态胶囊 |
| `EmptyState` | 空态占位 |

## 动效

- 交互反馈克制：`duration-150`，`active:scale-[0.95~0.99]`
- 全站遵循 `prefers-reduced-motion`：动画与过渡自动降级（见 `style.css` 尾部）
- 深色玻璃浮层统一用 `glass-dark` utility，不要各写各的 `backdrop-filter`

## 维护约定

- 新增颜色 / 字号 / 圆角 / 阴影 **只加到 `src/style.css` 的 `@theme`**，并同步更新本表
- 不新增第二强调色；确需语义色时优先复用 `success` / `danger` 或新增带语义命名的 token
- 不给卡片、按钮、文字加阴影
- 深浅底切换用 token，不写死 `#fff` / `#000`
