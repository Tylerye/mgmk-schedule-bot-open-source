import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const fileId = process.argv[2] ?? "example_student_pdf_identifier_00001";
const outputPath = process.argv[3];
const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

const response = await fetch(url, {
  headers: { "user-agent": "MGMC-Schedule-Bot/0.1 discovery" },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

const bytes = new Uint8Array(await response.arrayBuffer());
const byteLength = bytes.byteLength;
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

const pdf = await getDocument({ data: bytes }).promise;
console.log(JSON.stringify({
  fileId,
  bytes: byteLength,
  sha256,
  pages: pdf.numPages,
}, null, 2));

for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const rows = new Map();
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const x = Number(item.transform[4].toFixed(1));
    const y = Number(item.transform[5].toFixed(1));
    const key = y.toFixed(1);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x, text: item.str.replace(/\s+/g, " ").trim() });
  }
  console.log(`\n--- PAGE ${pageNumber} ---`);
  for (const [y, items] of [...rows.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))) {
    items.sort((a, b) => a.x - b.x);
    console.log(`${y.padStart(6)} | ${items.map((item) => `${item.x}:${item.text}`).join(" | ")}`);
  }
}
