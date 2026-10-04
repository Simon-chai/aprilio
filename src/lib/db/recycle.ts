/**
 * 回收站域（拆分自 db.ts）：列表 / 恢复 / 彻底删除 / 过期清理 / 学生快照回插。
 */
import { getDb, isTauri, executeBatch } from "./core";
import { mem, now, type MemoryStore } from "./memory-store";
import { expireAtOf, RETENTION_MS } from "./shared";
import type {
  ClassSnapshot,
  Guardian,
  Photo,
  RecycleEntityType,
  RecycleItem,
  StudentBehaviorRecord,
  StudentSnapshot,
} from "../../types";

/* ------------------------------------------------------------------ */
/* 回收站：列表 / 恢复 / 彻底删除 / 过期清理                              */
/* ------------------------------------------------------------------ */

/** SQLite 回收站行（payload 为 JSON 字符串） */
interface RecycleBinRow {
  id: number;
  entity_type: string;
  label: string;
  summary: string;
  payload: string | ClassSnapshot | StudentSnapshot;
  deleted_at: string;
}

/** 行 → 回收站条目：补 expire_at，payload 按需 JSON 反序列化 */
function toRecycleItem(row: RecycleBinRow): RecycleItem {
  let payload: ClassSnapshot | StudentSnapshot;
  if (typeof row.payload === "string") {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = { name: row.label, students: [], classPhotos: [] };
    }
  } else {
    payload = row.payload;
  }
  return {
    id: Number(row.id),
    entity_type: row.entity_type as RecycleEntityType,
    label: row.label,
    summary: row.summary ?? "",
    payload,
    deleted_at: row.deleted_at,
    expire_at: expireAtOf(row.deleted_at),
  };
}

/** 快照里所有照片文件名（彻底删除时同步清落盘文件） */
function snapshotFileNames(payload: ClassSnapshot | StudentSnapshot): string[] {
  if ("classPhotos" in payload) {
    return [
      ...payload.classPhotos.map((p) => p.file_name),
      ...payload.students.flatMap((s) => s.photos.map((p) => p.file_name)),
    ];
  }
  return payload.photos.map((p) => p.file_name);
}

/**
 * 把学生快照展开成语句批与参数（student_id 经 last_insert_rowid() 内联回填）。
 * 供回收站恢复与单条恢复共用；快照内先插 students 行，随后的监护人/照片/表现/评语
 * 都紧跟着引用该行，rowid 回填才可靠。
 */
export function pushStudentSnapshotBatch(
  snap: StudentSnapshot,
  statements: string[],
  params: unknown[]
): void {
  const sid = "(SELECT id FROM students WHERE rowid = last_insert_rowid())";
  statements.push(
    `INSERT INTO students
       (name, gender, birth_date, student_no, grade_class, id_card,
        address, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`
  );
  params.push(
    snap.student.name,
    snap.student.gender,
    snap.student.birth_date,
    snap.student.student_no,
    snap.student.grade_class,
    snap.student.id_card,
    snap.student.address,
    snap.student.status,
    snap.student.note
  );
  for (const g of snap.guardians) {
    statements.push(
      `INSERT INTO guardians (student_id, name, phone, relation, is_primary, occupation, tags) VALUES (${sid}, ?, ?, ?, ?, ?, ?)`
    );
    params.push(g.name, g.phone, g.relation, g.is_primary ? 1 : 0, g.occupation ?? "", JSON.stringify(g.tags ?? []));
  }
  for (const p of snap.photos) {
    statements.push(
      `INSERT INTO photos (student_id, grade_class, file_name, caption, taken_at) VALUES (${sid}, ?, ?, ?, ?)`
    );
    params.push(p.grade_class ?? null, p.file_name, p.caption, p.taken_at);
  }
  for (const b of snap.behaviors) {
    statements.push(
      `INSERT INTO student_behavior_records
         (student_id, dimension_id, dimension_name_snap, category_snap, type, comment, recorded_date, created_at)
       VALUES (${sid}, ?, ?, ?, ?, ?, ?, ?)`
    );
    params.push(
      b.dimension_id,
      b.dimension_name_snap,
      b.category_snap,
      b.type,
      b.comment,
      b.recorded_date,
      b.created_at
    );
  }
  for (const c of snap.termComments ?? []) {
    statements.push(
      `INSERT INTO student_term_comments (student_id, semester, content, source)
       VALUES (${sid}, ?, ?, ?)
       ON CONFLICT(student_id, semester) DO UPDATE SET
         content = excluded.content,
         source = excluded.source`
    );
    params.push(c.semester, c.content, c.source);
  }
}

