import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

function renderMonospaceRow(items) {
  // The college changes font size when fitting more groups onto a page.
  // Measure this row instead of projecting every PDF onto the old 6pt grid.
  const widths = items.map((item) => item.width / item.text.length)
    .filter((width) => Number.isFinite(width) && width > 0).sort((a, b) => a - b);
  if (!widths.length) throw new Error("PDF row has no measurable character width");
  const pitch = widths[Math.floor(widths.length / 2)];
  const leftEdge = Math.min(...items.map((item) => item.x));
  const characters = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const start = Math.max(0, Math.round((item.x - leftEdge) / pitch));
    if (!Number.isSafeInteger(start) || start + item.text.length > 20000) throw new Error("PDF row limit exceeded");
    for (let index = 0; index < item.text.length; index += 1) {
      const position = start + index;
      const previous = characters[position];
      const next = item.text[index];
      if (previous !== undefined && previous !== " " && next !== " " && previous !== next) {
        throw new Error("Overlapping PDF text: refusing to discard table characters");
      }
      if (previous === undefined || previous === " ") characters[position] = next;
    }
  }
  return Array.from({ length: characters.length }, (_, index) => characters[index] ?? " ").join("").trimEnd();
}
function groupRows(items) {
  const rows = [];
  for (const item of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 0.8);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows.sort((a, b) => b.y - a.y).map((row) => ({
    y: row.y,
    line: renderMonospaceRow(row.items),
    items: row.items.sort((a, b) => a.x - b.x),
  }));
}

export async function extractPdf(rawSource) {
  if (rawSource.bytes.byteLength > 20 * 1024 * 1024) throw new Error("PDF byte limit exceeded");
  const stableBytes = rawSource.bytes.slice();
  const document = await getDocument({ data: stableBytes }).promise;
  if (document.numPages > 100) { await document.destroy(); throw new Error("PDF page limit exceeded"); }
  let symbols = 0;
  const pages = [];
  const allText = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    if (textContent.items.length > 20000) { await document.destroy(); throw new Error("PDF item limit exceeded"); }
    const items = textContent.items
      .filter((item) => "str" in item && item.str.trim())
      .map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
      }));
    if (items.some(i => ![i.x,i.y,i.width].every(Number.isFinite))) throw new Error("Invalid PDF coordinates");
    symbols += items.reduce((n,i)=>n+i.text.length,0);
    if (symbols > 2000000) { await document.destroy(); throw new Error("PDF text limit exceeded"); }
    allText.push(...items.map((item) => item.text));
    pages.push({ pageNumber, rows: groupRows(items) });
  }
  await document.destroy();
  return {
    source: rawSource.source,
    pageCount: document.numPages,
    text: allText.join(" "),
    pages,
  };
}
