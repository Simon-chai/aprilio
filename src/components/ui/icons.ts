/**
 * AppIcon 静态图标注册表：name → svg 内部元素字符串（<svg> 标签内的内容，不含 <svg> 本身）。
 *
 * 约定（见 docs/superpowers/specs/2026-09-16-ux-debt-foundation-design.md §3.5）：
 * - 统一 24×24 网格；元素不写色值，颜色由 AppIcon 的 currentColor 继承文字色
 * - path 优先拷贝自现有内联 SVG（视觉零变化），来源在每条注释注明；
 *   原图不在 24 网格时按同风格等比换算，个别手绘项亦注明
 * - 原图描边粗细随来源保留在元素上（svg 级默认 1.5，来源不同的粗细不抹平）
 * - 填充式图标（原为 fill 而非 stroke）在元素上写 fill="currentColor" stroke="none" 覆盖
 * - 安全要求（规格 §8）：全部为编译期静态常量，不接收任何外部 SVG 输入，v-html 无注入面
 */
export const ICONS: Record<string, string> = {
  /* 垃圾桶：拷贝自 ClassesView「删除班级」菜单（ClassDetailView / StudentDetailView /
     StudentFormDialog 同款共 4 份，spec 盘点的 4 连垃圾桶） */
  trash:
    '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" />' +
    '<path d="M10 11v6M14 11v6" stroke-width="2" />',

  /* 左箭头 chevron：镜像自 ClassDetailView 指标卡右箭头（与 chevron-right 同族成对） */
  "chevron-left": '<path d="m15 18-6-6 6-6" stroke-width="2.5" />',

  /* 右箭头 chevron：拷贝自 ClassDetailView 指标卡（4 处同款，最常用的一份） */
  "chevron-right": '<path d="m9 18 6-6-6-6" stroke-width="2.5" />',

  /* 下箭头 chevron：拷贝自 ModelSwitcher 模型下拉（AgentChat「展开对话」同款） */
  "chevron-down": '<path d="m6 9 6 6 6-6" stroke-width="2" />',

  /* 关闭 ✕：现有关闭按钮均为 16 网格（MemoHistoryDrawer / MyTimetableView /
     HomeView `M3.5 3.5l9 9M12.5 3.5l-9 9`），等比放大 1.5 倍到 24 网格 */
  close: '<path d="M5.25 5.25l13.5 13.5M18.75 5.25l-13.5 13.5" stroke-width="2.25" />',

  /* 返回箭头：拷贝自 ClassesView 顶栏「首页」返回按钮（24 网格原样，
     AppLink 的 back 图标为同形状，替换时与其视觉对齐） */
  "arrow-left": '<path d="M15 5l-7 7 7 7" stroke-width="2" />',

  /* 加号：现有加号均在 16 / 20 网格（PhotoGrid 关联图片等），按垃圾桶 / 编辑同族
     细线条风格手绘 24 网格版本 */
  plus: '<path d="M12 5v14M5 12h14" stroke-width="2" />',

  /* 齿轮：AppSidebar「数据与设置」齿轮为 16 网格，等比放大 1.5 倍（圆心 + 八辐条） */
  gear:
    '<circle cx="12" cy="12" r="3.3" stroke-width="2.1" />' +
    '<path d="M12 2.55v2.25M12 19.2v2.25M4.35 4.35l1.65 1.65M18 18l1.65 1.65M2.55 12h2.25M19.2 12h2.25M4.35 19.65l1.65-1.65M18 6l1.65-1.65" stroke-width="2.1" />',

  /* 讲台板书（班级）：拷贝自 ClassesView 班级卡（RecycleBinView 同款共 2 份） */
  podium:
    '<rect x="4" y="7" width="16" height="13" rx="2" stroke-width="1.8" />' +
    '<path d="M12 7V4.5M12 4.5l7 2.5-7 2.5L5 7l7-2.5z" stroke-width="1.8" />',

  /* 照片（山与日）：拷贝自 EmptyState 空状态插画（原图太阳为填充式圆点） */
  photo:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="3" />' +
    '<path d="M4.5 16.5l4.5-4.2 3.4 3.1 3-2.7 3.8 3.6" />' +
    '<circle cx="8.8" cy="9.4" r="1.5" fill="currentColor" stroke="none" />',

  /* 人像：拷贝自 RecycleBinView 学生类型图标（填充式，原图自带 0.85 透明度保留） */
  person:
    '<circle cx="12" cy="8.5" r="4" fill="currentColor" stroke="none" opacity="0.85" />' +
    '<path d="M4 20c0-4 3.6-6.4 8-6.4s8 2.4 8 6.4" fill="currentColor" stroke="none" opacity="0.85" />',

  /* 房子（首页）：拷贝自 ClassesView「新建班级」按钮的房子轮廓（去掉其中的加号笔画） */
  home:
    '<path d="M3.8 11 12 4.3 20.2 11v9a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8Z" stroke-width="1.8" />',

  /* 日历：拷贝自 HomeView 课表入口图标（MyTimetableCalendar 同族） */
  calendar:
    '<path d="M4.6 5.4h14.8a1.6 1.6 0 0 1 1.6 1.6v11.6a1.6 1.6 0 0 1-1.6 1.6H4.6a1.6 1.6 0 0 1-1.6-1.6V7a1.6 1.6 0 0 1 1.6-1.6ZM8.2 3v4M15.8 3v4M3.4 10.2h17.2" stroke-width="1.8" />',

  /* 时钟：拷贝自 HomeView 番茄钟入口（表盘 + 指针） */
  clock:
    '<circle cx="12" cy="12" r="8.2" stroke-width="1.8" />' +
    '<path d="M12 7.6V12l3 1.8" stroke-width="1.8" />',

  /* 更多（⋯）：拷贝自 ClassesView 班级卡「更多操作」菜单（填充式三点） */
  "more-horiz":
    '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" />' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />' +
    '<circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none" />',

  /* 编辑（铅笔）：拷贝自 ClassesView 班级名旁编辑（ClassDetailView「编辑」按钮同款共 2 份） */
  edit:
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke-width="2" />' +
    '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke-width="2" />',

  /* 归档（收纳箱）：拷贝自 ClassesView「归档班级」菜单（ClassDetailView 同款共 2 份） */
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1" stroke-width="2" />' +
    '<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" stroke-width="2" />',

  /* 恢复（逆时针回环箭头）：拷贝自 HomeView 番茄钟「重置」按钮 */
  restore:
    '<path d="M4 9a8.1 8.1 0 1 1-.9 5" stroke-width="1.8" />' +
    '<path d="M4 3.8V9h5.2" stroke-width="1.8" />',

  /* 警告（三角 + 感叹号）：现有代码无警告图标，按同风格手绘
     （24 网格、细线条、圆角端点；感叹点用零长度路径 + 圆头笔画） */
  warn:
    '<path d="M12 4.2 20.8 19.2H3.2L12 4.2Z" stroke-width="1.8" />' +
    '<path d="M12 9.8v4.4" stroke-width="1.8" />' +
    '<path d="M12 17.2h.01" stroke-width="1.8" />',

  /* 对勾：拷贝自 ModelSwitcher 模型菜单选中勾（弹层确认场景同款） */
  check: '<path d="M5 13l4 4L19 7" stroke-width="2.4" />',
};
