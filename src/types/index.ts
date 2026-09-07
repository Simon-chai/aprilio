export type Gender = "男" | "女";

export interface Guardian {
  id?: number;
  student_id?: number;
  name: string;
  phone: string;
  relation: string;
  is_primary?: boolean;
  /** 职业（选填） */
  occupation?: string;
  /** 风格标签：如「温和」「积极配合」，自由维护 */
  tags?: string[];
}

export interface Student {
  id: number;
  name: string;
  gender: Gender;
  birth_date: string | null;
  student_no: string;
  grade_class: string;
  /** 身份证号（选填，15 或 18 位） */
  id_card: string | null;
  address: string | null;
  status: string;
  note: string | null;
  guardians: Guardian[];
  created_at: string;
  updated_at: string;
}

export type StudentInput = Omit<Student, "id" | "created_at" | "updated_at">;

/** 列表行：额外带主联系人电话与一张图片计数 */
export interface StudentRow extends Student {
  primary_phone?: string | null;
  primary_relation?: string | null;
  photo_count: number;
}

/** 教师个人资料：首页大图与头像都只存文件名（浏览器演示态存 dataURL） */
export interface Profile {
  name: string;
  /** 身份：UI 上限定为 PROFILE_TITLES 枚举；历史数据可能存有旧文案，故仍为 string */
  title: string;
  motto: string;
  avatar: string;
  hero: string;
  /** 任教学科：我的课表的判定条件（subject ∈ my_subjects），如 ["语文"] */
  my_subjects: string[];
  /** 首页课表面板背景图：文件名（桌面端）或 dataURL（浏览器演示态），空串 = 默认无图 */
  timetable_bg: string;
}

/** 身份枚举：个人资料页下拉选择 */
export const PROFILE_TITLES = ["学校管理", "教师", "家长", "学生", "其他"] as const;
export type ProfileTitle = (typeof PROFILE_TITLES)[number];

export const DEFAULT_PROFILE: Profile = {
  name: "林老师",
  title: "教师",
  motto: "让每个孩子，都被看见。",
  avatar: "",
  hero: "",
  my_subjects: [],
  timetable_bg: "",
};

export interface Photo {
  id: number;
  student_id: number | null;
  grade_class?: string | null;
  file_name: string;
  caption: string | null;
  taken_at: string | null;
  created_at: string;
}

export interface ClassSummary {
  name: string;
  studentCount: number;
  maleCount: number;
  femaleCount: number;
  photoCount: number;
  classPhotoCount: number;
  studentPhotoCount: number;
}

/** 列表页顶部三张统计卡 */
export interface Stats {
  students: number;
  photos: number;
  month_new: number;
}

export const emptyStudentInput = (): StudentInput => ({
  name: "",
  gender: "男",
  birth_date: null,
  student_no: "",
  grade_class: "",
  id_card: null,
  address: null,
  status: "active",
  note: null,
  guardians: [],
});

/** 监护人风格标签候选词（可自由输入，不限于候选） */
export const GUARDIAN_TAG_PRESETS = [
  "温和",
  "严格",
  "积极配合",
  "沟通顺畅",
  "关注学习",
  "较少参与",
];

export const STATUS_LABEL: Record<string, string> = {
  active: "在读",
  leave: "休学",
  graduated: "毕业",
  transferred: "转出",
};

/* ------------------------------------------------------------------ */
/* 日常表现记录（三层范式：维度字典 → 事实流水 → 评语沉淀）                */
/* ------------------------------------------------------------------ */

export type BehaviorCategory = "study" | "behavior" | "other";
/** 评价倾向：表扬 👍 | 待改进 ⚠️ | 中立 ➖ */
export type BehaviorPolarity = "praise" | "improve" | "neutral";

export const BEHAVIOR_POLARITY_LABEL: Record<BehaviorPolarity, string> = {
  praise: "表扬",
  improve: "待改进",
  neutral: "中立",
};

export const BEHAVIOR_CATEGORY_LABEL: Record<BehaviorCategory, string> = {
  study: "学习表现",
  behavior: "行为习惯",
  other: "其他表现",
};

