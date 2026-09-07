# Task 2: 在学生详情页集成时间线与「+ 记表现」交互 实施报告

## 状态
**DONE**

## 提交信息
- **Commit SHA**: `dc3b00d`
- **Commit Message**: `feat: 学生详情页集成日常表现时间线与快捷记表现`

## 改动文件
1. `tests/student-detail-behavior.test.ts` (新建测试文件)
2. `src/views/StudentDetailView.vue` (修改视图文件)

## 功能实现要点
1. **顶栏「+ 记表现」操作与弹层锚定**：
   - 顶栏增加 `[+ 记表现]`（`data-test="quick-behavior-btn"`），与「编辑档案」、「添加图片」统一排列。
   - 提供 `openQuickBehavior(e)` 方法，通过按钮位置计算 `quickAnchor`，并支持快捷弹层中心回退。
2. **学生概览信息升级**：
   - 副标题更新为 `最近更新 {{ formatShort(student.updated_at) }} · 共 {{ photos.length }} 张图片 · 共 {{ behaviors.length }} 条表现记录`。
3. **右侧主体区域改造为 Tab 布局**：
   - Tab 1: `日常表现 ({{ behaviors.length }})`（`data-test="tab-behaviors"`），默认激活，展示 `StudentBehaviorTimeline`，支持记录增删联动与空状态下直接记录。
   - Tab 2: `图片记录 ({{ photos.length }})`（`data-test="tab-photos"`），展示原有的 `PhotoGrid`、本地导入入口与空状态。
4. **快捷表现浮层与反馈联动**：
   - 挂载 `<QuickBehaviorPopover>`，在保存后触发 `onQuickSaved`。
   - 自动并发重拉 `listBehaviorRecords(id.value)`，刷新时间线与统计数字。
   - 顶部提供带有淡入淡出动画的微型 Toast 提示反馈（持续 2.4 秒自动隐去）。
5. **数据并行刷新**：
   - `refresh()` 中采用 `Promise.all` 并发拉取 `getStudent`、`listPhotos` 与 `listBehaviorRecords`，保证加载效率。

## 验证结果
1. **TDD 红绿验证**：
   - 红灯阶段：运行 `npx vitest run tests/student-detail-behavior.test.ts`，准确捕获 `quick-behavior-btn` 与 Tab 缺失错误（FAIL 2 / PASS 0）。
   - 绿灯阶段：功能实现后再次运行，3 个测试全部通过（PASS 3 / FAIL 0）。
2. **全量测试套件**：
   - `rtk npm test`：38 个测试文件、300 个测试用例全部通过（PASS 300 / FAIL 0）。
3. **TypeScript 类型校验**：
   - `npm run typecheck` (`vue-tsc --noEmit`)：0 错误通过。
