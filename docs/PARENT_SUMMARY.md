# 家校沟通总结

按**指定时段内**的学生评价，生成给家长看的孩子表现总结（家校沟通用语）。
**单个学生的生成与个性化重写在学生档案页，一键批量生成在班级层**，
生成结果可一键应用到学生档案（写入学期评语）。生成动作由 Agent 框架管理，可自然语言发起。

> 相关：[AGENT.md](AGENT.md)（工具扩展）· [PROMPT_MANAGEMENT.md](PROMPT_MANAGEMENT.md)（提示词模块）·
> [SEMESTER_MANAGEMENT.md](SEMESTER_MANAGEMENT.md)（学期口径）· [EVAL_REPORT.md](EVAL_REPORT.md)（长报告，本功能是家长向短总结）

## 功能边界

| 场景 | 与既有功能的关系 |
| --- | --- |
| 学期评语 | 学生档案里每生每学期一条（≤200 字）。家校沟通总结「应用到档案」的落点就是它 |
| 评价报告 | 学生详情页的长 markdown 报告（存档/打印）。家校沟通总结是家长向的短总结，不存档 |
| 本功能 | 时段灵活（学期或自定义区间）、面向家长、支持个性化要求多轮重写 |

## 落点与入口

| 层 | 界面 | 能力 |
| --- | --- | --- |
| 学生档案（单个） | 学生详情「家校沟通」页签（`ParentSummaryPanel.vue`） | 生成 / 补充个性化要求重新生成（聊天式多轮重写）/ 应用到档案 / 复制 / 手动填写 |
| 班级层（批量） | 班级详情学生条目工具栏按钮 → 批量对话框（`ParentSummaryBatchDialog.vue`，全局唯一实例挂 `App.vue`） | 选时段一键全班逐个生成、进度可见、逐个查看 / 复制 / 应用、跳学生档案精修 |
| Agent（任意页面） | 工具 `generate_parent_summary` | 单生 → 自动跳学生档案「家校沟通」页签并开始生成；全班 → 打开批量对话框 |

两个 UI 由同一套底层支撑（时段聚合 `lib/parent-summary.ts` + AI 层 `lib/parent-summary-ai.ts`），
发起预设统一走 `composables/useParentSummary.ts`（模块级单例，同 useToast 先例）：
批量对话框读「打开参数」，学生档案面板按序号消费「预设」（消费后即清，避免重复自动生成）。

## 学生档案「家校沟通」页签（ParentSummaryPanel.vue）

- **时间范围**：按学期（默认跟学生详情顶部的学期选择）/ 自定义起止日期，口径同评价报告面板；
- **生成**：一键生成首版；**补充个性化要求重新生成**（聊天式）——线程区展示「要求 → 总结」各轮记录，
  最后一版总结可直接编辑；输入要求回车或点「重新生成」在**同一线程**上续写（此前的要求持续生效），
  留空则按既有要求重写一版；线程为空（失败回滚后）按当前素材 + 新要求重建。
- **应用到档案**：确认后写入该生对应学期的**学期评语**（已有评语明确提示覆盖不可恢复）；
  来源标记口径同学期评语面板：AI 生成且未被手改 → `ai`，手填 / 手改 → `manual`。
  目标学期：学期模式写该学期；自定义模式按**起始日期**推导。
- **无 AI 不阻塞**：未配置模型 / 生成失败时可手动填写后应用；一键复制。
- 切换学生（路由换 id）自动重置草稿；Agent 预设到达时自动定位本页签并开始生成。

## 班级批量对话框（ParentSummaryBatchDialog.vue）

- **范围**：按学期 / 自定义（同上）；切换范围作废全部草稿（素材口径变了）。
- **一键全班生成**：对名单内尚未生成的学生**顺序逐个**生成（避免并发限流），进度 `n/N`，
  左侧名单实时出现「生成中 / 已生成 / 失败」；失败项可就地重试；生成中关闭会询问是否停止。
- **逐个查看 / 应用**：右侧展示当前学生的总结（可手改），复制或「应用到档案」（同上语义）；
  「到学生档案补充要求重新生成 →」跳转该生档案「家校沟通」页签做个性化重写。