/** 维度字典：未来新增事项只插数据，零表结构变更 */
export interface BehaviorDimension {
  id: number;
  category: BehaviorCategory;
  code: string;
  name: string;
  icon?: string | null;
  sort_order: number;
  is_system: number;
  is_active: number;
}

/** 表现事实流水（维度名/分类为快照字段，防字典更名影响历史） */
export interface StudentBehaviorRecord {
  id: number;
  student_id: number;
  dimension_id: number;
  dimension_name_snap: string;
  category_snap: string;
  type: BehaviorPolarity;
  comment: string;
  recorded_date: string;
  created_at: string;
}

/** 班级聚合表现记录（在流水基础上扩展学生主体信息） */
export interface ClassBehaviorRecord extends StudentBehaviorRecord {
  student_name: string;
  student_no?: string;
  student_gender?: Gender;
}

export interface BehaviorInput {
  student_id: number;
  dimension_id: number;
  dimension_name_snap: string;
  category_snap: string;
  type: BehaviorPolarity;
  comment: string;
  recorded_date: string;
}

/** 评语沉淀词条：system 预置 | history 手输沉淀 | ai 采纳沉淀 */
export interface CommentPreset {
  id: number;
  dimension_id: number;
  type: BehaviorPolarity;
  content: string;
  use_count: number;
  source: "system" | "history" | "ai";
}

/* ------------------------------------------------------------------ */
/* 考试与成绩：一次考试 = 一批成绩（考试名 + 考试时间），科目为自由文本     */
/* ------------------------------------------------------------------ */

