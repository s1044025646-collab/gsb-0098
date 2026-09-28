import { createAppContext, type AppContext } from "./app.ts";
import { seedReferenceData } from "./domain/reference.ts";
import { listen } from "./api/http.ts";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app: AppContext = createAppContext();
if (process.env.FOI_SEED !== "0") seedReferenceData(app.db, app.clock);

const port = Number(process.env.PORT ?? 0); // 默认 0 = 本机自动端口
listen(app, port).then(({ server, port: assignedPort }) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pidFile = join(here, "..", "data", "server.pid");
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: assignedPort, url: `http://127.0.0.1:${assignedPort}` }));
  console.log(`FOI backend listening on http://127.0.0.1:${assignedPort} (pid ${process.pid})`);
});

function shutdown() {
  app.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
