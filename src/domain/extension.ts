import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";
import { appendEvent, getRequestOrThrow } from "./store.ts";

export class ExtensionService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  request(requestId: string, reason: string, extraWorkdays: number, occurredAt?: string) {
    if (!reason.trim()) throw Errors.validation("延期理由不能为空");
    if (!Number.isInteger(extraWorkdays) || extraWorkdays <= 0 || extraWorkdays > 20) {
      throw Errors.validation("extraWorkdays 必须为 1..20 的整数");
    }
    return withTransaction(this.db, () => {
      getRequestOrThrow(this.db, requestId);
      const id = newId("ext");
      const now = occurredAt ?? toIso(this.clock.now());
      this.db
        .prepare(
          `INSERT INTO extension(id,request_id,requested_at,reason,extra_workdays,status)
           VALUES(?,?,?,?,?,'pending')`
        )
        .run(id, requestId, now, reason, extraWorkdays);
      appendEvent(this.db, requestId, "extension_requested", this.clock, { id, extraWorkdays, reason }, "officer", now);
      return { id, status: "pending" };
    });
  }

  decide(extensionId: string, approve: boolean, approver: string, note: string, occurredAt?: string) {
    if (!approver.trim()) throw Errors.validation("approver 不能为空");
    if (!note.trim()) throw Errors.validation("审批意见不能为空");
    return withTransaction(this.db, () => {
      const ext = this.db.prepare("SELECT * FROM extension WHERE id = ?").get(extensionId) as
        | {
            id: string;
            request_id: string;
            status: string;
            extra_workdays: number;
            reason: string;
          }
        | undefined;
      if (!ext) throw Errors.notFound(`延期申请 ${extensionId}`);
      if (ext.status !== "pending") return { duplicated: true as const, status: ext.status };
      const now = occurredAt ?? toIso(this.clock.now());
      const status = approve ? "approved" : "rejected";
      this.db
        .prepare("UPDATE extension SET status=?, decided_at=?, approver=?, decision_note=? WHERE id=?")
        .run(status, now, approver, note, ext.id);
      appendEvent(
        this.db,
        ext.request_id,
        approve ? "extension_approved" : "extension_rejected",
        this.clock,
        { id: ext.id, extraWorkdays: ext.extra_workdays, approver, note, reason: ext.reason },
        approver,
        now
      );
      return { duplicated: false as const, status };
    });
  }
}
