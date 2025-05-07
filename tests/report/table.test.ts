import { describe, expect, it } from 'vitest';
import {
  SHAPES,
  cellsOf,
  headingsOf,
  isShape,
  moneyColumn,
  numberColumn,
  parseShape,
  render,
  renderCsv,
  renderJson,
  renderText,
  textColumn,
  validateReport,
  type Report,
} from '../../src/report/table.js';
import { parseCsvTable } from '../../src/util/csv.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

interface Row {
  readonly advocate: string;
  readonly referrals: number;
  readonly paid: ReturnType<typeof money>;
}

const rows: Row[] = [
  { advocate: 'adv_00000001', referrals: 3, paid: money('USD', 123_400) },
  { advocate: 'adv_00000002', referrals: 11, paid: money('USD', 5) },
];

const report: Report<Row> = {
  title: 'advocate standing',
  columns: [
    textColumn<Row>('advocate', 'advocate', (row) => row.advocate),
    numberColumn<Row>('referrals', 'referrals', (row) => row.referrals),
    moneyColumn<Row>('paid', 'paid', (row) => row.paid),
  ],
  rows,
  footnotes: ['amounts are in minor units of the program currency'],
};

describe('columns', () => {
  it('left aligns text and right aligns numbers and money', () => {
    expect(report.columns[0]!.align).toBe('left');
    expect(report.columns[1]!.align).toBe('right');
    expect(report.columns[2]!.align).toBe('right');
  });

  it('renders money from minor units at the boundary', () => {
    expect(report.columns[2]!.render(rows[0]!)).toBe('1234.00 USD');
    expect(report.columns[2]!.render(rows[1]!)).toBe('0.05 USD');
  });
});

describe('cellsOf and headingsOf', () => {
  it('gives one cell per column per row', () => {
    expect(cellsOf(report)).toHaveLength(2);
    expect(cellsOf(report)[0]).toHaveLength(3);
  });

  it('gives the headings in column order', () => {
    expect(headingsOf(report)).toEqual(['advocate', 'referrals', 'paid']);
  });
});

describe('renderText', () => {
  const text = renderText(report);

  it('starts with the title', () => {
    expect(text.split('\n')[0]).toBe('advocate standing');
  });

  it('rules the heading', () => {
    expect(text.split('\n')[3]).toMatch(/^-+ +-+ +-+$/);
  });

  it('pads every column to the same width', () => {
    const lines = text.split('\n');
    const body = lines.slice(4, 6);
    expect(body[0]!.length).toBe(body[1]!.length);
  });

  it('right aligns the money column', () => {
    const lines = renderText(report).split('\n');
    expect(lines[5]!.endsWith('0.05 USD')).toBe(true);
  });

  it('prints the footnotes', () => {
    expect(text).toContain('amounts are in minor units');
  });

  it('says so when there is nothing to report', () => {
    expect(renderText({ ...report, rows: [] })).toContain('(nothing to report)');
  });
});

describe('renderCsv', () => {
  it('round trips through the csv reader', () => {
    const table = unwrap(parseCsvTable(renderCsv(report)));
    expect(table.header).toEqual(['advocate', 'referrals', 'paid']);
    expect(table.rows[0]!['paid']).toBe('1234.00 USD');
  });

  it('writes a header and no rows for an empty report', () => {
    expect(renderCsv({ ...report, rows: [] })).toBe('advocate,referrals,paid');
  });
});

describe('renderJson', () => {
  it('keys the rows by column key', () => {
    const parsed = JSON.parse(renderJson(report)) as {
      title: string;
      rows: Record<string, string>[];
      footnotes: string[];
    };
    expect(parsed.title).toBe('advocate standing');
    expect(parsed.rows[0]!['advocate']).toBe('adv_00000001');
    expect(parsed.footnotes).toHaveLength(1);
  });
});

describe('shapes', () => {
  it('names three', () => {
    expect(SHAPES).toHaveLength(3);
    expect(isShape('csv')).toBe(true);
    expect(isShape('pdf')).toBe(false);
  });

  it('parses case insensitively', () => {
    expect(unwrap(parseShape(' JSON '))).toBe('json');
    expect(isErr(parseShape('pdf'))).toBe(true);
  });

  it('renders each shape differently', () => {
    expect(render(report, 'text')).not.toBe(render(report, 'csv'));
    expect(render(report, 'json')).toContain('"rows"');
  });
});

describe('validateReport', () => {
  it('accepts a good report', () => {
    expect(unwrap(validateReport(report)).title).toBe('advocate standing');
  });

  it('refuses a report with no columns', () => {
    expect(isErr(validateReport({ ...report, columns: [] }))).toBe(true);
  });

  it('refuses a repeated column key', () => {
    const r = validateReport({ ...report, columns: [report.columns[0]!, report.columns[0]!] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('report_column_repeated');
    }
  });
});
