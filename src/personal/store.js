const stoppedDays = new WeakMap();
// D1 and the future SQLite runtime share this small async SQL interface.
// All mutable data below belongs to the separate personal database.
export class PersonalStore {
  constructor(db) { this.db = db; this.read = 0; this.written = 0; }
  measure(result) {
    this.read += result?.meta?.rows_read ?? 0;
    this.written += result?.meta?.rows_written ?? 0;
    return result;
  }
  statement(sql, args = []) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) { return this.measure(await this.statement(sql, args).all()).results; }
  async first(sql, ...args) { return (await this.all(sql, ...args))[0] ?? null; }
  async run(sql, ...args) { return this.measure(await this.statement(sql, args).run()); }
  async batch(statements) {
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
    const results = await this.db.batch(expanded);
    results.forEach(r => this.measure(r));
    return results;
  }
  async setting(key, fallback = null) {
    const row = await this.first("SELECT value FROM settings WHERE key=?", key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    return this.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  }
  async user(id) { const user=await this.first("SELECT * FROM users WHERE user_id=?", id); return user ? {...user, auto_pin: await this.setting(`auto-pin:${id}`,true)} : null; }
  async groups() { return (await this.all("SELECT payload FROM catalog")).map(r => JSON.parse(r.payload)); }
  async schedules(group) {
    return (await this.all("SELECT s.payload FROM snapshots s JOIN active_versions a ON a.dataset_id=s.dataset_id WHERE s.group_id=? ORDER BY a.date", group)).map(r => JSON.parse(r.payload));
  }
  async card(user, date) {
    const row = await this.first("SELECT * FROM cards WHERE user_id=? AND group_id=? AND date=?", user.user_id, user.group_id, date);
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
  async budget(now = new Date(), requests = 1) {
    const day = now.toISOString().slice(0, 10); // Account daily quotas use UTC.
    if (stoppedDays.get(this.db) === day) return {mode:"stopped"};
    this.reserved = { read: 2000, written: 200 };
    const row = await this.first("INSERT INTO budgets(day,requests,rows_read,rows_written) VALUES(?,?,2000,200) ON CONFLICT(day) DO UPDATE SET requests=requests+excluded.requests,rows_read=rows_read+2000,rows_written=rows_written+200 WHERE requests+excluded.requests<27500 AND rows_read+2000<940000 AND rows_written+200<27000 RETURNING *", day, requests);
    if (!row) { stoppedDays.set(this.db,day); this.reserved = null; return {mode:'stopped'}; }
    return { ...row, mode: row.requests >= 28000 || row.rows_read >= 950000 || row.rows_written >= 28000 ? "stopped"
      : row.requests >= 22000 || row.rows_read >= 800000 || row.rows_written >= 22000 ? "saving" : "normal" };
  }
  async flushBudget(now = new Date()) {
    // Measured D1 meta includes index writes. Reserve 2 additional writes/reads
    // for this accounting query and boundary races rather than undercount it.
    if (!this.reserved) return;
    await this.run("UPDATE budgets SET rows_read=rows_read+?,rows_written=rows_written+? WHERE day=?",
      this.read + 2 - this.reserved.read, this.written + 2 - this.reserved.written, now.toISOString().slice(0, 10));
    this.reserved = null;
  }
}
