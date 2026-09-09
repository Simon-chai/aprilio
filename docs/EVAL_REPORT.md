# 学生评价报告与作业台账（Spec）

> 状态：**设计中（2026-09-10）**。顺序：**P2 作业台账先行，P1 评价报告随后**（作业是报告的输入，先有数据再有报告）。
> 相关：[SEMESTER_MANAGEMENT.md](SEMESTER_MANAGEMENT.md)（学期口径）· [SCORE_IMPORT.md](SCORE_IMPORT.md)（成绩口径）· [AGENT.md](AGENT.md)（工具扩展）· [AI_DEVELOPMENT_SOP.md](AI_DEVELOPMENT_SOP.md)（流程门禁）。

## 1. 背景与目标

现状：成绩（`exams/exam_scores`）、表现（`student_behavior_records`）、学期评语（`student_term_comments`）齐了，但“作业情况”只有行为维度里的零散评语，没有按学生×日期×科目的完成度台账；评价报告只能靠老师手写学期评语（60~120字），没有一键长报告。

| # | 目标 | 一句话验收 |
| --- | --- | --- |
| P2-G1 | 新建个人作业台账：一次作业一条，可记科目/日期/状态/简评 | 学生详情能录入并按区间查出作业按时率 |
| P2-G2 | 作业台账双态读写（SQLite + 浏览器内存兜底） | 演示态与桌面端行为一致 |
| P1-G1 | 一键生成评价报告：时间可选学期或自定义区间 | 选学期/选日期都能生成，数字与各 Tab 一致 |
| P1-G2 | 双输出：长报告 markdown + 短评语，短评语可回写学期评语 | 回写后学期评语 Tab 可见 |
| P1-G3 | 报告存档：历史可回看/打印/删除 | 刷新后历史仍在，可打印给家长 |
| G-AI | AI 增强层：无 AI 时数据版报告可用，有 AI 时长报告有温度 | 未配置模型不阻塞 |

## 2. 非目标

- 不做班级布置表：班级布置仍用 `calendar_events type=homework`，本期只做个人完成台账
- 不做作业 Excel 导入、作业统计图表（柱状/折线）：首版只列表+汇总数字
- 不做报告 PDF 导出文件：首版只 `window.print` 打印 + 复制 markdown
- 不改现有成绩/表现/评语表结构与口径
- 不做跨教师数据迁移

## 3. 核心决策

- **D1 P2先行**：报告的“作业情况”节依赖台账，先落表与录入，再做报告聚合
- **D2 单表闭环**：`student_homework_records` 一张表承载个人作业，不拆布置/提交两张
- **D3 时间统一为日期区间**：`ReportRange={mode,semester?,start,end}`；学期模式用 `semesterOfDate()` 过滤（口径同成绩/表现 Tab），自定义用 `[start,end]`；不建学期起止表
- **D4 纯函数聚合**：`src/lib/homework.ts`（状态标签/校验/汇总）与 `src/lib/report.ts`（区间取数+摘要）只算数不碰 LLM，三端共用
- **D5 报告存档独立表**：`student_eval_reports` 一次生成一条，不覆盖历史
- **D6 AI 降级**：沿 `comment-ai.ts` 范式，未配置/失败返回数据版，日志只记计数

## 4. 数据模型

```sql
student_homework_records (
  id PK, student_id INTEGER NOT NULL,
  homework_date TEXT NOT NULL,      -- YYYY-MM-DD
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done', -- done 按时完成 | excellent 优秀 | late 迟交 | missing 缺交 | exempt 免做
  score REAL, comment TEXT DEFAULT '',
  created_at / updated_at,
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
);
INDEX idx_homework_student_date ON (student_id, homework_date);

student_eval_reports (
  id PK, student_id INTEGER NOT NULL,
  range_start TEXT NOT NULL, range_end TEXT NOT NULL,
  semester TEXT,                    -- 学期模式记学期号，自定义为 NULL
  title TEXT DEFAULT '', content_md TEXT DEFAULT '',
  short_comment TEXT DEFAULT '', source TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
);
INDEX idx_eval_reports_student ON (student_id, range_start);
```

- 落点：`src-tauri/src/lib.rs` v8 迁移 + `src/lib/db.ts` 的 `SCHEMA_DDL` 同步 + `ensureSchema` 兜底；`tests/schema-sync.test.ts` 自动对账
- 内存兜底：`MemoryStore` 加 `homeworks/evalReports` + 自增 id
- 删除学生/班级连带删除；不进回收站快照（同成绩口径）

