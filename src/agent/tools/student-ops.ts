/**
 * 工具：manage_students —— 学生档案领域写操作（声明式注册，default export 即被容器装载）。
 *
 * 核心领域操作：创建学生、更新基本信息/备注、删除学生，直接调用 lib/db.ts。
 * 标记为写操作（dangerous: true，tags: ["students", "write"]），必须包含 confirm 参数并在用户同意后执行。
 */
import { createStudent, deleteStudent, getStudent, updateStudent } from "../../lib/db";
import { defineAgentTool } from "../define";
import type { Guardian, StudentInput } from "../../types";

export default defineAgentTool({
  name: "manage_students",
  label: "学生管理",
  description:
    "对学生档案进行写操作：创建学生（create）、更新基本信息或备注（update）、删除学生（delete）。此工具会直接修改应用数据库，必须先征得用户同意并附带 confirm:true 确认。",
  tags: ["students", "write"],
  dangerous: true,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete"],
        description: "操作类型：create（创建）、update（更新）、delete（删除）",
      },
      id: {
        type: "number",
        description: "学生 ID（update 和 delete 时必填）",
      },
      name: {
        type: "string",
        description: "学生姓名（create 时必填，update 时可选）",
      },
      gender: {
        type: "string",
        description: "学生性别（男/女）",
      },
      student_no: {
        type: "string",
        description: "学号（如 20240001，create 时若省略将自动生成，update 时可选）",
      },
      grade_class: {
        type: "string",
        description: "年级班级（如「三年级二班」）",
      },
      birth_date: {
        type: "string",
        description: "出生日期（YYYY-MM-DD）",
      },
      enroll_date: {
        type: "string",
        description: "入学日期（YYYY-MM-DD）",
      },
      guardian_name: {
        type: "string",
        description: "监护人姓名",
      },
      guardian_phone: {
        type: "string",
        description: "监护人联系电话",
      },
      address: {
        type: "string",
        description: "家庭住址",
      },
      status: {
        type: "string",
        enum: ["active", "graduated", "transferred"],
        description: "在读状态：active（在读）、graduated（毕业）、transferred（转出）",
      },
      note: {
        type: "string",
        description: "备注说明",
      },
      confirm: {
        type: "boolean",
        description: "写操作确认标记：涉及数据修改，必须在用户明确同意后传 true",
      },
    },
    required: ["action"],
  },
  async execute(args) {
    if (args.confirm !== true) {
      return {
        ok: false,
        summary: "",
        error: `"学生管理" 是写操作，请先向用户说明影响并征得同意，然后带 confirm:true 重新调用。`,
      };
    }

    const action = String(args.action ?? "").trim();

    if (action === "create") {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return { ok: false, summary: "", error: "创建学生失败：缺少姓名（name）。" };
      }

      const studentNo =
        typeof args.student_no === "string" && args.student_no.trim()
          ? args.student_no.trim()
          : `S${Date.now().toString().slice(-6)}`;

      const gName = typeof args.guardian_name === "string" ? args.guardian_name.trim() : "";
      const gPhone = typeof args.guardian_phone === "string" ? args.guardian_phone.trim() : "";
      const guardians: Guardian[] = (gName || gPhone)
        ? [{ name: gName || "监护人", phone: gPhone, relation: "监护人", is_primary: true }]
        : [];

      const input: StudentInput = {
        name,
        gender: args.gender === "女" ? "女" : "男",
        birth_date:
          typeof args.birth_date === "string" && args.birth_date.trim() ? args.birth_date.trim() : null,
        student_no: studentNo,
        grade_class: typeof args.grade_class === "string" ? args.grade_class.trim() : "",
        enroll_date:
          typeof args.enroll_date === "string" && args.enroll_date.trim() ? args.enroll_date.trim() : null,
        address:
          typeof args.address === "string" && args.address.trim() ? args.address.trim() : null,
        status:
          typeof args.status === "string" && args.status.trim() ? args.status.trim() : "active",
        note: typeof args.note === "string" && args.note.trim() ? args.note.trim() : null,
        guardians,
      };

      const id = await createStudent(input);
      return {
        ok: true,
        summary: `已成功创建学生「${name}」（ID: ${id}，学号: ${studentNo}）。`,
        data: { id, student: { ...input, id } },
      };
    }

    if (action === "update") {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, summary: "", error: "更新学生失败：缺少有效学生 ID（id）。" };
      }

      const existing = await getStudent(id);
      if (!existing) {
        return { ok: false, summary: "", error: `更新学生失败：未找到 ID 为 ${id} 的学生。` };
      }

      let updatedGuardians = existing.guardians ?? [];
      if (args.guardian_name !== undefined || args.guardian_phone !== undefined) {
        const name = args.guardian_name !== undefined ? String(args.guardian_name).trim() : (updatedGuardians[0]?.name ?? "");
        const phone = args.guardian_phone !== undefined ? String(args.guardian_phone).trim() : (updatedGuardians[0]?.phone ?? "");
        if (name || phone) {
          updatedGuardians = [{ name: name || "监护人", phone, relation: updatedGuardians[0]?.relation || "监护人", is_primary: true }];
        }
      }

      const input: StudentInput = {
        name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : existing.name,
        gender: args.gender === "女" ? "女" : args.gender === "男" ? "男" : existing.gender,
        birth_date:
          args.birth_date !== undefined
            ? args.birth_date
              ? String(args.birth_date).trim()
              : null
            : existing.birth_date,
        student_no:
          typeof args.student_no === "string" && args.student_no.trim()
            ? args.student_no.trim()
            : existing.student_no,
        grade_class:
          typeof args.grade_class === "string" ? args.grade_class.trim() : existing.grade_class,
        enroll_date:
          args.enroll_date !== undefined
            ? args.enroll_date
              ? String(args.enroll_date).trim()
              : null
            : existing.enroll_date,
        address:
          args.address !== undefined
            ? args.address
              ? String(args.address).trim()
              : null
            : existing.address,
        status:
          typeof args.status === "string" && args.status.trim() ? args.status.trim() : existing.status,
        note:
          args.note !== undefined
            ? args.note
              ? String(args.note).trim()
              : null
            : existing.note,
        guardians: updatedGuardians,
      };

      await updateStudent(id, input);
      return {
        ok: true,
        summary: `已成功更新学生「${input.name}」（ID: ${id}）的信息。`,
        data: { id, student: { ...input, id } },
      };
    }

    if (action === "delete") {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, summary: "", error: "删除学生失败：缺少有效学生 ID（id）。" };
      }

      const existing = await getStudent(id);
      if (!existing) {
        return { ok: false, summary: "", error: `删除学生失败：未找到 ID 为 ${id} 的学生。` };
      }

      await deleteStudent(id);
      return {
        ok: true,
        summary: `已成功删除学生「${existing.name}」（ID: ${id}）。`,
        data: { id },
      };
    }

    return {
      ok: false,
      summary: "",
      error: `未知操作类型 "${action}"，可选：create、update、delete。`,
    };
  },
});
