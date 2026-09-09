# 背景图库（首页大图 / 头像 / 课表背景）

三类背景图（avatar、hero、timetable_bg）共用同一套「本地索引 + 本地缓存」机制。
所有图片操作走同一个选择器 `src/components/BackgroundPickerDialog.vue`：
个人资料页的「更换 / 选择图片」与首页课表面板的相机按钮打开的都是它，
弹窗内提供 本地上传 / 粘贴图片链接（自动下载到本地缓存）/ 历史缩略图切换 / 移除当前背景，
**没有第二个图片入口**。

**图库池划分**：头像独立成池；**首页大图与课表背景共享同一套图库**——必应壁纸、
课表用图在首页大图弹窗里同样可选，反之亦然（`pickerBackgrounds`，弹窗内文字有提示）。
共享池内按 origin_url（网络图）/ file（本地图）跨 kind 去重，一张图只有一条索引、
一个缓存文件，删除时由 `clearProfileImageRefs` 同步清掉个人资料里所有引用该文件的字段。

## 裁剪取景（课表背景专用）

选择器带 `crop` 属性时（目前只有 `timetable_bg`），本地上传与图片链接都先进裁剪窗
`src/components/ImageCropDialog.vue`，确认后才落盘入库。裁剪用现成类库
**cropperjs v1**（`npm: cropperjs@^1.6.2`），不自研几何：

- **原图完整可见，选区外自动变暗**——选了什么、裁掉了什么一目了然；
- 选区可拖到图片**任意位置**（包括正中间），边角拉伸改变取景范围，比例锁定 16:9；
- 拖选区外空白处移动图片，滚轮缩放图片；
- 组件配置：`aspectRatio = 16/9`（与各课表卡片表面比例一致）、`viewMode: 1`
  （图片不超出画布）、`dragMode: "move"`、`background: false`；
- 确认导出：`getCroppedCanvas({ width: 1600, fillColor: "#fff" })` → JPEG（质量 0.9）；
- 数据流（桌面端）：`read_image_bytes` / `download_background` 返回**字节流**
  `{mime, base64}`（不落盘）→ 前端转成 **blob: URL** 进裁剪窗（超大图不要做成 dataURL：
  WebView2 里 img.src 大 dataURL 会加载失败，ready 永不触发、确认键一直禁用）→
  确认导出小图 dataURL（1600 宽 JPEG，几百 KB）→ `save_background_data_url`
  校验并写 `backgrounds/bg_<时间戳>.jpg`；
- 浏览器演示态：file input / fetch 取原图（dataURL 直接当 src）→ 裁剪导出 dataURL 当缓存标识；
- 确认链路的三处失败（未就绪 / getCroppedCanvas 为空 / toDataURL 异常）都在裁剪窗内
  显示可见错误（`crop-confirm-error`），不再静默返回；
- 测试：`tests/image-crop-dialog.test.ts` 用 FakeCropper 替身断言初始化参数、
  导出参数与销毁时机（jsdom 无 canvas，跑不了真 cropper）。
- 其他背景（头像、首页大图）不裁剪，沿用原直存路径。

## 课表背景图的铺设位置与统一比例

`timetable_bg` 设置后铺在所有课表展示表面（浅色表面用白雾打底保证网格文字可读），
且**统一 16:9**——与裁剪窗口比例一致，裁剪时看到的取景就是各位置的显示区域
（`lib/profile.ts` 的 `timetableBgSurfaceClass`，有背景图时才挂 `aspect-[16/9]`；
CSS aspect-ratio 是最小比例，内容更高时卡片随之长高，不裁内容）：

| 位置 | 实现 | 比例 |
| --- | --- | --- |
| 我的课表 · 周课表卡片 | `MyTimetableView` `week-timetable-surface` | 16:9 |
| 我的课表 · 按科目卡片 | `MyTimetableView` AppCard `:style` 透传 | 16:9 |
| 班级详情 · 周课表网格 | `ClassDetailView` `class-timetable-surface` | 16:9 |
| 班级详情 · 万年历卡片 | `TimetableCalendar` `surfaceStyle`/`surfaceClass` prop | 16:9 |
| 首页课表面板（展开后） | `HomeView` `panelBgStyle`（深色遮罩版） | 随内容（浮动小部件） |

样式统一由 `lib/profile.ts` 的 `timetableBgSrc`（深色遮罩）与 `timetableBgSurfaceStyle`
（白雾 0.86）导出；未设置时均为 `undefined`，卡片保持纯色、不挂比例。

## 数据来源

