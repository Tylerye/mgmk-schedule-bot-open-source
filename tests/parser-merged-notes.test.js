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

test('a numbered row with the room merged into the subject has the same fields in both parsers', () => {
  const input = pdf('¦¦3¦ИНФ-Е ТЕХН-ИИ 126¦Пример С С¦');
  const group = parseGroupSchedule(input, options).lessons[1];
  assert.deepEqual([group.subject, group.rooms, group.teachers], ['ИНФ-Е ТЕХН-ИИ 126', [], ['Пример С.С.']]);
  const personal = parseAllGroupSchedules(input, { bells });
  assert.equal(personal.publishable, true);
  const { subject, room, teacher } = personal.schedules[0].lessons[1].variants[0];
  assert.deepEqual([subject, room, teacher], [group.subject, '', group.teachers[0]]);
  for (const endCell of ['126', '126Пример С С']) {
    assert.equal(parseAllGroupSchedules(pdf(`¦¦3¦Физика¦${endCell}¦`), { bells }).publishable, false);
  }
});
