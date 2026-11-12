# Personal timetable pilot

The personal subsystem runs in the same Telegram bot, in a separate Worker,
D1 database and delivery queue. Access is controlled by `PERSONAL_PUBLIC` in both Worker configs. The templates default to a private pilot; setting it to `true` opens private registration to all valid Telegram user IDs. Existing teachers retain their own routing.

The owner's `/start` opens the student timetable; `/teacher` opens the existing
teacher preview. The preview becomes manual while the personal pilot is enabled
so it cannot replace the student's pin. The three real teachers keep their
existing handlers, data and automatic delivery. The group handler is unchanged.

## Catalog and source validation

`src/personal/parse.js` traverses each extracted PDF once. It preserves linked
subject/room/teacher tuples, repeated lesson numbers, subgroup and unruled notes,
text statuses, and groups continued across page breaks. The original 8-Сба parser
is retained. Actions reuse the same download and extraction for both parsers.

The catalog is the union of independently discovered group labels, including
groups whose schedules failed parsing. A missing group in a newer document
never removes it. Only the explicit display alias `8Са → 8-Сба` is applied;
`8Са` and `8ТС` remain distinct.

The distribution contains no college PDF fixtures or observed production catalog.
The catalog starts empty and is populated by ingestion from your configured source.
The private project keeps its real-document regression suite; it is not distributed.
Review the complete official group roster and every parsed row before your launch.

Errors remain inspectable; malformed document structure or a date mismatch blocks
publication. Uploads stage at most three schedules at a time. Activation is atomic
and requires the full manifest. An incomplete version never starts fanout. Older
source generations cannot replace newer versions. Last successful versions remain
stored when the source fails. Missing data is described as unpublished/unread,
never as a day without classes.

## Private UI and delivery

RU/EN applies to controls, dates and service messages. PDF subjects, names and
group labels are not translated. Users select one group, can search its name,
change language, choose sound/change/pin alerts, and pause automatic delivery.
Support is optional and never gates the timetable.

Cards retain linked subgroup tuples and split into multiple messages without
truncation. History edits the same card and does not move a pin. Bell times are
shared with the existing project; no unconfirmed extra-class room is assigned.
Personal pins switch at **16:30 Europe/Minsk**, independently of lesson end times.
The current pin remains when a future school day is unavailable. Midnight and
weekends do not move pins backward. Only stored own message IDs are unpinned.

Delivery is indexed by group and event deadline. There is no minute scan of all
subscribers. Fanout cursors create bounded batches; the dispatcher selects at most
four users and executes each in a separate invocation. One user operation is
performed per invocation. A shared 84 ms gate and 1050 ms per-user gate limit the
new sender to under 12 operations/s. `429` applies a shared `retry_after` cooldown.
Telegram's limit is shared with the existing bot, so pilot metrics still matter.

Subscription epochs invalidate old jobs after group/language changes. Card work
is serialized per user; sends persist intent before calling Telegram. An ambiguous
send becomes `uncertain` and is not repeated automatically. Edits can be retried.
Blocking the bot stops automatic delivery until another permitted user update.
After a restart the current card state is rendered and obsolete alerts are dropped.

The daily budget uses D1 `meta.rows_read`/`rows_written`, including index costs,
plus a conservative accounting allowance. Saving mode defers background edits;
stopped mode also suspends manual operations; public traffic cannot consume the service reserve. Targets are 30k personal Worker
invocations, 1M D1 reads and 30k D1 writes/day. They do not increase account quotas.
Cloudflare's account metrics, not local test timing, establish actual capacity.
The owner-only `/status` displays aggregate errors, lag, uncertain sends, `429`
and budget mode without user lists or private conversation text.

## Deploying a free pilot

1. Preserve the existing Git and deployed Worker versions and local configuration.
2. Create a new D1 database; apply **only** `personal/migrations/0001_personal.sql`
   to that new database. Never apply it to the legacy bot database.
3. Copy `wrangler.personal.example.jsonc` to an ignored local config. Set the new
   database ID and service names. `SELF` binds the new Worker; `LEGACY` binds the
   existing Worker. Keep `workers_dev` and preview URLs disabled.
4. Provision `BOT_TOKEN` and a new `PERSONAL_SHARED_SECRET` in the personal Worker.
   Set the same personal shared secret on the existing Worker. Keep it distinct
   from the existing parser and webhook secrets.
5. Add a `PERSONAL` service binding and `PERSONAL_ENABLED=true` on the existing
   Worker. Keep `PERSONAL_PILOT_IDS` empty to admit only the owner. Deploy only
   after tests, privacy checks and both dry-run bundles succeed.
6. Seed current public schedules with `scripts/sync-personal-source.js` using the
   existing Actions parser credentials. Normal parser jobs then update the new
   subsystem without affecting the original result's status.
7. Check health and legacy minute lanes, compare old message IDs/pins/counts, and
   test the owner's `/start` and `/teacher` paths. Do not send tests to the group.

The recovery workflow is dispatched on demand, at most three automated attempts
per UTC day with a 20-minute cooldown. It has no periodic Actions schedule; this
avoids consuming private-repository CI minutes while the source is unchanged.

Observe several school days, including PDF corrections, live edits and 16:30 pin
changes. Keep the allowlist small until actual CPU, queue lag and account quotas
are measured. Simulations at 100/300/1500 users use a fake Telegram API and do not
prove Cloudflare Free capacity. No VPS purchase or home-server setup is needed.

## Rollback and future VPS

First deploy the personal Worker with `PERSONAL_DELIVERY_ENABLED=false`, retaining
its D1, queue and receipts. Then roll the legacy Worker back to the saved version.
This stops the new sender before the legacy owner preview resumes. Do not restore
old SQL, re-register a webhook, repeat setup, reset Git history or delete anything.
Keep current personal data when returning forward to prevent repeated deliveries.

The personal domain modules use an async SQL adapter, independent of D1 bindings.
The test adapter uses SQLite. A future VPS needs its own persistent SQLite runtime,
bounded PDF process and backup/transfer procedure. That production runtime and a
pull bridge are a later phase, after the free pilot; the original group and real
teachers stay in Cloudflare. Exactly one sender may own the migrated queue.

Pausing the personal sender retains incoming updates durably without processing
them. A bounded warm-isolate cache shares timetable renders across users with the
same group, language, mode and completed events; cold isolates remain correct.
