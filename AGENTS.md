# 项目规则（AGENTS.md）

开发约定入口。**本文件只放全局约定与文档索引**；专题规则写到 `docs/` 下对应文档，写完在下方索引登记一行，避免本文件无限膨胀。

## 全局约定

- 语言：代码注释、提交信息、面向用户的文案用中文
- 技术栈与目录结构见 [README.md](README.md)
- 改动后必跑：`npm run typecheck` → `npm test`；动了 Rust 再跑 `cargo check --manifest-path src-tauri/Cargo.toml`

## 规则索引

| 主题 | 文档 | 概要 |
| --- | --- | --- |
| Agent | [docs/AGENT.md](docs/AGENT.md) | 自主 Agent 框架分层、工具扩展步骤、应用界面注册表 |
| 日志 | [docs/LOGGING.md](docs/LOGGING.md) | 日志文件位置、记录点清单、新增日志写法、排查流程 |

## 新增规则的拆分原则

- 只有 1~2 条、所有场景通用 → 直接写进上面的「全局约定」
- 某个领域（日志、UI、数据库迁移、AI……）成体系的规则 → 新建 `docs/<TOPIC>.md` 并登记索引
- 索引表保持按主题字母序 / 加入顺序排列即可，每行一句话概要