/** 考试批次：每批成绩归属一次考试，同一班内按「考试名 + 考试时间」幂等复用 */
export interface Exam {
  id: number;
  class_name: string;
  name: string;
  /** 考试时间 YYYY-MM-DD */
  exam_date: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export type ExamInput = Pick<Exam, "class_name" | "name" | "exam_date"> & { note?: string | null };

/** 考试批次 + 统计（班级考试列表用） */
export interface ExamWithStats extends Exam {
  /** 录入了成绩的科目数 */
  subject_count: number;
  /** 成绩条数 */
  score_count: number;
  /** 有成绩的学生数 */
  student_count: number;
}

/** 单条成绩：数字分存 score，等级/缺考等文字存 grade，二者至少其一 */
export interface ExamScore {
  id: number;
  exam_id: number;
  student_id: number;
  subject: string;
  score: number | null;
  grade: string | null;
  created_at: string;
  updated_at: string;
}

/** 成绩行（联学生信息，考试明细表用） */
export interface ExamScoreRow extends ExamScore {
  student_name: string;
  student_no: string | null;
}

/** 学生视角的成绩（联考试信息，学生档案成绩区用） */
export interface StudentExamScore extends ExamScore {
  exam_name: string;
  exam_date: string;
}

/** 班级成绩总览行：学生 × 各次考试总分矩阵 */
export interface ClassScoreOverviewRow {
  student_id: number;
  student_name: string;
  student_no: string | null;
  /** exam_id → { score: 总分, grade: 等级（全部科目皆文字时） } */
  cells: Record<number, { score: number | null; grade: string | null }>;
}

/* ------------------------------------------------------------------ */
/* 课程表：一班一学期一张（班级沿用 grade_class 文本口径），科目自由文本     */
/* 「我的课表」= 全部班级格子中 subject ∈ profile.my_subjects 者的投影      */
/* ------------------------------------------------------------------ */

/** 节次归属：上午 | 下午 */
export type TimetableSession = "morning" | "afternoon";

/** 节次配置（随课表存 JSON）；时间全空时界面只显示节次序号 */
export interface TimetablePeriod {
  period: number;
  session: TimetableSession;
  /** HH:mm，可空串 = 未配置 */
  start: string;
  /** HH:mm，可空串 = 未配置 */
  end: string;
}

/** 课表头：(class_name, semester) 唯一，换学期建新表不覆盖旧表 */
export interface Timetable {
  id: number;
  class_name: string;
  /** 学期号，如 2026-2027-1 */
  semester: string;
  note: string | null;
  /** 节次配置；null = 用默认节次 */
  periods: TimetablePeriod[] | null;
  /**
   * 本班「我的科目」标记：null = 未标记（该班回退按 profile.my_subjects 全局匹配）；
   * [] = 明确标记过「本班没有我的课」；非空 = 本班我的科目集合（班级 × 科目）
   */
  my_subjects: string[] | null;
  created_at: string;
  updated_at: string;
}

/** 课表格子：一行 = 一节课，(timetable_id, day_of_week, period) 唯一，空格子不落行 */
export interface TimetableSlot {
  id: number;
  timetable_id: number;
  /** 1=周一 … 5=周五 */
  day_of_week: number;
  /** 节次，从 1 起 */
  period: number;
  subject: string;
  note: string | null;
  updated_at: string;
}

/** 课表格子联班级名与节次配置（我的课表跨班聚合的原始素材） */
export interface TimetableSlotWithClass extends TimetableSlot {
  class_name: string;
  periods: TimetablePeriod[] | null;
  /** 所属班级的「我的科目」标记（null = 未标记回退全局任教学科，语义同 Timetable） */
  my_subjects: string[] | null;
}

/**
 * 调课覆盖：某班「某天某节」对周课表的一次性覆盖（换课 / 停课 / 加课）。
 * 周课表（timetable_slots）仍是唯一事实源，例外只覆盖单日；subject 为空串 = 该节停课。
 * (timetable_id, exception_date, period) 唯一，删除例外 = 恢复周课默认。
 */
export interface TimetableException {
  id: number;
  timetable_id: number;
  /** YYYY-MM-DD，星期几由日期推导，不落列（避免与日期不一致） */
  exception_date: string;
  period: number;
  subject: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** 调课覆盖联班级名（我的课表 / Agent 聚合投影用） */
export interface TimetableExceptionWithClass extends TimetableException {
  class_name: string;
}

/** 日程事件类型：备忘 / 待办 / 考试 / 作业（广义备忘待办，展示上区分图标与色点） */
export type CalendarEventType = "memo" | "todo" | "exam" | "homework";

/**
 * 统一日程事件：班级日历与教师课表共用的事实源。
 * class_name 为空 = 教师个人事件（不绑班级，只在教师维度展示）；
 * 绑了班级 = 班级事实（班级日历与教师课表都展示）。
 */
export interface CalendarEvent {
  id: number;
  class_name: string | null;
  /** YYYY-MM-DD */
  event_date: string;
  type: CalendarEventType;
  /** 绑定节次（1 起）；null = 全天/日报事件（不落在具体课表格子里） */
  period: number | null;
  content: string;
  /**
   * AI 总结的快速浏览标题（≤12 字，仅已配置 AI 模型时生成）。
   * null = 未生成（未配置模型 / 生成失败）→ 界面退回显示全文前几个字。
   */
  title: string | null;
  /** 0=未完成 1=已完成（考试类也可勾选，表示「已处理」） */
  done: number;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/* 回收站：删除的班级 / 学生以快照进回收站，7 天内可恢复                  */
/* ------------------------------------------------------------------ */

export type RecycleEntityType = "class" | "student";

/** 回收站保留天数，过期自动彻底删除 */
export const RECYCLE_RETENTION_DAYS = 7;

/** 学生完整快照（监护人 / 照片 / 表现流水随之保存，恢复时重新分配 ID） */
export interface StudentSnapshot {
  student: Omit<Student, "id" | "guardians" | "created_at" | "updated_at">;
  guardians: Omit<Guardian, "id" | "student_id">[];
  photos: Pick<Photo, "grade_class" | "file_name" | "caption" | "taken_at">[];
  behaviors: Omit<StudentBehaviorRecord, "id" | "student_id">[];
}

/** 班级快照：班级名 + 全部学生快照 + 班级公共照片 */
export interface ClassSnapshot {
  name: string;
  students: StudentSnapshot[];
  classPhotos: Pick<Photo, "file_name" | "caption" | "taken_at">[];
}

/** 回收站条目（payload 按 entity_type 取对应快照） */
export interface RecycleItem {
  id: number;
  entity_type: RecycleEntityType;
  /** 展示名：班级名 / 学生姓名 */
  label: string;
  /** 摘要：学生数、照片数等 */
  summary: string;
  payload: ClassSnapshot | StudentSnapshot;
  deleted_at: string;
  /** deleted_at + 保留天数，超过即被彻底清除 */
  expire_at: string;
}
