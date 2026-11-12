import { cached, invalidate, invalidateForWrite } from "./cache.js";

const stoppedDays = new WeakMap();
// Published schedules change once a day, cards at most a few times a day: a
// short in-isolate memo removes most D1 round trips from the tap path.
const SCHEDULE_TTL = 300_000;
const CATALOG_TTL = 300_000;
const CARDS_TTL = 20_000;
const SETTING_TTL = 60_000;
// Only read-mostly settings are memoised; screen hashes and budget state are
// compared for exactness and stay uncached.
const memoisedSetting = key => /^(auto-pin|commands-v1):/u.test(String(key));
// D1 and the future SQLite runtime share this small async SQL interface.
// All mutable data below belongs to the separate personal database.
export class PersonalStore {
  constructor(db) { this.db = db; this.read = 0; this.written = 0; this.queries = 0; this.queryMs = 0; }
  measure(result) {
    this.read += result?.meta?.rows_read ?? 0;
    this.written += result?.meta?.rows_written ?? 0;
    return result;
  }
  statement(sql, args = []) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) {
    const started = Date.now();
    const result = this.measure(await this.statement(sql, args).all());
    this.queries++; this.queryMs += Date.now() - started;
    return result.results;
  }
  async first(sql, ...args) { return (await this.all(sql, ...args))[0] ?? null; }
  async run(sql, ...args) {
    const started = Date.now();
    const result = this.measure(await this.statement(sql, args).run());
    this.queries++; this.queryMs += Date.now() - started;
    invalidateForWrite(this.db, sql, args);
    return result;
  }
  async batch(statements) {
    if (!statements.length) return [];
    const expanded = [];
    for (let [sql, ...args] of statements) {
      if (sql.startsWith("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload)")) {
        // Allocate under the same D1 transaction as the job, including after retention.
        expanded.push(this.statement("UPDATE job_revision_sequence SET value=value+1 WHERE id=1"));
        sql = sql.replace("priority,due,payload)", "priority,due,payload,revision)")
          .replace("VALUES(?,?,?,?,?,?,?,?)", "VALUES(?,?,?,?,?,?,?,?,(SELECT value FROM job_revision_sequence WHERE id=1))")
          .replace("revision=jobs.revision+1", "revision=excluded.revision");
      }
      expanded.push(this.statement(sql, args));
    }
    const started = Date.now();
    const results = await this.db.batch(expanded);
    this.queries++; this.queryMs += Date.now() - started;
    results.forEach(r => this.measure(r));
    for (const [sql, ...args] of statements) invalidateForWrite(this.db, sql, args);
    return results;
  }
  async setting(key, fallback = null) {
    const load = async () => {
      const row = await this.first("SELECT value FROM settings WHERE key=?", key);
      return row ? JSON.parse(row.value) : fallback;
    };
    return memoisedSetting(key) ? cached(this.db, `setting:${key}`, SETTING_TTL, load) : load();
  }
  setSetting(key, value) {
    invalidate(this.db, `setting:${key}`);
    return this.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value", key, JSON.stringify(value));
  }
  async user(id) { const user=await this.first("SELECT * FROM users WHERE user_id=?", id); return user ? {...user, auto_pin: await this.setting(`auto-pin:${id}`,true)} : null; }
  async groups() {
    return cached(this.db, "catalog", CATALOG_TTL, async () => (await this.all("SELECT payload FROM catalog")).map(r => JSON.parse(r.payload)));
  }
  async schedules(group) {
    return cached(this.db, `sched:${group}`, SCHEDULE_TTL,
      async () => (await this.all("SELECT s.payload FROM snapshots s JOIN active_versions a ON a.dataset_id=s.dataset_id WHERE s.group_id=? ORDER BY a.date", group)).map(r => JSON.parse(r.payload)));
  }
  // Raw card rows for one user and group: the schedule-shaped half of delivery.
  // `userCards` is the per-user view used to tell an automatic card's message
  // from a standalone screen, which must not be scoped to the current group.
  async userCards(userId) {
    return cached(this.db, `usercards:${userId}`, CARDS_TTL,
      () => this.all("SELECT * FROM cards WHERE user_id=?", userId));
  }
  async cards(userId, groupId) {
    return cached(this.db, `cards:${userId}:${groupId}`, CARDS_TTL,
      () => this.all("SELECT * FROM cards WHERE user_id=? AND group_id=? ORDER BY date", userId, groupId));
  }
  async card(user, date) {
    const row = (await this.cards(user.user_id, user.group_id)).find(c => c.date === date);
    return row ? { ...row, parts: JSON.parse(row.parts), schedule: row.schedule_payload ? JSON.parse(row.schedule_payload) : null } : null;
  }
  jobStatement(user, kind, date = "", { priority = 2, due = Date.now(), payload = {} } = {}) {
    const id = `${user.user_id}:${kind}:${date}`;
    return ["INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES(?,?,?,?,?,?,?,?) "
      + "ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,priority=CASE WHEN jobs.status='pending' AND jobs.epoch=excluded.epoch THEN MIN(jobs.priority,excluded.priority) ELSE excluded.priority END,"
      + "due=CASE WHEN jobs.status='pending' AND jobs.epoch=excluded.epoch THEN MIN(jobs.due,excluded.due) ELSE excluded.due END,"
      + "payload=excluded.payload,revision=jobs.revision+1,status='pending'", id, user.user_id, user.epoch, kind, date, priority, due, JSON.stringify(payload)];
  }
  async enqueue(user, kind, date, options) { return this.batch([this.jobStatement(user, kind, date, options)]); }
  async lock(id, now, action) {
    const token = crypto.randomUUID();
    const row = await this.first("INSERT INTO locks(user_id,token,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET "
      + "token=excluded.token,expires_at=excluded.expires_at WHERE locks.expires_at<=? RETURNING token", id, token, now + 90000, now);
    if (row?.token !== token) return false;
    try { await action(); return true; }
    finally { await this.run("UPDATE locks SET expires_at=0 WHERE user_id=? AND token=?", id, token); }
  }
  async budget(now = new Date(), requests = 1, { service = false, router = false, userWork = false } = {}) {
    const day = now.toISOString().slice(0, 10); // Account daily quotas use UTC.
    const cached = stoppedDays.get(this.db);
    if (!service && cached?.day === day && cached.until > now.getTime()) return {mode:"stopped"};
    this.reserved = { read: service ? 500 : 2000, written: service || router ? 20 : userWork ? 100 : 200 };
    // The service allowance is INSIDE the unchanged daily ceiling. Lightweight
    // orchestration does not reserve the full delivery batch's write allowance.
    const limits = service ? [28000, 950000, 28000] : [27900, 948000, 27900];
    const row = await this.first("INSERT INTO budgets(day,requests,rows_read,rows_written) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET requests=requests+excluded.requests,rows_read=rows_read+excluded.rows_read,rows_written=rows_written+excluded.rows_written WHERE requests+excluded.requests<? AND rows_read+excluded.rows_read<? AND rows_written+excluded.rows_written<? RETURNING *", day, requests, this.reserved.read, this.reserved.written, ...limits);
    if (!row) {
      if (!service) stoppedDays.set(this.db, { day, until: now.getTime() + 60000 });
      this.reserved = null;
      return {mode:'stopped'};
    }
    return { ...row, mode: row.requests >= 28000 || row.rows_read >= 950000 || row.rows_written >= 28000 ? "stopped"
      : row.requests >= 22000 || row.rows_read >= 800000 || row.rows_written >= 22000 ? "saving" : "normal" };
  }
  async flushBudget(now = new Date()) {
    // Measured D1 meta includes index writes. Reserve 2 additional writes/reads
    // for this accounting query and boundary races rather than undercount it.
    // Callable again after background work: only the delta is written, so a
    // final call after `waitUntil` work is not lost.
    const reservedRead = this.reserved?.read ?? 0;
    const reservedWritten = this.reserved?.written ?? 0;
    const readDelta = this.read + 2 - reservedRead;
    const writtenDelta = this.written + 2 - reservedWritten;
    this.reserved = null;
    if (readDelta <= 0 && writtenDelta <= 0) return;
    this.read = 0; this.written = 0;
    await this.run("UPDATE budgets SET rows_read=rows_read+?,rows_written=rows_written+? WHERE day=?",
      readDelta, writtenDelta, now.toISOString().slice(0, 10));
  }
}
