export type ProfileSaveErrorKind = "database-permission" | "database-write";

const PERMISSION_ERROR =
  /not\s+allowed|permission|denied|forbidden|not\s+permitted|unauthori[sz]ed|不允许|禁止/i;
const EXECUTE_ERROR = /\bexecute\b|sql(?:ite)?[^\n]*(?:write|execute)/i;

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name} ${value.message}`;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  return ["name", "message", "code", "reason", "error"]
    .map((key) => record[key])
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ");
}

export function classifyProfileSaveError(value: unknown): ProfileSaveErrorKind {
  const text = errorText(value);
  return EXECUTE_ERROR.test(text) && PERMISSION_ERROR.test(text)
    ? "database-permission"
    : "database-write";
}

export function profileSaveErrorMessage(value: unknown): string {
  if (classifyProfileSaveError(value) === "database-permission") {
    return "保存失败：应用没有本地数据库写入权限，请重启应用后重试；如果仍失败，请联系维护人员。";
  }
  return "保存失败：本地资料暂时无法保存，请重试。";
}

export function profileSaveErrorDiagnostic(value: unknown): string {
  const text = errorText(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : "unknown-error";
}
