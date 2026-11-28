// Build a one-page, monospace timetable in memory. ToUnicode gives PDF.js
// real Cyrillic text without redistributing a college PDF or a font binary.
export function monospacePdf(lines) {
  const chars = [...new Set(lines.flat().join(''))];
  const hex = n => n.toString(16).padStart(2, '0');
  const encode = line => [...line].map(c => hex(chars.indexOf(c) + 32)).join('');
  const map = chars.map((c, i) => `<${hex(i + 32)}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n');
  const stream = data => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /ToUnicode 6 0 R >>',
    stream(lines.map((line, index) => {
      let x = 20;
      return [line].flat().map(fragment => {
        const op = `BT /F1 10 Tf ${x} ${760 - index * 12} Td <${encode(fragment)}> Tj ET`;
        x += fragment.length * 6;
        return op;
      }).join('\n');
    }).join('\n')),
    stream(`begincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${chars.length} beginbfchar\n${map}\nendbfchar\nendcmap`),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const n of offsets) pdf += `${String(n).padStart(10, '0')} 00000 n \n`;
  return new TextEncoder().encode(pdf + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}
