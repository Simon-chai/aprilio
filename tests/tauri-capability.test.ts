import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tauri main-window capability", () => {
  it("allows the SQL execute command used by local writes", () => {
    const capability = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"),
    ) as { permissions?: string[] };

    expect(capability.permissions).toContain("sql:allow-execute");
  });

  it("allows the window fullscreen commands used by the fullscreen mode", () => {
    const capability = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"),
    ) as { permissions?: string[] };

    expect(capability.permissions).toContain("core:window:allow-set-fullscreen");
    expect(capability.permissions).toContain("core:window:allow-is-fullscreen");
  });
});
