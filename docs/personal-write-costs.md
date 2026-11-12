# Personal delivery write costs

Delivery keeps one Telegram operation per user HTTP lane, atomic D1 budget
reservations, durable send receipts, monotonic job revisions and all storage
guards. No database migration is needed. The daily application ceiling stays
28,000; it is separate from the provider's physical usage metrics.

Clock ticks compare persisted part hashes with the current render and queue
only changed cards. Render deadlines follow visible completion changes and
retain three-minute coalescing. Pin deadlines use the same candidate selection
as pin delivery, independently of lesson rendering. Successful final parts
commit card metadata and job completion together; intermediate parts remain
resumable. Identical metadata and deadlines are not rewritten. Delivery waves
stop checking an empty inbox until the next incoming update or minute tick.

## Reproducible local checks

```sh
node scripts/measure-personal-writes.js /tmp/personal-costs.json
node --test tests/personal-write-efficiency.test.js tests/personal-lanes.test.js
```

The measurement uses synthetic schedules, Telegram stubs and an ephemeral
Miniflare D1 database with every personal migration, index and trigger applied.
`rowsWritten` sums D1 response metadata, including admission and settlement of
the budget. It is not the simplified SQLite test fixture's write estimate.
`sqlWrites` counts modifying SQL statements, `jobUpserts` counts job upserts,
and `invocations` counts the explicitly simulated due/delivery lanes. Setup is
excluded. These lane counts exclude the outer HTTP routing waves.

Fixed-input comparison (12 November 2026, Minsk; 08:59 or the 09:00 boundary):

| Scenario | D1 rows before → after | Jobs before → after | Lanes before → after | Telegram before / after |
| --- | ---: | ---: | ---: | --- |
| Empty probe | 3 → 3 | 0 → 0 | 1 → 1 | none / none |
| Unchanged card | 31 → 11 | 1 → 0 | 2 → 1 | none / none |
| Lesson ends, tomorrow already published | 110 → 34 | 5 → 1 | 7 → 2 | 1 edit / 1 edit |
| New single-part card | 55 → 48 | 1 → 1 | 3 → 2 | 1 send + 1 pin / same |
| New six-part card | 120 → 113 | 1 → 1 | 8 → 7 | 6 sends + 1 pin / same |
| Subject correction | 70 → 46 | 2 → 1 | 4 → 2 | 1 edit + 1 alert / same |
| Metadata-only update | 31 → 12 | 1 → 0 | 2 → 1 | none / none |

The workerd HTTP test additionally measures a two-part reply through real
service-bound lanes: 7 → 5 HTTP invocations, with two Telegram calls in both
versions. To compare the orchestrator against a local earlier commit, set
`PERSONAL_MEASURE_REF` to its hexadecimal commit ID when running that test.

Savings depend on the workload: about 69% for the lesson boundary, 65% for
unchanged cards, 34% for subject corrections, and 6–13% for new cards. The idle
probe deliberately keeps atomic budget accounting. These results do not prove
a 50% daily reduction, real production CPU limits or full-day reliability.
Confirm physical costs in provider metrics over comparable periods after
release. A stopped day's budget is never reset to make a rollout appear healthy.

## Maintenance and navigation follow-up

The main Worker reuses fixed-name lease rows, checks durable teacher deadlines
before acquiring write leases, and coalesces successful health timestamps into
three-minute windows. Each minute still probes commands/source revisions and
polls PDFs. Lesson starts/ends, midnight and pin switching invalidate deadlines;
failure/recovery transitions are persisted immediately. All nine HTTP lanes
retain separate CPU budgets. Freshness failure still uses the five-minute bound.

Personal navigation updates only changed user columns. Completed command-menu
scopes and unchanged standalone screens are reused; automatic timetable cards
and the owner's teacher-preview messages are excluded from screen caching.
Independent user lanes start 100 ms apart to reduce competition for Telegram's
84 ms slot; the first lane starts immediately and the durable gate stays active.

```sh
node scripts/measure-maintenance-writes.js /tmp/maintenance.json
node scripts/measure-navigation-writes.js /tmp/navigation.json
```

Both accept an optional third argument: an earlier local hexadecimal commit ID.
The synthetic nine-minute quiet main-Worker comparison measured **369 → 189
physical D1 writes (48.8% fewer)**, 549 → 468 SQL queries and 495 → 513 rows read.
Both versions executed 81 HTTP maintenance lanes, 27 stubbed Drive requests and
zero Telegram calls. This measures quiet background work, not overall daily use.

The navigation probe exposed an existing callback job ordering bug: a newly
created acknowledgement was immediately superseded. It now follows the visible
reply, so the screen remains first and the acknowledgement actually executes.
With this correction, six repeated settings clicks measured **348 → 354 writes**
(1.7% more), replacing six redundant edits with six real acknowledgements.
The warm-up screen is excluded. Do not present the missing old acknowledgements
as an optimization or claim that every path became cheaper. Individual profile
updates measured 3 → 1 writes (or zero for unchanged fields).
