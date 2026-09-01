# aprilio

本地运行的学生信息档案与图片记录桌面应用。Tauri 2 + Vue 3 + TypeScript + Tailwind v4，数据全部存在本机 SQLite，不联网。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 外壳 | Tauri 2（Rust） |
| 前端 | Vue 3 `<script setup>` + TypeScript + Vite 6 |
| 样式 | Tailwind v4（`@tailwindcss/vite`，token 写在 `src/style.css` 的 `@theme` 里） |
| 数据库 | SQLite（`tauri-plugin-sql`，启动时自动跑迁移） |
| 图片 | 存在 `<appLocalDataDir>/photos/`，数据库只记文件名 |

## 目录结构

```
src/
├── style.css              # Tailwind 入口 + 全部设计 token
├── router/index.ts        # hash 路由
├── types/index.ts         # Student / Photo / Stats
├── lib/
│   ├── db.ts              # 数据访问（Tauri 走 SQLite，浏览器走内存示例数据）
│   ├── photos.ts          # 图片导入 / 删除 / convertFileSrc
│   └── format.ts          # 日期格式化
├── components/
│   ├── AppSidebar.vue
│   ├── StudentTable.vue
│   ├── PhotoGrid.vue
│   ├── StudentFormDialog.vue
│   └── ui/                # AppButton / AppInput / AppCard / StatusChip / EmptyState
└── views/                 # StudentsView · StudentDetailView · PhotosView · DesignSystemView · SettingsView

src-tauri/
├── src/db.rs              # 两张表的迁移
├── src/photos.rs          # photos_dir / import_photo / delete_photo_file
└── src/lib.rs             # 插件与命令注册
```

## 数据模型

`students` — 姓名 / 性别 / 出生日期 / 学号（唯一）/ 年级班级 / 入学日期 / 监护人 / 联系电话 / 住址 / 状态 / 备注 / 时间戳

`photos` — 学生 ID / 文件名 / 说明 / 拍摄日期 / 时间戳

## 开发

### 1. 装 Rust（只需一次）

Tauri 的桌面端依赖 Rust 工具链，前端本身不需要。

```bash
# 方式一：winget
winget install Rustlang.Rustup

# 方式二：https://www.rust-lang.org/learn/get-started
```

装完重启终端，确认：

```bash
rustc --version && cargo --version
```

Windows 还需要 **Microsoft C++ 生成工具**（Visual Studio Installer 里勾「使用 C++ 的桌面开发」）。
WebView2 运行时 Windows 11 一般自带。

### 2. 装依赖

```bash
npm install
```

### 3. 跑起来

```bash
# 完整桌面应用
npm run tauri:dev

# 只看前端（浏览器打开 http://localhost:1420）
npm run dev
```

浏览器模式下 SQLite 不可用，会自动切到内存示例数据 —— 调样式时很方便。

### 4. 构建

```bash
npm run tauri:build   # 打包安装包
npm run build         # 只构建前端
npm run typecheck     # 类型检查
```

## 设计系统

单一强调色 `Action Blue #0066cc`，层级靠底色切换（白 `#ffffff` / 浅灰 `#f5f5f7` / 深色 `#272729`）和 1px 发丝线 `#e0e0e0` 表达。

- 不给卡片、按钮、文字加阴影 —— 全站只有图片和窗口有投影
- 标题负字距（`-0.22 ~ -0.4px`），正文 17px / 行高 1.47
- 胶囊圆角 = 主操作，`18px` = 卡片，`8px` = 缩略图与输入
- 应用内「设计系统」页可直接查看全部 token

对应的 Ardot 设计稿：fileId `720132402843853`

## 路线图

AI Agent 选型决策与待办清单：[docs/ROADMAP.md](docs/ROADMAP.md)（2026-09 定：`genai` + 手写 agent 循环，Rust 侧实现）

