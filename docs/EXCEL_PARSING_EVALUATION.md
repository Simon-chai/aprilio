# Excel（.xlsx）解析方案评估

日期：2026-09-05 初评 · **2026-09-05 定案并实施**：**采纳 Rust `calamine` 0.36.1**（实测二进制 +483 KB / +2.1%），
新增 `roster_read_table` 命令把 Excel/ODS 第一个非空工作表解码为二维字符串矩阵；
语义层（表头嗅探、姓名列识别、映射、校验、落库）仍在前端 `src/lib/roster.ts`，两层以 `RosterTable` 为边界。
**fflate + 自研最小读取器方案否决**（理由与教训见 §4 与附录）。

回答 [CLASS_MANAGEMENT_DESIGN.md](CLASS_MANAGEMENT_DESIGN.md) §10 待确认问题 4
（「xlsx 解析是否引入第三方库——取决于对安装包体积的容忍度」）。

---

## 1. 背景与需求面

- 花名册导入已落地（[ROSTER_IMPORT.md](ROSTER_IMPORT.md)），真实班主任数据多在 .xlsx 里，
  「另存为 CSV」是体验断点。
- 继承约束：安装包 10MB 量级（SOP 第 4 节）、完全离线、数据本机处理。
- 需求面很窄：读**第一个非空工作表** → 还原成二维字符串矩阵。不需要样式、公式求值、写入、图表、VBA。
- **核心风险认知（定案关键）**：花名册解析错一行 = 导入错学生档案。xlsx 的难点不在主干
  （zip + XML），在真实世界文件的长尾——这正是「交给生态里最成熟的库」而非「自研」的理由。

## 2. 实测数据（2026-09-05，Windows，vite 6 / rustc 1.98 release）

基线：

- 前端 bundle：383.85 kB（gzip 139.87 kB）；dist 全量 1.46MB
- 桌面端：`src-tauri/target/release/app.exe` = 23,294,976 B（22.2 MB，内嵌 brotli 压缩的 dist）

| 方案 | 实测增量 | 测法 |
| --- | --- | --- |
| calamine 0.36.1（Rust） | **app.exe +494,592 B（+483 KB，+2.1%）** | release 基线 / 加探针命令两次构建对比（两次嵌入的 dist 内容一致） |
| fflate 0.8.3（named import 解压） | +5.66 kB（gzip +2.81 kB） | 探针真实调用 + vite build |
| SheetJS `xlsx` 0.18.5（npm 版） | +332.1 kB（gzip +113.4 kB），其中 xlsx 净增 ≈ +326.4 kB（gzip ≈ +110.6 kB） | 探针真实调用 + vite build |
| exceljs 4.4.0 | 未实测（源码包 21.8MB，直接否决） | `npm view` |
| read-excel-file 9.3.10 | 未实测（源码包 2.47MB，4 个依赖） | `npm view` |

测量注意：

- 探针必须**真实调用**。首版探针只 `void` 引用，tree-shaking 后产物 hash 与基线完全相同
  （增量 0KB 的假数据）；改为真实调用后数据才可信。
- calamine 的增量以两次 release 构建的 exe 差值为准（Cargo.lock 同时存在本工作区其他
  未提交的依赖变更，无法按包归因）。

## 3. 结论对照表

| 维度 | **calamine（采纳）** | fflate + 自研（否决） | SheetJS CDN 0.20.x（备选） | npm xlsx 0.18.5 |
| --- | --- | --- | --- | --- |
| 体积 | +483KB 二进制 | +2.8KB gzip | +111KB gzip | 同 SheetJS 且带 CVE |
| 解析健壮性 | **最强**：生态事实标准，真实世界长尾已被上游踩平 | 自研风险中偏高（date1904 就是设计时漏掉的实证） | 强（全托管） | 强但版本危险 |
| 测试 | 格式解码 cargo test + xlsx 夹具；语义层 vitest 不变 | 全在 vitest | 全在 vitest | — |
| 浏览器演示态 | ✗（Excel 提示用桌面端 / 另存 CSV，CSV 流程照常） | ✓ | ✓ | ✓ |
| 维护 | 上游维护 + 精确锁版本 | 自研 ~200 行 + 长尾自追 | 最低 | — |
| 依赖面 | 纯 Rust（zip + quick-xml），无 C 编译坑 | 零依赖 | 依赖源换成官方 CDN tarball | — |

## 4. 定案理由：为什么从「前端自研」改为 calamine

初评推荐前端自研，核心理由是「三态一致」（浏览器演示态 / vitest / 桌面）与「测试框架统一」。
复核后认定这两条权重给高了，健壮性权重给低了：

1. **演示态只是开发便利，不是产品形态**。产品只有桌面端；演示态下 Excel 明确提示
   「用桌面端或另存 CSV」，CSV 全流程照常可测。
2. **管道边界本来就很干净**。`RosterTable`（二维矩阵）之前是格式解码，之后全是语义
   （表头嗅探、姓名列识别、AI 识别、映射、校验、落库）——语义层留在 TS，vitest 覆盖不变；
   格式解码由 cargo test + xlsx 夹具覆盖。
