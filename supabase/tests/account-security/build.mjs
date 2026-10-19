import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

// Usage: node build.mjs <migrations dir> <data dir> [extra.sql ...]
const [dir, dataDir, ...extra] = process.argv.slice(2);
fs.rmSync(dataDir, { recursive: true, force: true });
const db = new PGlite(dataDir);
await db.exec(fs.readFileSync(new URL("./stub.sql", import.meta.url), "utf8"));
const files = [
  ...fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(dir, f)),
  ...extra,
];
let okN = 0;
const failed = [];
for (const f of files) {
  const sql = fs.readFileSync(f, "utf8").replace(/^﻿/, "");
  try {
    await db.exec("BEGIN");
    await db.exec(sql);
    await db.exec("COMMIT");
    okN++;
  } catch (e) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    failed.push(`${path.basename(f)}: ${e.message.split("\n")[0]}`);
  }
}
console.log(`applied ${okN}/${files.length}`);
failed.forEach((x) => console.log("FAIL", x));
await db.close();
