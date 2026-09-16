# Ctrl+F 全局搜索（v1）

## Context

项目目前只有班内学生搜索（ClassDetailView）和备忘搜索，Agent 的语义检索无面向用户的 UI。用户需要一个全局搜索入口：按 Ctrl+F 唤起命令面板式浮层，跨实体搜学生、班级、考试、照片、日历备忘，回车跳转对应页面。已确认范围：四类实体 + 纯关键词（不接 Ollama 语义检索，零新依赖、零 Rust 改动）；Ctrl+F 开/关、Esc 关闭、↑↓ 选择、Enter 跳转；浏览器演示态（内存数据）必须可用。

## 方案

搜索聚合逻辑放 lib（可测），浮层 UI 放组件，App.vue 挂载。全部复用现有 db.ts 查询函数与设计 token，不新增依赖。

### 文件清单

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/lib/global-search.ts` | 新建 | 纯搜索聚合：`searchGlobal(keyword, limitPerGroup=8)` → 分组结果 |
| `src/lib/db.ts` | 改 | 新增 `searchCalendarEvents(keyword, limit=8)`（备忘无现成关键词查询，其他实体复用现有 list*） |
| `src/components/GlobalSearch.vue` | 新建 | 浮层 UI + 快捷键 + 键盘导航 + 跳转 |
| `src/components/ui/AppInput.vue` | 改 | 加 `defineExpose({ focus })`（约 3 行），供打开浮层后聚焦 |
| `src/App.vue` | 改 | `<AgentChat />` 后平铺挂载 `<GlobalSearch />` |

### 类型与签名（global-search.ts）

```ts
export type SearchEntity = "student" | "class" | "exam" | "photo" | "memo";
export interface GlobalSearchResult {
  entity: SearchEntity;
  id: string;
  title: string;   // 主文案
  subtitle: string; // 次文案：学号/日期/班级/「已归档」/「已完成」等
  route: { name: string; params?: Record<string, string> };
}
export interface GlobalSearchGroup { entity: SearchEntity; label: string; results: GlobalSearchResult[] }
export async function searchGlobal(keyword: string, limitPerGroup = 8): Promise<GlobalSearchGroup[]>
```

### 各实体查询方式

| 实体 | 数据来源 | 过滤 | 跳转 route |
| --- | --- | --- | --- |
| 学生 | `listStudents(keyword)`（已支持姓名/学号 LIKE，db.ts:1018） | 自带 | `{name:'student-detail', params:{id}}` |
| 班级 | `listClasses()` 全量后 JS 过滤 name | `archived_at` 非空 → subtitle 追加「已归档」（不排除） | `{name:'class-detail', params:{name}}` |
| 考试 | `listExams()` 全量后过滤 name/exam_date | — | `{name:'class-detail', params:{name: exam.class_name}}` |
| 照片 | `listPhotos()` 全量后过滤 caption/file_name/grade_class | `student_id` 为空 → subtitle「班级照片 · {grade_class}」 | `{name:'photos'}` |
| 备忘 | 新增 `searchCalendarEvents(keyword)`：SQL `title LIKE OR content LIKE ORDER BY event_date DESC LIMIT`；非 Tauri 走 mem() 过滤 | `done` → subtitle 追加「已完成」 | `{name:'home'}` |

五路 `Promise.all` 并发，每组截 8 条，分组顺序：学生 → 班级 → 考试 → 照片 → 备忘。数据量小（本地 SQLite），全量拉取 + JS 过滤可接受，与项目现有模式一致。

### GlobalSearch.vue 交互细节

- 模态外壳沿用项目约定（参考 StudentFormDialog.vue:303-315）：`fixed inset-0 z-50 bg-black/30` + 内容 `w-[560px] rounded-lg bg-canvas shadow-window`，`@click.self` 关闭
- 快捷键：`onMounted` 向 document 注册 keydown（onUnmounted 移除，同 MemoHistoryDrawer 惯例）。Ctrl/Cmd+F → `preventDefault()`（覆盖浏览器查找）后 toggle；Esc → 关闭并清空关键词
- 打开后 `nextTick` 聚焦输入框（AppInput 新增的 `focus()`）；空关键词显示提示「输入关键词搜索学生、班级、考试、照片与备忘」；无结果显示「未找到匹配结果」
- `watch(keyword)` + 200ms 防抖（同 ClassDetailView 模式），递增 token 丢弃过期响应
- 键盘导航：扁平化 `flatResults` + `activeIndex`（输入变化时重置 0）；↑↓ 循环移动 + `scrollIntoView({block:"nearest"})`；Enter 与点击同走 `go(result)`：`router.push(result.route)` 后关闭浮层并清空关键词
- `@keydown` 绑在 AppInput 上即可（内层 input 事件冒泡到根 div，已验证）
- 结果区 `max-h-80 overflow-y-auto scroll-thin`；分组标题用 `text-fine text-faint`；图标内联 SVG（stroke currentColor，1.5）
- 底部 footer 快捷键提示：`↑↓ 切换 · Enter 跳转 · Esc 关闭`

### TDD 任务顺序

1. **db 层**：`tests/calendar-db.test.ts` 追加 `searchCalendarEvents` 用例（关键词命中 title/content、日期倒序、limit、mem 态种数据，同现有风格）
2. **lib 层**：新建 `tests/global-search-lib.test.ts`（vitest 下 isTauri() 为 false 自动走 mem 数据，无需 mock）：学生姓名/学号命中、归档班 subtitle 含「已归档」、考试 route 指向其班级、班级照片 subtitle、备忘 done 标注、每组上限、空关键词返回空
3. **组件层**：新建 `tests/global-search-component.test.ts`（参考 memo-history-drawer.test.ts 的键盘监听测试 + class-detail-view.test.ts 的 router 用法）：Ctrl+F 打开且 preventDefault 被调、再按关闭、Esc 关闭；输入 + flushPromises/fake timers 出分组；↑↓ 移动 active、Enter 触发 router.push 且浮层关闭；空态文案
4. 挂载 App.vue，跑门禁

## 验证

```bash
npm run typecheck   # 必须全绿
npm test            # 必须全绿（新增 3 个测试文件全过，无既有用例回归）
npm run tauri:dev   # 人工验证：Ctrl+F 开/关、四类实体搜索、键盘导航、跳转正确、归档班标注
```

不动 Rust，无需 cargo check。
