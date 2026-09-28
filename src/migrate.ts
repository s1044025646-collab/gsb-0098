import { migrate, openDatabase } from "./db.ts";

const db = openDatabase();
const records = migrate(db);
if (records.length === 0) {
  console.log("migrations: already up to date");
} else {
  for (const r of records) console.log(`migrated: v${r.version} ${r.name}`);
}
db.close();
