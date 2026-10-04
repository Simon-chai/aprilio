/**
 * 学生照片域（拆分自 db.ts）：按学生挂接的照片记录（文件本体由 lib/photos 管）。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import type { Photo } from "../../types";


export async function listPhotos(studentId?: number): Promise<Photo[]> {
  if (!isTauri()) {
    return mem()
      .photos.filter((p) => studentId === undefined || p.student_id === studentId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  const db = await getDb();
  return db.select<Photo[]>(
    `SELECT * FROM photos
      WHERE (? IS NULL OR student_id = ?)
      ORDER BY created_at DESC, id DESC`,
    [studentId ?? null, studentId ?? null]
  );
}

export async function addPhoto(
  studentId: number,
  fileName: string,
  caption: string | null = null,
  takenAt: string | null = null
): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const id = store.nextPhotoId++;
    store.photos.push({
      id,
      student_id: studentId,
      file_name: fileName,
      caption,
      taken_at: takenAt,
      created_at: now(),
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO photos (student_id, file_name, caption, taken_at) VALUES (?, ?, ?, ?)",
    [studentId, fileName, caption, takenAt]
  );
  return Number(result.lastInsertId ?? 0);
}

export async function deletePhoto(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.photos = store.photos.filter((p) => p.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM photos WHERE id = ?", [id]);
}