- 重开同一班级保留草稿，换班或切范围才清空；草稿是会话内态，应用后随学期评语持久保存。

## 数据与素材

- 素材 = 该生时段内的表现评价流水（`student_behavior_records`），按倾向分组拼给模型：
  `buildParentSummaryMaterial`（每组带条数、正文每组最多 8 条，比 comment-ai 的界面摘要版给模型更多信息）。
- 不新建数据库表、不改既有存储格式（纯新增功能，向前兼容）。
- 隐私：仅把该生时段内的评价统计与评语文本发给用户自己配置的模型服务，不写日志。

## AI 层（lib/parent-summary-ai.ts）

沿 comment-ai.ts 范式：

- `buildSummaryMessages(ctx)` — 首轮消息（学生 / 班级 / 时间范围 / 时段内评价 / 个性化要求）；
- `requestParentSummary(messages, options)` — 按既有线程请求一次，成功把助手回复 push 回线程
  （聊天式多轮）；未配置 / 失败返回 `null`，不抛错；`options.llm / aiReady` 供单测注入。
- `parseParentSummary(raw)` — 引号与「评语：」沿用 `parseTermComment` 清洗，另剥模型自加的
  「总结：」类标题，最后按硬上限截断。

## 提示词模块

`content.parent-summary`（家校沟通总结，分组「内容生成」，见 [PROMPT_MANAGEMENT.md](PROMPT_MANAGEMENT.md)）：

- 变量 `{总结字数上限}`（可编辑，默认 150）是**写作建议**；
  `PARENT_SUMMARY_MAX_LEN`（200，contracts.ts）是**硬截断上限**——与学期评语同取 200，
  保证「应用到档案」不会被二次截断。两者刻意不相等，见学期评语模块的同款说明。

## Agent 工具：generate_parent_summary

在 `src/agent/tools/parent-summary.ts` 声明式注册（default export，`import.meta.glob` 自动装载），
**只读、非写操作**（`dangerous` 不标）：写入档案永远由用户点击「应用到档案」确认。

| 参数 | 说明 |
| --- | --- |
| `student_id` / `student_name` / `class_name` | 目标三选一：单个学生（ID 优先；姓名重名时报候选让模型反问）或一键全班；`class_name` 也可用于限定学生所属班级 |
| `semester` 或 `start`+`end` | 时段二选一（学期号 `2026-2027-1` 或日期区间 YYYY-MM-DD），缺省当前学期 |
| `requirement` | 个性化写作要求，随首启生成进入线程 |

执行流程：校验 AI 已配置（未配置直接报错指路设置中心）→ 解析目标与时段 →
- **单个学生**：`openParentSummaryPanel({studentId, range, autoStart: true, requirement})` →
  跳转学生详情路由 → 面板消费预设并自动生成，结果在学生档案「家校沟通」页签内呈现；
- **全班**：`openParentSummaryBatch({className, range, autoStart: true, requirement})` →
  批量对话框打开并逐个生成。

工具本身不等待、不落库。

## 测试

- `tests/parent-summary.test.ts` — 聚合纯函数、消息构造、解析清洗、AI 请求与线程续写
- `tests/agent-parent-summary-tool.test.ts` — 容器注册、目标解析（重名 / 未找到 / 全班）、
  单生跳转与预设、全班批量预设、时段校验
- `tests/parent-summary-panel.test.ts` — 学生档案面板：素材、预设消费与自动生成、
  同线程续写、应用（manual / ai 来源）、失败回退与干净重试、换学生重置
- `tests/parent-summary-batch.test.ts` — 批量对话框：名单与素材、全班顺序生成与应用、
  手动填写应用、跳学生档案、失败重试、切范围清空草稿

## 验收清单

- [x] 学生档案「家校沟通」页签：单独生成、补充个性化要求重新生成（同线程）、应用到档案、复制、手动填写
- [x] 班级详情入口批量生成：顺序执行、进度可见、可中断、失败可就地重试；逐个查看 / 应用 / 跳档案精修
- [x] Agent 自然语言发起：单生跳学生档案页签自动生成，全班开批量对话框，任意页面可达；重名报候选
- [x] 无 AI 时可手动填写后应用；生成失败可重试且线程不残留
- [x] `npm run typecheck`、`npm test` 全绿
