import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvTable, writeCsv, writeCsvTable } from '../../src/util/csv.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('parseCsv', () => {
  it('reads plain rows', () => {
    expect(unwrap(parseCsv('a,b\n1,2'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads a quoted field with an embedded delimiter', () => {
    expect(unwrap(parseCsv('a,"b,c"'))).toEqual([['a', 'b,c']]);
  });

  it('reads a doubled quote as one quote', () => {
    expect(unwrap(parseCsv('a,"say ""yes"""'))).toEqual([['a', 'say "yes"']]);
  });

  it('reads a newline inside a quoted field', () => {
    expect(unwrap(parseCsv('a,"line one\nline two"'))).toEqual([['a', 'line one\nline two']]);
  });

  it('accepts carriage return line feed endings', () => {
    expect(unwrap(parseCsv('a,b\r\n1,2\r\n'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('accepts a bare carriage return ending', () => {
    expect(unwrap(parseCsv('a,b\r1,2'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops the trailing blank line a spreadsheet adds', () => {
    expect(unwrap(parseCsv('a,b\n1,2\n\n'))).toHaveLength(2);
  });

  it('keeps an empty field in the middle of a row', () => {
    expect(unwrap(parseCsv('a,,c'))).toEqual([['a', '', 'c']]);
  });

  it('keeps a trailing empty field', () => {
    expect(unwrap(parseCsv('a,b,'))).toEqual([['a', 'b', '']]);
  });

  it('strips a byte order mark', () => {
    expect(unwrap(parseCsv('﻿a,b'))).toEqual([['a', 'b']]);
  });

  it('reads a quoted empty field', () => {
    expect(unwrap(parseCsv('"",b'))).toEqual([['', 'b']]);
  });

  it('rejects a file that ends inside a quoted field', () => {
    const r = parseCsv('a,"b');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('csv_unterminated_quote');
    }
  });

  it('accepts a pipe dialect', () => {
    expect(unwrap(parseCsv('a|b', { delimiter: '|' }))).toEqual([['a', 'b']]);
  });

  it('rejects a multi character delimiter', () => {
    expect(isErr(parseCsv('a', { delimiter: '::' }))).toBe(true);
  });

  it('reads an empty file as no rows', () => {
    expect(unwrap(parseCsv(''))).toEqual([]);
  });
});

describe('parseCsvTable', () => {
  it('keys rows by trimmed column name', () => {
    const table = unwrap(parseCsvTable(' code , carrier \nAB3,MC1\n'));
    expect(table.header).toEqual(['code', 'carrier']);
    expect(table.rows[0]).toEqual({ code: 'AB3', carrier: 'MC1' });
  });

  it('rejects an empty file', () => {
    const r = parseCsvTable('');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('csv_empty');
    }
  });

  it('rejects a duplicated column', () => {
    const r = parseCsvTable('code,code\n1,2');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('csv_duplicate_column');
    }
  });

  it('rejects a short row and names its line number', () => {
    const r = parseCsvTable('a,b,c\n1,2');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('row 2');
    }
  });

  it('accepts a header with no rows', () => {
    expect(unwrap(parseCsvTable('a,b')).rows).toEqual([]);
  });
});

describe('writeCsv', () => {
  it('leaves plain fields alone', () => {
    expect(writeCsv([['a', 'b']])).toBe('a,b');
  });

  it('quotes a field with a delimiter', () => {
    expect(writeCsv([['a', 'b,c']])).toBe('a,"b,c"');
  });

  it('doubles an embedded quote', () => {
    expect(writeCsv([['say "yes"']])).toBe('"say ""yes"""');
  });

  it('quotes a field with a newline', () => {
    expect(writeCsv([['one\ntwo']])).toBe('"one\ntwo"');
  });

  it('round trips through the parser', () => {
    const rows = [
      ['code', 'note'],
      ['AB3', 'said "no, thanks"'],
      ['CD4', 'line one\nline two'],
    ];
    expect(unwrap(parseCsv(writeCsv(rows)))).toEqual(rows);
  });
});

describe('writeCsvTable', () => {
  it('writes columns in header order', () => {
    const text = writeCsvTable(['code', 'carrier'], [{ carrier: 'MC1', code: 'AB3' }]);
    expect(text).toBe('code,carrier\nAB3,MC1');
  });

  it('writes an empty string for a missing column', () => {
    expect(writeCsvTable(['a', 'b'], [{ a: '1' }])).toBe('a,b\n1,');
  });
});
