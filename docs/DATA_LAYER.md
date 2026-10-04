# 数据层（src/lib/db/）

v1.1 起数据层按业务域拆分：原 5200+ 行的巨型 `db.ts` 变成**门面**，实现分散到
`src/lib/db/` 下按域组织的模块。对外公共 API（约 109 个导出）保持逐字不变，
68 个引用文件（views / components / agent / lib）的 `from "./db"` 无需任何改动。

## 目录结构

| 模块 | 职责 |
| --- | --- |
| `db/core.ts` | 单例连接（getDb）/ 前端表结构契约 SCHEMA_DDL（与 Rust 迁移对账）/ 幂等建表 / `executeBatch` 事务原语 / 私有语义的 isTauri |
| `db/memory-store.ts` | 浏览器演示态与单测的内存兜底库（17 个集合 + 种子数据）；`mem()` 取用、`resetMemoryStore()` 重置 |
| `db/shared.ts` | 域间共享小工具：本地时间戳、标签解析、照片快照、回收站期限、日期校验 |
| `db/students.ts` | 学生查询 / 增删改 / 回收站快照构建 |
| `db/recycle.ts` | 回收站列表 / 恢复 / 彻底删除 / 过期清理 / 学生快照回插 |
| `db/photos.ts` | 按学生挂接的照片记录（文件本体在 lib/photos） |
| `db/classes.ts` | 班级 CRUD / 归档 / 改名 / 删除 / 批量调班 / 班级照片 / 统计 |
| `db/term-comments.ts` | 学期评语（一人一学期一条，upsert 幂等） |
| `db/homework.ts` | 作业台账 |
| `db/eval-reports.ts` | 评价报告存档 |
| `db/profile.ts` | 教师个人资料 + 全量清空 |
| `db/behavior.ts` | 日常表现（维度字典 / 事实流水 / 评语沉淀） |
| `db/exams.ts` | 考试批次与成绩 |
| `db/timetable.ts` | 班级课表格子 + 调课例外 |
| `db/calendar.ts` | 统一日程事件（备忘 / 待办 / 考试 / 作业） |
| `db/lessons.ts` | 课堂模式（会话 / 事件流 / 座位 / 活动组合） |

## 规则

### 门面与内部边界

- `db.ts` 用**显式清单**转发公共 API；`getDb` / `executeBatch` / `mem` /
  memory-store 等内部机制**不进门面**。新增业务域：建 `db/<域>.ts` → 门面登记转发。
- db/ 内部允许跨域 import（如 `recycle → students` 的快照回插、`exams → students`
  的档案读取）；**db/ 不得反向被 views/components 直接引用**，一律走 `db.ts` 门面。
- core 的 `isTauri` 读真实环境、不给 mock 入口——单测恒走内存库；
  应用其余部分的 `isTauri` 从 `lib/env.ts` 取（可被测试 mock）。

### 事务（多表写必须走 executeBatch）

tauri-plugin-sql 底层是 sqlx 连接池（默认多连接），**跨 execute 的
BEGIN/COMMIT 可能落在不同连接上，事务边界会失效**。因此：

- 多表写一律 `executeBatch(db, statements, params)`：一次 execute 内联
  `BEGIN IMMEDIATE; …; COMMIT;`，语句与参数扁平化传入；
- 跨语句引用新插入行的 id，用 `(SELECT id FROM <表> WHERE rowid = last_insert_rowid())`
  内联回填（参见 `pushStudentSnapshotBatch`）；
- 现有覆盖：deleteStudent / deleteClass / updateStudent /
  batchUpdateStudentClass / restoreRecycleItem / appendLessonEvent /
  revokeLessonEvent / upsertSeating。新增多表写照此办理，禁止逐条 execute 裸拼。

### 双通道

每个域函数内部 `isTauri()` 二分：SQLite 走 SQL、内存态走 MemoryStore。
两通道的等价性靠 tests/ 下按域的 db 测试（走内存通道）+ schema-sync 测试
（文本对账 SCHEMA_DDL ↔ src-tauri/src/lib.rs 迁移）兜底；SQLite 真通道目前
没有自动化集成测试，改动 SQL 时需在桌面端手工回归。