## 5. 功能设计

### P2 作业台账

- 类型：`src/types/index.ts` 加 `HomeworkStatus` + `StudentHomeworkRecord` + `HomeworkInput`
- 纯函数：`src/lib/homework.ts`（`HOMEWORK_STATUS_LABEL`、`validateHomeworkInput`、`summarizeHomeworks` 按时率/缺交/优秀计数、`filterHomeworksByRange`）
- 数据层：`addHomeworkRecord / listHomeworkRecords(studentId, {start,end,subject,limit}) / updateHomeworkRecord / deleteHomeworkRecord`
- 界面：`src/components/HomeworkPanel.vue`（列表+新增/编辑对话框+删除确认+区间汇总条）；`StudentDetailView.vue` 新增 Tab「作业」
- 校验：日期 `YYYY-MM-DD` 且不晚于今天；科目非空；状态枚举；评语 ≤200 字

### P1 评价报告

- 类型：`StudentEvalReport` + `ReportRange`
- 聚合：`src/lib/report.ts`（`resolveReportRange` 学期→起止按该生数据边界兜底、`collectReportData` 按区间取成绩/表现/作业/评语、`buildReportSummaries` 复用 `comment-ai.buildScoreSummary/buildBehaviorSummary` + 新增 `buildHomeworkSummary`）
- AI：`src/lib/report-ai.ts`（`generateEvalReport(ctx)` 输出 `{ markdown, shortComment }`；无 AI 返回数据版 markdown；prompt 固定 5 节：总评/学业/行为习惯/作业情况/给家长的建议 + 末尾短评语行）
- 数据层：`createEvalReport / listEvalReports / deleteEvalReport`
- 界面：`src/components/EvalReportPanel.vue`（范围选择：学期下拉复用 `activeSemester` + 自定义起止；生成→预览 markdown 复用 `markdown.ts`→保存/复制/打印/短评语回写）；`StudentDetailView.vue` 新增 Tab「评价报告」
- Agent：`query_data` 加 `homeworks`/`eval_reports` 实体；`analyze` 加 `student_eval_report` 只读汇总；Evals 补 2 条

## 6. 任务拆解（按依赖顺序，P2→P1）

| 步 | 内容 | 落点 |
| --- | --- | --- |
| 1 | 类型 + 作业纯函数 + 单测 | `types/index.ts`、`lib/homework.ts`、`tests/homework-lib.test.ts` |
| 2 | 作业表 + CRUD 双态 + 单测 | `lib.rs` v8、`lib/db.ts`、`tests/homework-db.test.ts` |
| 3 | 作业面板 + 学生详情 Tab | `HomeworkPanel.vue`、`StudentDetailView.vue` |
| 4 | 报告类型 + 聚合纯函数 + 单测 | `types`、`lib/report.ts`、`tests/report-lib.test.ts` |
| 5 | 报告 AI + 单测 | `lib/report-ai.ts`、`tests/report-ai.test.ts` |
| 6 | 报告存档 CRUD + 单测 | `db.ts`、`tests/eval-report-db.test.ts` |
| 7 | 报告面板 + Tab + 打印 + 回写 | `EvalReportPanel.vue`、`StudentDetailView.vue` |
| 8 | Agent 工具/Evals + 文档索引 | `query.ts`、`analysis/providers/report-analysis.ts`、`tests/evals/dataset.ts` |

## 7. 验收清单

- [ ] 作业：新增/编辑/删除单条，日期校验（未来日期拒绝），列表按日期倒序
- [ ] 作业：按学期/自定义区间汇总按时率正确；删学生连带删
- [ ] 报告：学期与自定义区间生成数字与成绩/表现/作业各 Tab 一致
- [ ] 报告：无 AI 时数据版可用；有 AI 时 5 节结构完整，短评语 ≤120 字
- [ ] 报告：保存后历史列表可见，刷新仍在，可打印，可删除；短评语可回写学期评语
- [ ] Agent：`query_data homeworks/eval_reports` 可查；`analyze student_eval_report` 汇总正确
- [ ] `npm run typecheck`、`npm test`、`cargo check --manifest-path src-tauri/Cargo.toml` 全绿；`schema-sync` 通过
