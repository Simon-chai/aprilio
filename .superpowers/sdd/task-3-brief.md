### Task 3: 扩展 AI Agent `query_data` 工具查询日常表现

**Files:**
- Modify: `src/agent/tools/query.ts`
- Test: `tests/agent-query-tool.test.ts`

**Interfaces:**
- Consumes: `listBehaviorRecords` (from `src/lib/db`)
- Produces: `query_data` 支持 `entity: "behaviors"` 查询

- [ ] **Step 1: 在 `tests/agent-query-tool.test.ts` 中增加测试用例**

在 `tests/agent-query-tool.test.ts` 的 `describe("query_data tool")` 内添加：

```ts
  it("queries student behavior records with polarity and keyword filters", async () => {
    // 预置表现记录
    const { addBehaviorRecord } = await import("../../src/lib/db");
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "智能助手表现查询测试：数学课主动发言",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 1,
        polarity: "praise",
        keyword: "主动发言",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("日常表现查询：命中");
    expect(res.summary).toContain("数学课主动发言");
    const data = res.data as { comment: string }[];
    expect(data.some((d) => d.comment.includes("主动发言"))).toBe(true);
  });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/agent-query-tool.test.ts`
Expected: FAIL（未知查询实体 "behaviors"）

- [ ] **Step 3: 修改 `src/agent/tools/query.ts`**

1. 引入 `listBehaviorRecords` 从 `../../lib/db`；
2. 在 `parameters.properties` 中扩展 `entity.enum` 为 `["students", "photos", "stats", "behaviors"]`；
3. 添加参数定义：
   ```ts
   polarity: {
     type: "string",
     enum: ["praise", "improve"],
     description: "按评价倾向过滤表现流水：praise（表扬）| improve（待改进），仅 behaviors 生效",
   },
   dimension_name: {
     type: "string",
     description: "按表现维度名称过滤，如「课堂表现」、「作业情况」，仅 behaviors 生效",
   },
   ```
4. 在 `execute` 中增加 `entity === "behaviors"` 分支：
   ```ts
    if (entity === "behaviors") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const all = await listBehaviorRecords(studentId, 100);
      const polarity = typeof args.polarity === "string" ? args.polarity.trim() : "";
      const dimensionName = typeof args.dimension_name === "string" ? args.dimension_name.trim() : "";

      const filtered = all.filter((r) => {
        if (polarity && r.type !== polarity) return false;
        if (dimensionName && r.dimension_name_snap !== dimensionName) return false;
        if (keyword && !r.comment.includes(keyword) && !r.dimension_name_snap.includes(keyword)) {
          return false;
        }
        return true;
      });

      const rows = filtered.slice(0, limit);
      const rowsSummary = rows
        .map((r) => `[${r.recorded_date}] ${r.dimension_name_snap} ${r.type === 'praise' ? '👍' : '⚠️'} ${r.comment}`)
        .join("\n");

      return {
        ok: true,
        summary: `日常表现查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${rowsSummary || JSON.stringify(rows)}`,
        data: rows,
      };
    }
   ```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/agent-query-tool.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 3 成果**

```bash
rtk git add src/agent/tools/query.ts tests/agent-query-tool.test.ts
rtk git commit -m "feat: AI Agent query_data 工具支持查询学生日常表现"
```
