import test from "node:test";
import assert from "node:assert/strict";
import { hasSourceChanged, parsePublicFolderHtml } from "../src/source/drive.js";

const html = `
<tr data-id="example_student_pdf_identifier_00001">
  <div data-tooltip="15.09.26 по учащимся.pdf PDF"></div>
</tr>
<tr data-id="example_teacher_pdf_identifier_00001">
  <div data-tooltip="15.09.26 по преподавателям.pdf PDF"></div>
</tr>`;

test("extracts direct public Drive PDF IDs and audience", () => {
  const files = parsePublicFolderHtml(html);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(({ id, scheduleDate, audience }) => ({ id, scheduleDate, audience })), [
    { id: "example_student_pdf_identifier_00001", scheduleDate: "2026-09-15", audience: "students" },
    { id: "example_teacher_pdf_identifier_00001", scheduleDate: "2026-09-15", audience: "teachers" },
  ]);
  assert.match(files[0].downloadUrl, /drive\.usercontent\.google\.com\/download/);
});
test("same metadata is idempotent and changed metadata is detected", () => {
  const previous = { lastModified: "Mon, 14 Sep 2026 10:20:31 GMT", contentLength: 111203 };
  assert.equal(hasSourceChanged(previous, { ...previous }), false);
  assert.equal(hasSourceChanged(previous, { ...previous, contentLength: 111204 }), true);
  assert.equal(hasSourceChanged(previous, { ...previous, lastModified: "Mon, 14 Sep 2026 10:21:00 GMT" }), true);
  assert.equal(hasSourceChanged(null, previous), true);
});
