### Task 4: 全量回归与类型检查验证（Verification Gate）

**Files:**
- None (Verification only)

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 2: 运行全量 Vitest 测试集**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: 运行 Rust 后端编译检查**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，无报错