3. **自研的真实风险在长尾**。设计自研方案时漏掉了 `workbook.xml` 的 date1904 日历系统
   （老 Mac 工作簿序列差 1462 天）——方案评审阶段就漏项，实现在真实文件上只会漏更多。
   calamine 把这些坑都踩完了，且上游继续踩。
4. **+483KB 换核心输入的正确性，与收 rig-core 同一逻辑**（LanceDB 否决是因为 +25MB
   买到的不是核心价值）。

## 5. 已实施方案（2026-09-05）

- **Rust**（`src-tauri/src/roster.rs`，`calamine = "=0.36.1"` 精确锁定）：
  - `roster_read_table`：扩展名守卫（xlsx/xlsm/xlsb/xls/ods）+ 5MB 上限 + 取第一个**有数据**的工作表
    （≥2 行；说明页/占位表在前自动跳过）→ 裁剪空尾列/空行 → 二维字符串矩阵（`RosterGrid`）；
  - 单元格渲染：共享字符串 / inlineStr / 整数（学号不能变浮点）/ 布尔 / 公式错误置空；
  - **日期**：calamine 按样式识别日期单元格 → Excel 1900 序列号转 `YYYY-MM-DD`
    （虚构的 1900-02-29 映射到 1900-03-01；带时间部分追加 HH:MM:SS；1904 系统未处理，留注释）；
  - 文本通道 `roster_read_text` 不变，公共守卫抽成 `read_guarded`。
- **TS**（`src/lib/roster.ts`）：
  - `rosterTableFromGrid`：矩阵 → `RosterTable`（表头嗅探与 CSV 共用同一份语义）；
  - `loadRosterTable` / `pickRosterFile`：按扩展名分流两条通道，返回 `LoadedRoster`
    （含 kind / sheet）；
  - `runSmartImportTable`（表格入口）+ `runSmartImport`（文本入口包装）；
  - 对话框与 Agent 工具 `import_student_roster` 共用，摘要带工作表名。
- **测试**：Rust 5 个（序列转换含 1900 bug 锚点 / 单元格渲染 / 裁剪 / xlsx 夹具端到端 /
  扩展名守卫；夹具由 `scripts/gen-roster-xlsx-fixture.mjs` 生成的手工最小 OOXML，
  覆盖共享字符串 + inlineStr + 整数 + 样式化日期四条路径）；TS 新增 grid 入口与分流用例。

## 6. 风险

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| calamine 对 1904 日期系统（老 Mac 工作簿）的偏移未在上层处理 | 低 | 代码留注释；真实场景几乎不出现，出现时日期归一化兜底并提示人工核对 |
| WPS/学校系统导出的非常规 xlsx | 低 | calamine 上游兼容性积累；解析失败明确报错「另存为 CSV」，与 CSV 路径互补 |
| calamine pre-1.0 破坏性变更 | 低 | `=0.36.1` 精确锁定；解码层收敛在 roster.rs 一个文件 |

## 7. 升级位（仅在前端路线被需要时启用）

若未来出现「必须在前端解析 xlsx」的需求（如纯 Web 版），用 SheetJS 官方 CDN 版：
`package.json` 写 `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`（+111KB gzip），
npm registry 上的版本已冻结且带 CVE，永远不要用。

---

## 附录：落选记录（2026-09-05）

| 方案 | 结论 | 一句话理由 |
| --- | --- | --- |
| fflate + 自研最小读取器 | ❌（初评首选，定案否决） | 体积最小但自研扛不住真实世界长尾（date1904/自定义 numFmt/WPS 变体）；date1904 在方案设计阶段就漏项是直接实证；管道边界干净使 Rust 化的测试成本可控 |
| npm `xlsx@0.18.5` | ❌ | npm 已冻结（官方只经 cdn.sheetjs.com 发布），CVE-2023-30533（原型链污染）与 CVE-2024-22363（ReDoS）在该版本**没有修复路径** |
| exceljs 4.4.0 | ❌ | 源码包 21.8MB、以写/样式为核心，需求只是读 |
| read-excel-file 9.3.10 | ❌ | 功能对口但带 4 个依赖（含 Web Worker 机器），前端路线已败给健壮性，轮不到它 |
| SheetJS CDN 0.20.x | 备位（前端路线兜底） | 唯一的「全托管」前端正解；仅当未来需要纯 Web 解析时启用 |

参考来源：[SheetJS CVE-2023-30533 公告](https://cdn.sheetjs.com/advisories/CVE-2023-30533) ·
[SheetJS CVE-2024-22363 公告](https://cdn.sheetjs.com/advisories/CVE-2024-22363) ·
[SheetJS npm 安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) ·
[calamine（crates.io）](https://crates.io/crates/calamine) ·
[calamine 0.36.1 Changelog](https://docs.rs/crate/calamine/latest/source/Changelog.md)
