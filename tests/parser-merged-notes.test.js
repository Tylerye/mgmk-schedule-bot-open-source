import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupSchedule } from '../src/schedule/parse.js';
import { parseAllGroupSchedules } from '../src/personal/parse.js';
import bells from '../config/bells.json' with { type: 'json' };
import { extractPdf } from '../src/pdf/extract.js';
import { formatScheduleMessage } from '../src/schedule/format.js';
import { renderPersonal } from '../src/personal/view.js';
import { monospacePdf } from './helpers/monospace-pdf.js';

const pdf = line => ({ source: { name: '12.11.2026.pdf' }, text: '12.11.2026', pages: [{ pageNumber: 1, rows: [
  'РАСПИСАНИЕ НА', 'ЧЕТВЕРГ 12.11.2026', '¦гр.¦ур¦Предмет¦Ауд¦Преподаватель¦',
  '¦8Са¦1¦МАТЕМАТИКА¦245¦Иванов А А¦', line, 'Зам. директора по УР________',
].map(line => ({ line })) }] });
const options = { targetGroup: '8Са', bells };

test('PDF to cards restores an aligned missing border and rejects two glued lessons', async () => {
  const row = (group, number, subject, room, teacher) =>
    `¦${group.padEnd(4)}¦${number.padEnd(2)}¦${subject.padEnd(12)}¦${room.padEnd(4)}¦${teacher.padEnd(12)}¦`;
  const first = row('8Са', '1', 'Алгебра', '110', 'Иванов А Б');
  const second = row('', '2', 'Физика', '237', 'Пример В Г');
  const continuation = row('', '', '', '', 'продолжение');
  const third = row('', '3', 'Химия', '308', 'Петров Б В');
  const extract = mid => extractPdf({ source: { name: '12.11.2026.pdf' }, bytes: monospacePdf([
    'РАСПИСАНИЕ 12.11.2026', '¦гр.¦ур¦Предмет¦Ауд¦Преподаватель¦', first, mid, continuation, third, 'Зам. директора',
  ]) });
  const good = await extract(second);
  const roomAt = second.indexOf('237');
  const restored = await extract([second.slice(0, roomAt - 1) + ' ', second.slice(roomAt)]);
  const main = parseGroupSchedule(restored, options);
  const personal = parseAllGroupSchedules(restored, options);
  assert.deepEqual(main, parseGroupSchedule(good, options));
  assert.equal(personal.publishable, true);
  assert.equal(personal.schedules[0].hash, parseAllGroupSchedules(good, options).schedules[0].hash);
  const variant = personal.schedules[0].lessons[1].variants[0];
  assert.deepEqual([variant.subject, variant.room, variant.teacher], ['Физика', '237', 'Пример В.Г. продолжение']);
  for (const card of [formatScheduleMessage(main), renderPersonal(personal.schedules[0], { language: 'ru' }, { mode: 'full' }).parts.join('\n')]) {
    for (const field of ['Физика', '237', 'Пример', 'продолжение']) assert.ok(card.includes(field), field);
  }
  const ambiguous = await extract(second.replace('¦237', '237 '));
  const preserved = parseAllGroupSchedules(ambiguous, options).schedules[0].lessons[1].variants[0];
  assert.equal(preserved.room, '');
  assert.match(preserved.subject, /237$/u);
  const glued = await extract(second + third);
  assert.throws(() => parseGroupSchedule(glued, options), /Malformed table/);
  assert.equal(parseAllGroupSchedules(glued, options).publishable, false);
});

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
    assert.equal(parseAllGroupSchedules(pdf(line), options).publishable, false);
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
  for (const endCell of ['126', '126Пример С']) {
    assert.equal(parseAllGroupSchedules(pdf(`¦¦3¦Физика¦${endCell}¦`), { bells }).publishable, false);
  }
});

test('a numeric room merged with the teacher is restored in both parsers', () => {
  const input = pdf('¦¦3¦Физика¦2243Пример А Б¦');
  const group = parseGroupSchedule(input, options).lessons[1];
  assert.deepEqual([group.subject, group.rooms, group.teachers], ['Физика', ['2243'], ['Пример А.Б.']]);
  const personal = parseAllGroupSchedules(input, { bells });
  assert.equal(personal.publishable, true);
  const { subject, room, teacher } = personal.schedules[0].lessons[1].variants[0];
  assert.deepEqual([subject, room, teacher], ['Физика', '2243', 'Пример А.Б.']);
});
