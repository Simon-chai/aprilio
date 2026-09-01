import { describe, expect, it } from "vitest";
import {
  classifyProfileSaveError,
  profileSaveErrorDiagnostic,
  profileSaveErrorMessage,
} from "../src/lib/error-message";

describe("profile save errors", () => {
  it("recognizes an execute permission rejection", () => {
    const cause = { message: "command execute not allowed by ACL" };

    expect(classifyProfileSaveError(cause)).toBe("database-permission");
    expect(profileSaveErrorMessage(cause)).toBe(
      "保存失败：应用没有本地数据库写入权限，请重启应用后重试；如果仍失败，请联系维护人员。",
    );
  });

  it("hides low-level details for an ordinary persistence failure", () => {
    const cause = new Error("SQLITE_BUSY: database is locked");

    expect(classifyProfileSaveError(cause)).toBe("database-write");
    expect(profileSaveErrorMessage(cause)).toBe(
      "保存失败：本地资料暂时无法保存，请重试。",
    );
  });

  it("keeps diagnostic details bounded and excludes arbitrary object fields", () => {
    const cause = {
      message: "command execute not allowed by ACL",
      profileName: "林老师",
    };

    expect(profileSaveErrorDiagnostic(cause)).toBe("command execute not allowed by ACL");
    expect(profileSaveErrorDiagnostic(cause)).not.toContain("林老师");
  });
});
