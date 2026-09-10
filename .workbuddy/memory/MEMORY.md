# aprilio 项目长期备忘

## 构建环境（Windows 本机，2026-09 确认）

- Rust 侧 cargo 命令需 MSVC 三件套（PATH/INCLUDE/LIB，BuildTools 14.44.35207 + WinSDK 10.0.22621.0）：
  Git Bash 的 /usr/bin/link.exe（coreutils）会遮蔽 MSVC link.exe；缺 LIB 会 LNK1181（如 OleAut32.lib）。
  环境已内置进 `scripts/test-mcp.sh`，工具集升级时同步改脚本里的版本号路径。
- rustc 1.98 incremental 编译反复 ICE → `src-tauri/.cargo/config.toml` 已关闭 incremental，勿删。
- **cargo test 不会重链 bin**：改 Rust 后测 MCP / 跑 app.exe 前必须 `cargo build`，否则测的是旧产物。

## 测试入口

- TS：`npm run typecheck && npm test`；Rust：`cargo test --manifest-path src-tauri/Cargo.toml`（27 用例基线）
- MCP 冒烟：`bash scripts/test-mcp.sh`（build + initialize/tools/list/tools/call 握手）
- **vitest 4.1.11 + Windows 小写盘符坑**（vitest#10692）：Git Bash 会话 cwd 是 `d:\...` 时全量测试必挂
  （每个文件都在首个 describe 抛 `Cannot read properties of undefined (reading 'config')`）。
  跑测试必须先 `cd D:/myspace/job/aprilio`（大写盘符）且与 `npm test` 同一条命令；
  4.x 无修复版，升 vitest 5.0.0 可根治。

## 架构要点

- 能力注册：Rust 用 inventory（`register_capability!`，链接期收集）→ 启动上报 TS 容器合并；
  MCP 工具面（mcp_server.rs）是独立第三视图，新增 Rust 只读工具要同步挂 MCP 执行体
- 日志：GUI 进程走 tauri-plugin-log（target: ai/photos/rag，见 docs/LOGGING.md）；
  MCP serve 模式无 plugin-log，诊断走 stderr（`[aprilio-mcp]` 前缀，不落文件）
- 隐私红线：日志不记 API 密钥、学生隐私字段全文、语义搜索 query 全文
- 背景图库（docs/BACKGROUNDS.md）：索引落 localStorage；本地上传缓存进 `photos/`（img_ 前缀），
  网络图走 Rust `download_background` 缓存进 `backgrounds/`（bg_ 前缀）；换图只改引用不删历史文件。
  新增 Rust 命令要挂 `lib.rs` 的 generate_handler，新目录要加 tauri.conf.json 的 assetProtocol scope
- **迁移链（2026-09-09 收敛后）**：lib.rs 只有 v1–v4（v1 建表含 profile.timetable_bg、
  v3 含 timetables.my_subjects、v4 含 calendar_events.title + 开头幂等重建 calendar_memos 保底搬迁）。
  **改已应用迁移的 SQL 必须同步 UPDATE 库内 _sqlx_migrations.checksum**
  （SHA-384 over SQL 原文），否则首次 Database.load 必失败（VersionMismatch）；
  tauri-plugin-sql 的迁移列表是一次性消费（load 内 remove），首次失败后重试会跳过迁移成功
  —— db.ts getDb 已内置失败重试一次兜底，老库缺列仍由前端 ensureSchema try-ALTER 兜底
- **import.meta.glob 必须用相对路径**（如 `../../../docs/*.md`），
  禁用 root 相对（`/docs/*.md`）：Git Bash 小写盘符 cwd 下 vite 会生成跨盘符坏 import
  （与 vitest 4 小写盘符坑同源），dev 模式整个前端模块图崩掉
- 本会话环境有 HTTP_PROXY（127.0.0.1:53332）：启动 app.exe 验证前端时要
  `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy` 清代理，否则 WebView 加载被劫持
- **AI 宠物形象层（2026-09-10 定架构）**：三层 = 宠物包 `pet.json`（`runtime`: vector / vector-layered /
  raster-layered / sprite / live2d）+ `PetRuntime` 适配器 + Agent 事件桥；**Live2D 只是 P2 的一个适配器**，
  不与宠物本体绑死。方案 + 素材规范见 `docs/DESKTOP_PET.md`；原型 `prototypes/pet/`：
  `pet-studio.html`（接入演示）、`pet-rig.html`（矢量装配台：分层 SVG 校验 + 锚点编辑）、
  `pet-raster.html`（贴图装配台：分层 PNG 部位识别 + 原位对齐 + 摆位 + 导出 pet.json）、
  `templates/layered-cat.pet.svg`（画布 512、脚底线 y=478、图层 id = slot 名）。
  素材精度阶梯：矢量 2~6h < 分层贴图 1~3d（同一画布尺寸对齐导出）< Live2D 1~2 周。
  自检：`node prototypes/pet/smoke.mjs`（73 断言：抠图数学 + 真实画布链路 + UI 接线）。
- **AI 出图的素材板路线（2026-09-10）**：AI 文生图只能出不透明整图，所以让它按 3×3 网格
  在一张图上画 9 个孤立部件（顺序：身体/头(不含耳)/尾/睁眼/笑眼/睡眼/闭嘴/张嘴/单耳），
  背景用角色配色里不存在的纯色（暖色角色→品红 `#FF00FF`，粉紫角色→绿 `#00FF00`），
  再由 `pet-raster.html` 的「素材板切片」切开、抠背景、自动镜像补另一侧。
  提示词手册：`prototypes/pet/AI_PROMPTS.md`。
  抠图用 **YCbCr 色度距离**（RGB 距离抠不干净抗锯齿边），色度距离 ÷ 背景色度模长 ≈ 前景覆盖率，
  可直接当 alpha，再按 alpha 反解前景色去色溢。pet.json 的 `canvas.align` 区分
  `same-size`（逐层等宽原位）与 `placed`（自然尺寸 × scale，中心在 x/y；切片路线输出这个）。
- **本地单文件 HTML 原型要验真实画布时**：Edge/Chrome 无头 `--dump-dom` 在本机沙箱里静默无输出，
  改用 **`@napi-rs/canvas` 垫进 jsdom**（依赖装 `~/node_modules`，项目零污染）：
  `beforeParse` 里替换 `document.createElement('canvas')` 与 `window.Image`（loadImage 是异步的，
  解完再触发 onload），并给 context 原型 `drawImage` 打补丁解包垫片。
  只测纯函数不够——变量提升一类的状态泄漏只在多像素连续扫描时显现。
