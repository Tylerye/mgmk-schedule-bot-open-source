import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AttentionStore } from "./attention.js";

export function sqliteAdapter(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(statement.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

export async function openLocalAttention(path) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(await readFile(new URL("../migrations/0004_attention.sql", import.meta.url), "utf8"));
  db.exec(await readFile(new URL("../migrations/0005_acknowledgements.sql", import.meta.url), "utf8"));
  db.exec(await readFile(new URL("../migrations/0006_recruitments.sql", import.meta.url), "utf8"));
  db.exec(await readFile(new URL("../migrations/0007_event_reminders.sql", import.meta.url), "utf8"));
  return new AttentionStore(sqliteAdapter(db));
}