/** 内存态恢复学生快照（返回新学生 ID） */
function insertStudentSnapshotMemory(store: MemoryStore, snap: StudentSnapshot): number {
  const id = store.nextStudentId++;
  const ts = now();
  const guardians: Guardian[] = snap.guardians.map((g) => ({
    ...g,
    id: store.nextGuardianId++,
    student_id: id,
  }));
  store.guardians.push(...guardians);
  const photos: Photo[] = snap.photos.map((p) => ({
    id: store.nextPhotoId++,
    student_id: id,
    grade_class: p.grade_class ?? null,
    file_name: p.file_name,
    caption: p.caption,
    taken_at: p.taken_at,
    created_at: ts,
  }));
  store.photos.push(...photos);
  const behaviors: StudentBehaviorRecord[] = snap.behaviors.map((b) => ({
    ...b,
    id: store.nextBehaviorRecordId++,
    student_id: id,
  }));
  store.behaviorRecords.push(...behaviors);
  for (const c of snap.termComments ?? []) {
    store.termComments.push({
      id: store.nextTermCommentId++,
      student_id: id,
      semester: c.semester,
      content: c.content,
      source: c.source,
      created_at: ts,
      updated_at: ts,
    });
  }
  store.students.push({
    ...snap.student,
    id,
    guardians,
    created_at: ts,
    updated_at: ts,
  });
  return id;
}

/** 回收站条目列表（打开即先清理过期项） */
export async function listRecycleItems(): Promise<RecycleItem[]> {
  await purgeExpiredRecycleItems();
  if (!isTauri()) {
    return [...mem().recycleBin].sort(
      (a, b) => (a.deleted_at < b.deleted_at ? 1 : -1) || b.id - a.id
    );
  }
  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>(
    "SELECT * FROM recycle_bin ORDER BY deleted_at DESC, id DESC"
  );
  return rows.map(toRecycleItem);
}

/** 恢复回收站条目：班级整体重建（含学生/照片/表现流水），学生档案重新入库 */
export async function restoreRecycleItem(itemId: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const idx = store.recycleBin.findIndex((r) => r.id === itemId);
    if (idx === -1) return;
    const [item] = store.recycleBin.splice(idx, 1);
    if (item.entity_type === "class") {
      const snap = item.payload as ClassSnapshot;
      if (!store.classes.includes(snap.name)) store.classes.push(snap.name);
      for (const s of snap.students) insertStudentSnapshotMemory(store, s);
      const ts = now();
      for (const p of snap.classPhotos) {
        store.photos.push({
          id: store.nextPhotoId++,
          student_id: null,
          grade_class: snap.name,
          file_name: p.file_name,
          caption: p.caption,
          taken_at: p.taken_at,
          created_at: ts,
        });
      }
    } else {
      insertStudentSnapshotMemory(store, item.payload as StudentSnapshot);
    }
    return;
  }

  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>("SELECT * FROM recycle_bin WHERE id = ?", [itemId]);
  if (!rows.length) return;
  const item = toRecycleItem(rows[0]);

  // 恢复的多条 INSERT 与回收站行的删除同一写批原子生效，中途失败不留半恢复状态
  const statements: string[] = [];
  const params: unknown[] = [];
  if (item.entity_type === "class") {
    const snap = item.payload as ClassSnapshot;
    statements.push("INSERT OR IGNORE INTO classes (name) VALUES (?)");
    params.push(snap.name);
    for (const s of snap.students) pushStudentSnapshotBatch(s, statements, params);
    for (const p of snap.classPhotos) {
      statements.push(
        "INSERT INTO photos (student_id, grade_class, file_name, caption, taken_at) VALUES (NULL, ?, ?, ?, ?)"
      );
      params.push(snap.name, p.file_name, p.caption, p.taken_at);
    }
  } else {
    pushStudentSnapshotBatch(item.payload as StudentSnapshot, statements, params);
  }
  statements.push("DELETE FROM recycle_bin WHERE id = ?");
  params.push(itemId);
  await executeBatch(db, statements, params);
}

