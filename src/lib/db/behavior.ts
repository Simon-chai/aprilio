/**
 * 日常表现域（拆分自 db.ts）：维度字典 / 事实流水 / 评语沉淀（三层范式）。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import { localDateStr } from "../format";
import type {
  BehaviorDimension,
  BehaviorInput,
  ClassBehaviorRecord,
  CommentPreset,
  StudentBehaviorRecord,
} from "../../types";

/* ------------------------------------------------------------------ */
/* 日常表现：维度字典 / 事实流水 / 评语沉淀（三层范式）                     */
/* ------------------------------------------------------------------ */

/** 维度字典列表（启用中的，按 sort_order 排序） */
export async function listBehaviorDimensions(): Promise<BehaviorDimension[]> {
  if (!isTauri()) {
    return mem()
      .behaviorDimensions.filter((d) => d.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  }
  const db = await getDb();
  return db.select<BehaviorDimension[]>(
    "SELECT * FROM behavior_dimensions WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
  );
}

/** 新增自定义维度（is_system = 0，category 固定 other，code 自动生成） */
export async function createBehaviorDimension(name: string): Promise<BehaviorDimension> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("维度名称不能为空");
  if (trimmed.length > 12) throw new Error("维度名称请控制在 12 字以内");

  const code = `custom_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

  if (!isTauri()) {
    const store = mem();
    const maxOrder = Math.max(0, ...store.behaviorDimensions.map((d) => d.sort_order));
    const dim: BehaviorDimension = {
      id: store.nextDimensionId++,
      category: "other",
      code,
      name: trimmed,
      icon: null,
      sort_order: maxOrder + 1,
      is_system: 0,
      is_active: 1,
    };
    store.behaviorDimensions.push(dim);
    return { ...dim };
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO behavior_dimensions (category, code, name, icon, sort_order, is_system)
     VALUES ('other', ?, ?, NULL,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM behavior_dimensions), 0)`,
    [code, trimmed]
  );
  const id = Number(result.lastInsertId ?? 0);
  return {
    id,
    category: "other",
    code,
    name: trimmed,
    icon: null,
    sort_order: 0,
    is_system: 0,
    is_active: 1,
  };
}

/**
 * 写入一条表现流水，并同步评语沉淀（自学习闭环）：
 * 已有同 (维度, 倾向, 内容) 词条 → use_count+1；没有 → 新增 source='history'。
 */
export async function addBehaviorRecord(input: BehaviorInput): Promise<number> {
  if (!input.student_id) throw new Error("缺少学生");
  const comment = input.comment.trim();
  if (!comment) throw new Error("评语内容不能为空");
  if (comment.length > 200) throw new Error("评语请控制在 200 字以内");
  if (input.type !== "praise" && input.type !== "improve" && input.type !== "neutral")
    throw new Error("评价倾向不合法");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recorded_date)) throw new Error("日期格式不合法");
  if (input.recorded_date > localDateStr()) throw new Error("不能录入未来日期");

  if (!isTauri()) {
    const store = mem();
    const dim = store.behaviorDimensions.find((d) => d.id === input.dimension_id);
    if (!dim) throw new Error("评价维度不存在");

    const id = store.nextBehaviorRecordId++;
    store.behaviorRecords.push({
      id,
      student_id: input.student_id,
      dimension_id: dim.id,
      dimension_name_snap: dim.name,
      category_snap: dim.category,
      type: input.type,
      comment,
      recorded_date: input.recorded_date,
      created_at: now(),
    });

    const preset = store.commentPresets.find(
      (p) => p.dimension_id === dim.id && p.type === input.type && p.content === comment
    );
    if (preset) {
      preset.use_count += 1;
      preset.last_used_at = now();
    } else {
      store.commentPresets.push({
        id: store.nextCommentPresetId++,
        dimension_id: dim.id,
        type: input.type,
        content: comment,
        use_count: 1,
        source: "history",
        last_used_at: now(),
      });
    }
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO student_behavior_records
       (student_id, dimension_id, dimension_name_snap, category_snap, type, comment, recorded_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.student_id,
      input.dimension_id,
      input.dimension_name_snap,
      input.category_snap,
      input.type,
      comment,
      input.recorded_date,
    ]
  );

  const existing = await db.select<{ id: number }[]>(
    `SELECT id FROM behavior_comment_presets
      WHERE dimension_id = ? AND type = ? AND content = ? LIMIT 1`,
    [input.dimension_id, input.type, comment]
  );
  if (existing[0]) {
    await db.execute(
      `UPDATE behavior_comment_presets
          SET use_count = use_count + 1, last_used_at = datetime('now','localtime')
        WHERE id = ?`,
      [existing[0].id]
    );
  } else {
    await db.execute(
      `INSERT INTO behavior_comment_presets (dimension_id, type, content, use_count, source)
       VALUES (?, ?, ?, 1, 'history')`,
      [input.dimension_id, input.type, comment]
    );
  }
  return Number(result.lastInsertId ?? 0);
}

