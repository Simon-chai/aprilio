export type Gender = "男" | "女";

export interface Guardian {
  id?: number;
  student_id?: number;
  name: string;
  phone: string;
  relation: string;
  is_primary?: boolean;
}

export interface Student {
  id: number;
  name: string;
  gender: Gender;
  birth_date: string | null;
  student_no: string;
  grade_class: string;
  enroll_date: string | null;
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
  title: string;
  motto: string;
  avatar: string;
  hero: string;
}

export const DEFAULT_PROFILE: Profile = {
  name: "林老师",
  title: "班主任",
  motto: "让每个孩子，都被看见。",
  avatar: "",
  hero: "",
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
  enroll_date: null,
  address: null,
  status: "active",
  note: null,
  guardians: [],
});

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
