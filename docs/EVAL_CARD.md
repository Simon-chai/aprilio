# 评价卡片

面向家长的图文学生评价卡片：把学生指定周期内的成绩 / 表现 / 作业聚合成一张 A 版「暖阳成长卡」HTML 卡片，预览后一键导出 2 倍清晰度 PNG（默认叠加学生姓名水印）。

## 入口与交互

- 入口：学生档案页顶部「评价卡片」按钮（`StudentDetailView.vue`，`data-test="eval-card-btn"`）。
- 弹窗（`components/EvalCardDialog.vue`）：
  - 统计周期：本月 / 上月 / 本学期 / 自定义区间（start ≤ end 校验）；
  - 学生姓名水印开关（默认开）；
  - 老师寄语：默认带出**周期末端所在学期**的学期评语，可手改，接 `AiPolishButton`（scene「学生评价卡片寄语」）；
  - 右侧 iframe 实时预览（zoom 0.5），导出前可整体确认。
- 导出：桌面端走系统「另存为」（默认文件名 `评价卡片-<姓名>-<周期>.png`）+ fs 写文件；浏览器演示态（`isTauri() === false`）退化为浏览器下载。

## 模块分层（改哪层看这里）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 数据聚合 | `src/lib/eval-card.ts` | 周期解析、成绩/行为/作业聚合、星级启发式、视图模型 `EvalCardView`（纯逻辑，可测） |
| 卡片模板 | `src/lib/eval-card-template.ts` | A 版 HTML 模板 + 姓名水印 data-URI SVG（纯函数） |
| 转图 | `src/lib/html-to-png.ts` | 隐藏 iframe → foreignObject → canvas 2x 光栅化，零第三方依赖 |
| 导出编排 | `src/lib/eval-card-export.ts` | PNG Blob → 另存为/浏览器下载 |
| 界面 | `src/components/EvalCardDialog.vue` | 周期选择、水印开关、寄语编辑与润色、预览、导出 |

## 数据口径

- **成绩**：`getStudentScoreReport`（与学生档案「成绩」页、AI 分析同源）；卡片取**周期内最近一次考试**，条形按百分制宽度，总结行给「总分较上次 ±N 分 + 班级排名」，`total_delta` 与排名均为既有口径。
- **行为**：只取 `praise` 记录做亮点（标签 = 维度快照计数 top3，时间线 = 最近 3 条表扬）；**待改进项不上卡**（卡片面向家长，走鼓励导向）。
- **作业**：`summarizeHomeworks` 按时率（= (excellent+done)/(total−exempt)）。
- **星级（启发式，调参改 `computeEvalCardStars`）**：基础 3 星；总排名前 30% +1 / 后 30% −1；表扬 ≥5 次 +1；待改进 ≥3 次 −1；按时率 ≥90% +1 / <60% −1；收敛 1–5 星。文案：4–5 优秀 / 3 良好 / 2 进步中 / 1 继续加油。
- 缺数据的区块整块隐藏（无考试隐藏成绩区、无行为隐藏亮点区、无寄语隐藏寄语区），新学期空数据也能出卡。

## 水印

学生姓名斜向 -18° 平铺，SVG data-URI 背景，透明度 0.08；开关在弹窗控制列。水印层在导出图与预览中一致。

## 转图实现的硬性约束（改模板必读）

`html-to-png.ts` 用 foreignObject 光栅化，**模板必须保持完全自包含**：

- 只用系统字体（PingFang SC / Microsoft YaHei 栈），不引入 web font；
- 图表用纯 CSS（条形 = 渐变 div），不用 canvas / 外链 SVG / `<img>` 外链；
- 样式集中在模板产出的单个 `<style>` 内；
- 所有动态文本经 `esc()` 转义（学生姓名是用户输入）。

算法已在 Chromium（WebView2 同引擎）验证：`mockups/eval-card/harness.html`；真实数据样张见 `mockups/eval-card/real-sample.html` 与 `shot-real-eval-card.png`。样式风格 5 版备选稿同在 `mockups/eval-card/`（a~e），当前实现为 a 版。

## 权限与兼容

- `src-tauri/capabilities/default.json` 新增 `dialog:allow-save` 与 `fs:allow-write-file`（scope `**`，覆盖另存为的任意路径）——首次打包后生效。
- 纯新增功能，无数据结构变更，往前兼容。

## 后续方向

- 班级层批量导出（复用 `aggregateEvalCard` 循环 + 逐生文件名）；
- 其余 4 版样式（b 报告 / c 月报 / d 奖状 / e 极简）作为可选模板接入；
- Agent 工具化（`generate_eval_card`：自然语言出卡）。