/** 彻底删除单条回收站条目（连带清落盘图片文件，尽力而为） */
export async function purgeRecycleItem(itemId: number): Promise<void> {
  const items = await listRecycleBinForPurge(itemId);
  await removeRecycleRows([itemId]);
  const fileNames = items.flatMap((i) => snapshotFileNames(i.payload));
  if (fileNames.length && isTauri()) {
    const { deletePhotoFile } = await import("../photos");
    for (const f of fileNames) {
      try {
        await deletePhotoFile(f);
      } catch {
        // 文件可能已不存在，忽略单张失败
      }
    }
  }
}

/** 清空回收站并连带清理落盘图片 */
export async function clearRecycleBin(): Promise<void> {
  const items = await listRecycleItems();
  await removeRecycleRows(items.map((i) => i.id));
  const fileNames = items.flatMap((i) => snapshotFileNames(i.payload));
  if (fileNames.length && isTauri()) {
    const { deletePhotoFile } = await import("../photos");
    for (const f of fileNames) {
      try {
        await deletePhotoFile(f);
      } catch {}
    }
  }
}

/** 读取待清理条目（SQLite 通道；内存通道返回空数组，内存态直接过滤） */
async function listRecycleBinForPurge(itemId: number): Promise<RecycleItem[]> {
  if (!isTauri()) {
    return mem().recycleBin.filter((r) => r.id === itemId);
  }
  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>("SELECT * FROM recycle_bin WHERE id = ?", [itemId]);
  return rows.map(toRecycleItem);
}

async function removeRecycleRows(ids: number[]): Promise<void> {
  if (!ids.length) return;
  if (!isTauri()) {
    const store = mem();
    const idSet = new Set(ids);
    store.recycleBin = store.recycleBin.filter((r) => !idSet.has(r.id));
    return;
  }
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  await db.execute(`DELETE FROM recycle_bin WHERE id IN (${placeholders})`, ids);
}

/** 清理超过保留期（默认 7 天）的回收站条目，连带清落盘图片 */
export async function purgeExpiredRecycleItems(): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const cutoff = Date.now() - RETENTION_MS;
    const expired = store.recycleBin.filter((r) => {
      const t = new Date(r.deleted_at.replace(" ", "T")).getTime();
      return !Number.isNaN(t) && t <= cutoff;
    });
    if (!expired.length) return;
    const expiredIds = new Set(expired.map((r) => r.id));
    store.recycleBin = store.recycleBin.filter((r) => !expiredIds.has(r.id));
    return;
  }

  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>(
    "SELECT * FROM recycle_bin WHERE deleted_at <= datetime('now','localtime','-7 day')"
  );
  if (!rows.length) return;
  const items = rows.map(toRecycleItem);
  await removeRecycleRows(items.map((i) => i.id));
  const fileNames = items.flatMap((i) => snapshotFileNames(i.payload));
  if (fileNames.length) {
    const { deletePhotoFile } = await import("../photos");
    for (const f of fileNames) {
      try {
        await deletePhotoFile(f);
      } catch {}
    }
  }
}