/**
 * 删除一条表现流水，并对称回退评语沉淀：
 * 同 (维度, 倾向, 内容) 词条 use_count-1；history 来源的词条计数归零后随之移除。
 */
export async function deleteBehaviorRecord(recordId: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const idx = store.behaviorRecords.findIndex((r) => r.id === recordId);
    if (idx === -1) return;
    const [rec] = store.behaviorRecords.splice(idx, 1);
    const preset = store.commentPresets.find(
      (p) => p.dimension_id === rec.dimension_id && p.type === rec.type && p.content === rec.comment
    );
    if (preset && preset.use_count > 0) {
      preset.use_count -= 1;
      if (preset.source === "history" && preset.use_count <= 0) {
        store.commentPresets = store.commentPresets.filter((p) => p.id !== preset.id);
      }
    }
    return;
  }

  const db = await getDb();
  const rows = await db.select<
    { dimension_id: number; type: string; comment: string }[]
  >(
    `SELECT dimension_id, type, comment FROM student_behavior_records WHERE id = ?`,
    [recordId]
  );
  if (!rows.length) return;
  const rec = rows[0];
  await db.execute(`DELETE FROM student_behavior_records WHERE id = ?`, [recordId]);
  await db.execute(
    `UPDATE behavior_comment_presets SET use_count = use_count - 1
      WHERE dimension_id = ? AND type = ? AND content = ? AND use_count > 0`,
    [rec.dimension_id, rec.type, rec.comment]
  );
  await db.execute(
    `DELETE FROM behavior_comment_presets WHERE source = 'history' AND use_count <= 0`
  );
}

/**
 * 更新一条表现流水，并同步评语沉淀（对称迁移）：
 * (维度, 倾向, 内容) 有变化时，旧词条 use_count-1（history 来源归零移除）、新词条 use_count+1（没有则新增 history）；
 * 未变化时（如只改日期 / 学生）不动沉淀，避免计数抖动。校验口径与新增一致。
 */
export async function updateBehaviorRecord(recordId: number, input: BehaviorInput): Promise<void> {
  if (!input.student_id) throw new Error("缺少学生");
  const comment = input.comment.trim();
  if (!comment) throw new Error("评语内容不能为空");
  if (comment.length > 200) throw new Error("评语请控制在 200 字以内");
  if (input.type !== "praise" && input.type !== "improve" && input.type !== "neutral")
    throw new Error("评价倾向不合法");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recorded_date)) throw new Error("日期格式不合法");
  if (input.recorded_date > localDateStr()) throw new Error("不能录入未来日期");

  if (!isTauri()) {
    const store = mem();
    const rec = store.behaviorRecords.find((r) => r.id === recordId);
    if (!rec) return;
    const dim = store.behaviorDimensions.find((d) => d.id === input.dimension_id);
    if (!dim) throw new Error("评价维度不存在");

    const presetChanged =
      rec.dimension_id !== dim.id || rec.type !== input.type || rec.comment !== comment;
    if (presetChanged) {
      const oldPreset = store.commentPresets.find(
        (p) => p.dimension_id === rec.dimension_id && p.type === rec.type && p.content === rec.comment
      );
      if (oldPreset && oldPreset.use_count > 0) {
        oldPreset.use_count -= 1;
        if (oldPreset.source === "history" && oldPreset.use_count <= 0) {
          store.commentPresets = store.commentPresets.filter((p) => p.id !== oldPreset.id);
        }
      }
    }

    rec.student_id = input.student_id;
    rec.dimension_id = dim.id;
    rec.dimension_name_snap = dim.name;
    rec.category_snap = dim.category;
    rec.type = input.type;
    rec.comment = comment;
    rec.recorded_date = input.recorded_date;

    if (presetChanged) {
      const preset = store.commentPresets.find(
        (p) => p.dimension_id === dim.id && p.type === input.type && p.content === comment
      );
      if (preset) {
        preset.use_count += 1;
        preset.last_used_at = now();
      } else {
        store.commentPresets.push({
          id: store.nextCommentPresetId++,
          dimension_id: dim.id,
          type: input.type,
          content: comment,
          use_count: 1,
          source: "history",
          last_used_at: now(),
        });
      }
    }
    return;
  }

  const db = await getDb();
  const rows = await db.select<
    { dimension_id: number; type: string; comment: string }[]
  >(
    `SELECT dimension_id, type, comment FROM student_behavior_records WHERE id = ?`,
    [recordId]
  );
  if (!rows.length) return;
  const old = rows[0];
  const presetChanged =
    old.dimension_id !== input.dimension_id || old.type !== input.type || old.comment !== comment;

  await db.execute(
    `UPDATE student_behavior_records
        SET student_id = ?, dimension_id = ?, dimension_name_snap = ?, category_snap = ?,
            type = ?, comment = ?, recorded_date = ?
      WHERE id = ?`,
    [
      input.student_id,
      input.dimension_id,
      input.dimension_name_snap,
      input.category_snap,
      input.type,
      comment,
      input.recorded_date,
      recordId,
    ]
  );

  if (!presetChanged) return;

  await db.execute(
    `UPDATE behavior_comment_presets SET use_count = use_count - 1
      WHERE dimension_id = ? AND type = ? AND content = ? AND use_count > 0`,
    [old.dimension_id, old.type, old.comment]
  );
  await db.execute(
    `DELETE FROM behavior_comment_presets WHERE source = 'history' AND use_count <= 0`
  );

  const existing = await db.select<{ id: number }[]>(
    `SELECT id FROM behavior_comment_presets
      WHERE dimension_id = ? AND type = ? AND content = ? LIMIT 1`,
    [input.dimension_id, input.type, comment]
  );
  if (existing[0]) {
    await db.execute(
      `UPDATE behavior_comment_presets
          SET use_count = use_count + 1, last_used_at = datetime('now','localtime')
        WHERE id = ?`,
      [existing[0].id]
    );
  } else {
    await db.execute(
      `INSERT INTO behavior_comment_presets (dimension_id, type, content, use_count, source)
       VALUES (?, ?, ?, 1, 'history')`,
      [input.dimension_id, input.type, comment]
    );
  }
}

