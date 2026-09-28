import type { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";
import { Errors } from "./errors.ts";
import { toIso, type Clock } from "./clock.ts";
import { withTransaction } from "../db.ts";
import { appendEvent, getRequestOrThrow } from "./store.ts";

export class SearchService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  assign(requestId: string, assignee: string, note = "", occurredAt?: string) {
    if (!assignee.trim()) throw Errors.validation("assignee 不能为空");
    return withTransaction(this.db, () => {
      getRequestOrThrow(this.db, requestId);
      const id = newId("task");
      const now = occurredAt ?? toIso(this.clock.now());
      this.db
        .prepare(
          "INSERT INTO search_task(id,request_id,assignee,note,status,assigned_at) VALUES(?,?,?,?,'assigned',?)"
        )
        .run(id, requestId, assignee, note, now);
      appendEvent(this.db, requestId, "search_assigned", this.clock, { taskId: id, assignee }, assignee, now);
      return this.db.prepare("SELECT * FROM search_task WHERE id = ?").get(id);
    });
  }

  complete(taskId: string, itemIds: string[], occurredAt?: string) {
    return withTransaction(this.db, () => {
      const task = this.db.prepare("SELECT * FROM search_task WHERE id = ?").get(taskId) as
        | { id: string; request_id: string; status: string }
        | undefined;
      if (!task) throw Errors.notFound(`检索任务 ${taskId}`);
      if (task.status === "completed") {
        return { duplicated: true as const, task, hits: this.listHits(taskId) };
      }
      const now = occurredAt ?? toIso(this.clock.now());
      for (const itemId of itemIds) {
        const item = this.db.prepare("SELECT id FROM catalog_item WHERE id = ?").get(itemId);
        if (!item) throw Errors.validation(`资料 ${itemId} 不存在`);
        // 同任务同资料幂等
        const exists = this.db
          .prepare("SELECT 1 FROM search_hit WHERE task_id = ? AND catalog_item_id = ?")
          .get(taskId, itemId);
        if (!exists) {
          this.db
            .prepare("INSERT INTO search_hit(id,task_id,request_id,catalog_item_id,found_at) VALUES(?,?,?,?,?)")
            .run(newId("hit"), taskId, task.request_id, itemId, now);
        }
      }
      this.db.prepare("UPDATE search_task SET status='completed', completed_at=? WHERE id=?").run(now, taskId);
      appendEvent(this.db, task.request_id, "review_started", this.clock, { taskId, itemIds }, "reviewer", now);
      return { duplicated: false as const, task, hits: this.listHits(taskId) };
    });
  }

  listHits(taskId: string) {
    return this.db
      .prepare(
        `SELECT h.*, i.title FROM search_hit h JOIN catalog_item i ON i.id = h.catalog_item_id WHERE h.task_id = ?`
      )
      .all(taskId);
  }

  hitsForRequest(requestId: string) {
    return this.db
      .prepare(
        `SELECT DISTINCT h.catalog_item_id AS item_id, i.title
         FROM search_hit h JOIN catalog_item i ON i.id = h.catalog_item_id
         WHERE h.request_id = ? ORDER BY h.catalog_item_id`
      )
      .all(requestId) as { item_id: string; title: string }[];
  }
}
