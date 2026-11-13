import test from 'node:test';
import assert from 'node:assert/strict';
import { personalFixture } from './helpers/personal-fixture.js';
import { PersonalStore } from '../src/personal/store.js';
import { personalQuota } from '../src/personal/quota.js';

const allocation={PERSONAL_DAILY_WRITES:'45000',PERSONAL_BACKGROUND_WRITES:'30000',PERSONAL_SOURCE_WRITES:'35000'};
const now=new Date('2026-11-13T10:00:00Z');
test('background and source cannot consume the manual reserve or poison its admission cache',async t=>{
  const f=await personalFixture();t.after(()=>f.close());
  await f.store.run("INSERT INTO budgets(day,rows_written) VALUES('2026-11-13',31000)");
  const create=()=>new PersonalStore(f.db,allocation);
  assert.equal((await create().budget(now,1,{lane:'background'})).mode,'stopped');
  const source=create();assert.equal((await source.budget(now,1,{lane:'source'})).mode,'saving');await source.flushBudget(now);
  await f.store.run('UPDATE budgets SET rows_written=36000');
  assert.equal((await create().budget(now,1,{lane:'source'})).mode,'stopped');
  const manual=create();assert.equal((await manual.budget(now,1,{userWork:true})).mode,'saving');await manual.flushBudget(now);
  assert.ok((await f.store.first('SELECT rows_written FROM budgets')).rows_written>=36000,'never reset spent writes');
  // Two simultaneous manual reservations cannot both cross their ceiling.
  await f.store.run('UPDATE budgets SET rows_written=44750');
  const results=await Promise.all([create().budget(now,1,{userWork:true}),create().budget(now,1,{userWork:true})]);
  assert.equal(results.filter(r=>r.mode==='stopped').length,1);
  assert.equal((await f.store.first('SELECT rows_written FROM budgets')).rows_written,44850);
  assert.notEqual((await create().budget(now,1,{service:true})).mode,'stopped');
  assert.equal((await create().budget(new Date('2026-11-14T00:00:00Z'))).mode,'normal');
});

test('personal allocations leave half the free account outside this Worker and reject invalid tiers',()=>{
  assert.equal(personalQuota().written,28000);
  assert.deepEqual(personalQuota(allocation),{written:45000,background:30000,source:35000});
  for(const env of [{PERSONAL_DAILY_WRITES:'100000'},{PERSONAL_BACKGROUND_WRITES:'27000'},{PERSONAL_SOURCE_WRITES:'x'}])
    assert.throws(()=>personalQuota(env),/allocation/u);
});
