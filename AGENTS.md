# 项目规则（AGENTS.md）

开发约定入口。**本文件只放全局约定与文档索引**；专题规则写到 `docs/` 下对应文档，写完在下方索引登记一行，避免本文件无限膨胀。

## 全局约定

- 语言：代码注释、提交信息、面向用户的文案用中文
- 技术栈与目录结构见 [README.md](README.md)
- 改动后必跑：`npm run typecheck` → `npm test`；动了 Rust 再跑 `cargo check --manifest-path src-tauri/Cargo.toml`

## 规则索引

| 主题 | 文档 | 概要 |
| --- | --- | --- |
| AI 研发 SOP | [docs/AI_DEVELOPMENT_SOP.md](docs/AI_DEVELOPMENT_SOP.md) | 需求澄清→Spec→TDD→架构约束→验证门禁的作业流程与意图防退化评测 |
| 成绩导入 | [docs/SCORE_IMPORT.md](docs/SCORE_IMPORT.md) | 考试批次（考试名+时间）与成绩落库、成绩单智能识别、花名册入口分流 |
| 学期化班级管理 | [docs/SEMESTER_MANAGEMENT.md](docs/SEMESTER_MANAGEMENT.md) | 班级初始年级+起始学期实时推导、学生按学期组织（成绩/表现/学期评语）、班级归档与历史班、AI 优先无 AI 可手工 |
| 课程表 | [docs/TIMETABLE.md](docs/TIMETABLE.md) | 班级全科课表（万年历 + 备忘 + 网格编辑）与按科目聚合的我的课表（不绑教师名）：学期推导、首页今日课程、Agent 问课 |
| Agent | [docs/AGENT.md](docs/AGENT.md) | 自主 Agent 框架分层、工具扩展步骤、应用界面注册表 |
| Agent 技术栈 | [docs/AGENT_FRAMEWORK_EVALUATION.md](docs/AGENT_FRAMEWORK_EVALUATION.md) | Rig + rmcp 双轨方案、能力清单 manifest、迁移路线 |
| 日志 | [docs/LOGGING.md](docs/LOGGING.md) | 日志文件位置、记录点清单、新增日志写法、排查流程 |
| 背景图库 | [docs/BACKGROUNDS.md](docs/BACKGROUNDS.md) | 首页大图/头像/课表背景：本地上传 + URL 缓存到本地、本地索引与切换、清理时机 |
| 设计系统 | [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | 颜色/字号/圆角/阴影 token 与组件规范，唯一事实源为 `src/style.css` 的 `@theme` |

## 新增规则的拆分原则

- 只有 1~2 条、所有场景通用 → 直接写进上面的「全局约定」
- 某个领域（日志、UI、数据库迁移、AI……）成体系的规则 → 新建 `docs/<TOPIC>.md` 并登记索引
- 索引表保持按主题字母序 / 加入顺序排列即可，每行一句话概要
