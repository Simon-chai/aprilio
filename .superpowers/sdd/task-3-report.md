# Task 3: 扩展 AI Agent query_data 工具查询日常表现 实施报告

## 状态
**DONE**

## 提交信息
- **Commit SHA**: `846c358f150f4d85ca4869be8d169271ca052f4f`
- **Commit Message**: `feat: AI Agent query_data 工具支持查询学生日常表现`

## 改动文件
1. `tests/agent-query-tool.test.ts` (增加测试用例)
2. `src/agent/tools/query.ts` (扩展 query_data 工具实体与过滤参数)

## 功能实现要点
1. **Schema 参数扩展**：
   - `entity` 枚举扩展支持 `"behaviors"`。
   - 增加 `polarity` 参数：可选 `"praise"` | `"improve"`，按表扬或待改进倾向过滤表现流水。
   - 增加 `dimension_name` 参数：支持按表现维度名称过滤（如「课堂表现」、「作业情况」）。
   - 完善参数说明与 `keyword` / `student_id` 说明，指明在 `behaviors` 查询中的匹配语义。
2. **Execute 执行逻辑扩展**：
   - 引入 `listBehaviorRecords`，当 `entity === "behaviors"` 时执行查询。
   - 支持通过可选的 `student_id` 参数按学生过滤流水，上限取 100 条流水做基底。
   - 支持 `polarity`（评价倾向）、`dimension_name`（维度快照名）以及 `keyword`（匹配评论内容或维度名）的组合过滤。
   - 依据 `limit`（最大 100，默认 20）截断并构建可读的摘要文本，包含图标标记（👍 / ⚠️）与格式化日期。
   - 未知实体错误提示统一更新，包含新增的 `behaviors` 选项。

## 验证结果
1. **TDD 红绿验证**：
   - 红灯阶段：在未修改实现前添加测试，运行 `rtk vitest run tests/agent-query-tool.test.ts`，精准失败（`res.ok` 为 `false`，报未知查询实体错误）。
   - 绿灯阶段：修改 `src/agent/tools/query.ts` 后运行，8 个测试全部通过（PASS 8 / FAIL 0）。
2. **TypeScript 类型校验**：
   - `rtk npm run typecheck` (`vue-tsc --noEmit`)：0 错误通过。
3. **全量测试套件**：
   - `rtk npm test`：38 个测试文件、302 个测试用例全部通过（PASS 302 / FAIL 0）。
