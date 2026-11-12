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