/** 常用评语：按使用频次取前 N 条（默认 4） */
export async function listCommentPresets(
  dimensionId: number,
  type: CommentPreset["type"],
  limit = 4
): Promise<CommentPreset[]> {
  if (!isTauri()) {
    return mem()
      .commentPresets.filter((p) => p.dimension_id === dimensionId && p.type === type)
      .sort(
        (a, b) => b.use_count - a.use_count || (a.last_used_at < b.last_used_at ? 1 : -1) || a.id - b.id
      )
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        dimension_id: p.dimension_id,
        type: p.type,
        content: p.content,
        use_count: p.use_count,
        source: p.source,
      }));
  }
  const db = await getDb();
  return db.select<CommentPreset[]>(
    `SELECT id, dimension_id, type, content, use_count, source
       FROM behavior_comment_presets
      WHERE dimension_id = ? AND type = ?
      ORDER BY use_count DESC, last_used_at DESC, id ASC
      LIMIT ?`,
    [dimensionId, type, limit]
  );
}

/** 表现流水查询（详情页/统计用，默认最近 100 条） */
export async function listBehaviorRecords(
  studentId?: number,
  limit = 100
): Promise<StudentBehaviorRecord[]> {
  if (!isTauri()) {
    return mem()
      .behaviorRecords.filter((r) => studentId === undefined || r.student_id === studentId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  const db = await getDb();
  return db.select<StudentBehaviorRecord[]>(
    `SELECT * FROM student_behavior_records
      WHERE (? IS NULL OR student_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [studentId ?? null, studentId ?? null, limit]
  );
}

/** 班级表现流水查询（班级管理时间轴用，带学生基本快照信息） */
export async function listBehaviorRecordsByClass(
  className: string,
  limit = 200
): Promise<ClassBehaviorRecord[]> {
  if (!isTauri()) {
    const store = mem();
    const classStudents = store.students.filter((s) => s.grade_class === className);
    const studentMap = new Map(classStudents.map((s) => [s.id, s]));
    return store.behaviorRecords
      .filter((r) => studentMap.has(r.student_id))
      .map((r) => {
        const s = studentMap.get(r.student_id)!;
        return {
          ...r,
          student_name: s.name,
          student_no: s.student_no,
          student_gender: s.gender,
        };
      })
      .sort((a, b) => {
        const da = a.recorded_date || a.created_at;
        const db = b.recorded_date || b.created_at;
        if (da !== db) return da < db ? 1 : -1;
        return b.id - a.id;
      })
      .slice(0, limit);
  }
  const db = await getDb();
  return db.select<ClassBehaviorRecord[]>(
    `SELECT 
      r.*,
      s.name AS student_name,
      s.student_no,
      s.gender AS student_gender
    FROM student_behavior_records r
    INNER JOIN students s ON r.student_id = s.id
    WHERE s.grade_class = ?
    ORDER BY r.recorded_date DESC, r.created_at DESC, r.id DESC
    LIMIT ?`,
    [className, limit]
  );
}

