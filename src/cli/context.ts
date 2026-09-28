import { createAppContext } from "../app.ts";
import { seedReferenceData } from "../domain/reference.ts";

export function loadCli() {
  const app = createAppContext();
  return app;
}

export function ensureSeeded(app: ReturnType<typeof createAppContext>) {
  const count = (app.db.prepare("SELECT COUNT(*) AS c FROM agency").get() as { c: number }).c;
  if (count === 0) seedReferenceData(app.db, app.clock);
}

export function printJson(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] ?? "true";
  }
  return out;
}

export function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("参数应为 JSON 数组");
  return parsed.map(String);
}
