import { createAppContext } from "../app.ts";
import { seedReferenceData } from "../domain/reference.ts";

const app = createAppContext();
const before = app.db.prepare("SELECT COUNT(*) c FROM catalog_item").get() as { c: number };
seedReferenceData(app.db, app.clock);
const after = app.db.prepare("SELECT COUNT(*) c FROM catalog_item").get() as { c: number };
console.log(`虚构基础资料写入完成（幂等）：资料 ${before.c} -> ${after.c}`);
app.db.close();
