import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { withStateLock } from "../cloudflare/d1-store.js";
import { admitInteractive } from "../cloudflare/ingress-admission.js";

test("runtime lock accounting preserves admission and avoids counting existing locks", { timeout: 20000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "runtime-locks",
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-09-14",
    d1Databases: { DB: "runtime-locks" },
  }));
  try {
    const database = await mf.getD1Database("DB");
    await database.prepare("CREATE TABLE runtime_locks(name TEXT PRIMARY KEY, owner TEXT NOT NULL, locked_until INTEGER NOT NULL)").run();
    await database.prepare("CREATE TABLE security_storage_counts(name TEXT PRIMARY KEY, rows INTEGER NOT NULL CHECK(rows>=0))").run();
    await database.prepare("WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<316) "
      + "INSERT INTO runtime_locks SELECT 'fixture:'||id,'1',1 FROM n").run();
    const admissions = [];
    const DB = { prepare(sql) { return { bind(...args) { return { async run() {
      const result = await database.prepare(sql).bind(...args).run();
      if (sql.startsWith("INSERT INTO runtime_locks") && args[0].startsWith("ingress:")) admissions.push(result.meta);
      return result;
    } }; } }; } };

    assert.equal(await admitInteractive({ DB }, 1, 120000), true);
    assert.equal(await admitInteractive({ DB }, 1, 120001), true);
    const before = admissions.splice(0).slice(-3);
    const migration = await readFile(new URL("../migrations/0012_runtime_lock_accounting.sql", import.meta.url), "utf8");
    for (const sql of migration.replace(/^--.*$/gmu, "").replace(/;\s*END;/gu, "__END__;")
      .split(";").map(s => s.trim().replaceAll("__END__", "; END")).filter(Boolean)) await database.prepare(sql).run();

    assert.equal(await admitInteractive({ DB }, 1, 120002), true);
    const after = admissions.splice(0);
    assert.ok(before.every((meta, index) => meta.rows_read > 300 && after[index].rows_read < 10));
    assert.deepEqual(before.map(x => x.rows_written), after.map(x => x.rows_written));
    console.log(JSON.stringify({ scenario: "three-admission-rules", before: before.map(x => x.rows_read), after: after.map(x => x.rows_read) }));
    assert.equal(await admitInteractive({ DB, INTERACTIVE_BURST_LIMIT: 1 }, 2, 120003), true);
    assert.equal(await admitInteractive({ DB, INTERACTIVE_BURST_LIMIT: 1 }, 2, 120004), false);
    assert.equal((await withStateLock(DB, async () => true, { name: "test-ephemeral" })).acquired, true);
    const counted = await database.prepare("SELECT rows FROM security_storage_counts WHERE name='runtime_locks'").first("rows");
    const actual = await database.prepare("SELECT COUNT(*) AS n FROM runtime_locks").first("n");
    assert.equal(counted, actual);
  } finally {
    await mf.dispose();
  }
});