| 来源 | 入口 | 落盘位置 | 缓存标识 |
| --- | --- | --- | --- |
| 本地上传 | 系统选择框（`import_photo`） | `appData/photos/` | `img_<时间戳>.<ext>` |
| 网络 URL | Rust `download_background`（字节流）→ `save_background_data_url` 落盘 | `appData/backgrounds/` | `bg_<时间戳>.<ext>` |
| 自动更新（Bing 每日壁纸） | 同「网络 URL」管线，由 `src/lib/wallpaper.ts` 驱动 | `appData/backgrounds/` | `bg_<时间戳>.<ext>` |
| 裁剪确认 | 前端 canvas 导出 JPEG → `save_background_data_url` | `appData/backgrounds/` | `bg_<时间戳>.jpg` |
| 浏览器演示态 | file input / fetch → 裁剪导出 dataURL | localStorage（dataURL） | dataURL 本身 |

- 网络图片走 Rust 而非前端 fetch：绕开 WebView 的 CORS 限制，且落盘后离线也能显示。
  `download_background` 现在只回字节流（`{mime, base64}`），落盘统一由
  `save_background_data_url` 负责（校验 dataURL + magic bytes，上限 12 MB）。
- 同一 URL 重复添加：直接复用旧记录，不会重复下载。
- 同一 URL 先进裁剪窗：`importUrlBackground` 的直存路径与裁剪路径共用同一套字节流。

## 必应壁纸（手动入库）

必应近期壁纸**不再自动更新背景**（2026-09-09 起）：设置页「必应壁纸」卡片点
「拉取必应壁纸」手动入库，拉进来的图与课表/首页图库共享，用户在选图弹窗里自行挑用。

- **入口**：设置页「必应壁纸」→ `importBingWallpapers()`（src/lib/wallpaper.ts）；
  浏览器演示态给出不可用提示。
- **取图**：Rust `fetch_bing_wallpaper`（[backgrounds.rs](../src-tauri/src/backgrounds.rs)）
  请求 `cn.bing.com/HPImageArchive.aspx?format=js` 按 `count`（1..=8，默认 7）拿最近几天的
  1920x1080 图片地址（与课表背景 16:9 一致，免裁剪），第 0 张是当天；下载仍走
  `download_background`，与手动粘贴链接共用同一条管线；图库展示名用 Bing 标题。
- **不换背景**：入库来源记为 `timetable_bg`（共享池），不写 profile 的任何背景字段；
  是否启用、用在首页还是课表，全部由用户在选图弹窗里决定。
- **去重**：共享池按 `origin_url` 去重，重复拉取只刷新使用时间、不重复下载。
- **容错**：个别壁纸下载失败只 `console.error` 跳过；一张都没进库才向上抛错
  （设置页显示失败提示）。
- **配置**：localStorage `aprilio.wallpaper.v1`（`{ count, last_date }`，
  默认拉 7 天；`last_date` 仅用于「上次拉取」展示，旧版 `enabled/last_url` 字段读取时忽略）。
- 测试：`tests/wallpaper.test.ts`（拉取入库不换背景 / 张数透传 / 重复拉取复用 /
  单张失败跳过 / 全失败抛错 / 浏览器态拒绝 / 张数收敛）。

## 索引（`src/lib/backgrounds.ts`）

- 结构：`BackgroundImage { id, kind, file, source, origin_url, name, added_at, used_at }`（见 `src/types/index.ts`）。
- 存储：localStorage `aprilio.backgrounds.v1`（纯本地，不同步任何云端）。读取时 `sanitize()` 兜底脏数据。
- 排序：按 `used_at` 倒序，最近用过的排在最前，切换回旧图只需一次点击。
- 上限：头像 12 张；首页大图 + 课表背景共享池 24 张，超出淘汰最久未用的
  （最新一张永远保留，避免删掉正在用的图）。
- 去重：同一 URL 重复添加复用同一条记录，不会重复下载。

## 生命周期

- 选中即入库（`registerLocalBackground` / `importUrlBackground`），换下来的旧图**不删除**，留在库里可切回。
- 弹窗通过 `busy` 事件把上传/下载状态上报给宿主页面：选图进行中禁用编辑控件并拦截离开。
- 只有三种清理：
  1. 用户显式删除（图库缩略图上的 ×）：删索引 + 删缓存文件；删的是当前背景时回调 `clear`。
  2. 选了但没保存就离开编辑页（`discardBackgroundFile`，含弹窗被卸载时未结算的选图）。
  3. 设置页「清空数据」调 `clearBackgroundLibrary()`，索引与缓存文件一并删除。

## 新增一类背景图

1. `src/types/index.ts` 的 `BackgroundKind` 加成员；
2. `BackgroundPickerDialog.vue` 的 `TITLES` 加中文名；
3. 若需要新的 Rust 能力（新目录 / 新下载源），在 `src-tauri/src/backgrounds.rs` 加命令并挂进
   `lib.rs` 的 `generate_handler!`（变更命令白名单时同步 `capabilities.rs` 的 `KNOWN_COMMANDS`）。
