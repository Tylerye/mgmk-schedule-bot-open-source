import test from 'node:test';
import assert from 'node:assert/strict';
import { personalFixture, sampleSchedule, installSchedules } from './helpers/personal-fixture.js';

// One tap used to re-read the schedule, the catalog and the cards from D1 every
// time. These tests pin down that repeated reads are served from the isolate
// cache and that any write through the store drops exactly what it touched.
test('read-mostly personal data is memoised per database and invalidated by writes', async () => {
  const f = await personalFixture();
  try {
    const store = f.store;
    // Catalog
    await store.run("INSERT INTO catalog(id,payload) VALUES(?,?)", '8СА', JSON.stringify({ id: '8СА', label: '8Са', displayName: '8-Сба', sourceLabels: ['8Са'], dates: [] }));
    await store.groups();
    const afterCatalog = store.queries;
    await store.groups();
    assert.equal(store.queries, afterCatalog, 'second catalog read is served from cache');
    await store.run("INSERT INTO catalog(id,payload) VALUES(?,?)", '9А', JSON.stringify({ id: '9А', label: '9А', displayName: '9-А', sourceLabels: ['9А'], dates: [] }));
    const afterCatalogWrite = store.queries;
    await store.groups();
    assert.equal(store.queries, afterCatalogWrite + 1, 'a catalog write invalidates the catalog entry');

    // Schedule snapshots
    const schedule = await sampleSchedule('8Са', '2026-11-12');
    await installSchedules(store, [schedule], { id: 'b'.repeat(64) });
    const schedules = await store.schedules('8СА');
    assert.equal(schedules.length, 1, "snapshot stored under the canonical group id");
    const afterSchedule = store.queries;
    await store.schedules('8СА');
    assert.equal(store.queries, afterSchedule, 'second schedule read is served from cache');
    await installSchedules(store, [{ ...schedule, hash: 'c'.repeat(64) }], { id: 'c'.repeat(64), generation: 2 });
    const afterIngest = store.queries;
    await store.schedules('8СА');
    assert.equal(store.queries, afterIngest + 1, 'a new dataset invalidates the schedule entry');

    // Cards
    await store.run("INSERT INTO cards(user_id,group_id,date,parts) VALUES(?,?,?,?)", 7, '8СА', '2026-11-12', JSON.stringify([{ id: 1, hash: 'h' }]));
    const cards = await store.cards(7, '8СА');
    assert.equal(cards.length, 1);
    const afterCards = store.queries;
    await store.cards(7, '8СА');
    assert.equal(store.queries, afterCards, 'second card read is served from cache');
    await store.run("UPDATE cards SET mode='full' WHERE user_id=7");
    const afterCardWrite = store.queries;
    await store.cards(7, '8СА');
    assert.equal(store.queries, afterCardWrite + 1, 'a card write invalidates the card entry');

    // Settings: only the read-mostly ones are memoised, and a write drops them.
    await store.setSetting('auto-pin:7', true);
    assert.equal(await store.setting('auto-pin:7', true), true);
    const afterSetting = store.queries;
    await store.setting('auto-pin:7', true);
    assert.equal(store.queries, afterSetting, 'read-mostly setting is served from cache');
    await store.setSetting('auto-pin:7', false);
    assert.equal(await store.setting('auto-pin:7', true), false, 'setting write is visible immediately');

    // Budget state and screen hashes are compared for exactness: never cached.
    await store.setSetting('budget-mode', 'normal');
    const afterModeWrite = store.queries;
    await store.setting('budget-mode');
    assert.equal(store.queries, afterModeWrite + 1, 'budget mode always reads D1');
  } finally {
    f.close();
  }
});

test('caches of two databases never mix', async () => {
  const first = await personalFixture();
  const second = await personalFixture();
  try {
    await first.store.run("INSERT INTO catalog(id,payload) VALUES(?,?)", 'AА', JSON.stringify({ id: 'AА', label: 'AА', displayName: 'A', sourceLabels: ['AА'], dates: [] }));
    await second.store.run("INSERT INTO catalog(id,payload) VALUES(?,?)", 'BБ', JSON.stringify({ id: 'BБ', label: 'BБ', displayName: 'B', sourceLabels: ['BБ'], dates: [] }));
    assert.deepEqual((await first.store.groups()).map(g => g.id), ['AА']);
    assert.deepEqual((await second.store.groups()).map(g => g.id), ['BБ']);
  } finally {
    first.close();
    second.close();
  }
});
