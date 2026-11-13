import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAllGroupSchedules } from '../src/personal/parse.js';
const bells=JSON.parse(await readFile(new URL('../config/bells.json',import.meta.url)));
const pdf=lines=>({source:{name:'16.11.26.pdf'},text:'16.11.26',pageCount:1,pages:[{pageNumber:1,rows:[
  'РАСПИСАНИЕ НА','ПОНЕДЕЛЬНИК 16.11.26','с учётом изменений 16.11.26г.',
  '¦гр.¦ур¦Предмет¦Ауд¦Преподаватель¦',...lines,'Зам. директора по УР________'
].map(line=>({line}))}]});
test('explicit subgroup labels continue the current group and preserve the label on each lesson',()=>{
  const r=parseAllGroupSchedules(pdf(['¦13ТМ¦1¦СТАНКИ¦132¦Иванов А А¦','¦¦2¦СТАНКИ¦132¦Иванов А А¦',
    '¦ п/г¦3¦ПРОГРАММИРОВАНИЕ¦204¦Петров Б Б¦','¦ п/г¦4¦ПРОГРАММИРОВАНИЕ¦204¦Петров Б Б¦',
    '¦12Д¦1¦ДВС¦223¦Сидоров В В¦']),{bells});
  assert.equal(r.publishable,true);assert.deepEqual(r.coverage,{discovered:2,parsed:2,dataRows:5,accountedRows:5});
  const group=r.schedules.find(s=>s.canonicalGroup==='13ТМ');
  assert.deepEqual(group.lessons.map(l=>l.number),[1,2,3,4]);
  for(const l of group.lessons.slice(2)){assert.equal(l.notes[0].text,'п/г');assert.equal(l.variants[0].room,'204');assert.equal(l.variants[0].teacher,'Петров Б.Б.');}
  assert.equal(r.schedules.find(s=>s.canonicalGroup==='12Д').lessons.length,1);
});
test('a subgroup without a current group and unknown group labels still block publication',()=>{
  for(const lines of [['¦ п/г¦3¦ПРОГРАММИРОВАНИЕ¦204¦Петров Б Б¦'],['¦13ТМ¦1¦СТАНКИ¦132¦Иванов А А¦','¦ошибка¦2¦СТАНКИ¦132¦Иванов А А¦']]){
    const r=parseAllGroupSchedules(pdf(lines),{bells});assert.equal(r.publishable,false);assert.ok(r.structuralErrors.length);
  }
});
