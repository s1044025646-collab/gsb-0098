import type { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "./db.ts";
import { SystemClock, type Clock } from "./domain/clock.ts";
import { RequestService } from "./domain/store.ts";
import { SearchService } from "./domain/search.ts";
import { ClarificationService } from "./domain/clarification.ts";
import { ExtensionService } from "./domain/extension.ts";
import { ReviewService } from "./domain/review.ts";
import { AnswerService } from "./domain/answer.ts";
import { ReconsiderationService } from "./domain/reconsideration.ts";

export interface AppContext {
  db: DatabaseSync;
  clock: Clock;
  requests: RequestService;
  search: SearchService;
  clarifications: ClarificationService;
  extensions: ExtensionService;
  reviews: ReviewService;
  answers: AnswerService;
  reconsiderations: ReconsiderationService;
}

export function createAppContext(opts: { dbPath?: string; clock?: Clock; autoMigrate?: boolean } = {}): AppContext {
  const db = openDatabase(opts.dbPath);
  if (opts.autoMigrate ?? true) migrate(db);
  const clock = opts.clock ?? new SystemClock();
  return {
    db,
    clock,
    requests: new RequestService(db, clock),
    search: new SearchService(db, clock),
    clarifications: new ClarificationService(db, clock),
    extensions: new ExtensionService(db, clock),
    reviews: new ReviewService(db, clock),
    answers: new AnswerService(db, clock),
    reconsiderations: new ReconsiderationService(db, clock),
  };
}
