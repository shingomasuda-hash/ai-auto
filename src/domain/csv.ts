/** RFC 4180 に沿った最小のCSVパーサ。区切り内の改行・引用符に対応する。 */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }

  if (inQuotes) throw new SyntaxError('CSVの引用符が閉じられていません。');
  if (field.length > 0 || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** 1行目をヘッダとして辞書配列に変換する。 */
export function parseCsvRecords(input: string): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(input);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (r[idx] ?? '').trim();
    });
    return record;
  });
  return { headers, records };
}
