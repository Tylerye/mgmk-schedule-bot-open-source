import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupSchedule } from '../src/schedule/parse.js';
import { parseAllGroupSchedules } from '../src/personal/parse.js';
import bells from '../config/bells.json' with { type: 'json' };

const pdf = line => ({ source: { name: '12.11.2026.pdf' }, text: '12.11.2026', pages: [{ pageNumber: 1, rows: [
  'РАСПИСАНИЕ НА', 'ЧЕТВЕРГ 12.11.2026', '¦гр.¦ур¦Предмет¦Ауд¦Преподаватель¦',
  '¦8Са¦1¦МАТЕМАТИКА¦245¦Иванов А А¦', line, 'Зам. директора по УР________',
].map(line => ({ line })) }] });
const options = { targetGroup: '8Са', bells };

test('both parsers preserve a merged text continuation without shifting room or teacher columns', () => {
  const input = pdf('¦¦¦Примечание: вся группа¦');
  const schedule = parseGroupSchedule(input, options);
  assert.deepEqual(schedule.lessons[0].subjectVariants, ['Примечание: вся группа']);
  assert.deepEqual(schedule.lessons[0].rooms, ['245']);
  assert.deepEqual(schedule.lessons[0].teachers, ['Иванов А.А.']);
  assert.equal(parseAllGroupSchedules(input, { bells }).publishable, true);
});

test('merged-note support still rejects damaged numbered rows, missing borders and shifted columns', () => {
  for (const line of ['¦¦2¦МАТЕМАТИКА¦', '¦¦2¦МАТЕМАТИКА¦245¦', 'broken¦¦¦Примечание¦', '¦¦¦Примечание¦broken']) {
    assert.throws(() => parseGroupSchedule(pdf(line), options), /Malformed table/);
  }
});
