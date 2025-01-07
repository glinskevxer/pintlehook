import { describe, expect, it } from 'vitest';
import {
  readDeliveryFile,
  readEnvelopeFields,
  splitDelivery,
  toEnvelopeInput,
  writeDeliveryFile,
} from '../../src/ingest/csvSource.js';
import { readEnvelope } from '../../src/ingest/envelope.js';
import { isErr, unwrap } from '../../src/util/result.js';

const file = [
  'source: fuel-desk',
  'kind: touch',
  'cutAt: 2025-04-01T06:00:00Z',
  'declaredRows: 2',
  'zone: America/Chicago',
  'sequence: 118',
  '---',
  'referral_code,channel,occurred_at',
  'AB3K9ZQ,card,2025-03-15T15:04:00Z',
  'QW7X2MB,link,2025-03-16T09:10:00Z',
].join('\n');

describe('splitDelivery', () => {
  it('cuts at the dashed line', () => {
    const split = unwrap(splitDelivery(file));
    expect(split.header).toContain('source: fuel-desk');
    expect(split.body.startsWith('referral_code')).toBe(true);
  });

  it('accepts carriage return line feed endings', () => {
    const split = unwrap(splitDelivery(file.split('\n').join('\r\n')));
    expect(split.body.startsWith('referral_code')).toBe(true);
  });

  it('accepts a longer run of dashes', () => {
    expect(isErr(splitDelivery(file.replace('---', '----------')))).toBe(false);
  });

  it('refuses a file with no separator', () => {
    const r = splitDelivery('source: fuel-desk\nreferral_code');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('delivery_no_separator');
    }
  });
});

describe('readEnvelopeFields', () => {
  it('reads key colon value lines', () => {
    const fields = unwrap(readEnvelopeFields('source: fuel-desk\nsequence: 118'));
    expect(fields['source']).toBe('fuel-desk');
    expect(fields['sequence']).toBe('118');
  });

  it('keeps a colon inside the value', () => {
    const fields = unwrap(readEnvelopeFields('cutAt: 2025-04-01T06:00:00Z'));
    expect(fields['cutAt']).toBe('2025-04-01T06:00:00Z');
  });

  it('skips blank lines', () => {
    expect(Object.keys(unwrap(readEnvelopeFields('source: a\n\n\nkind: touch')))).toHaveLength(2);
  });

  it('refuses a line it cannot read', () => {
    const r = readEnvelopeFields('source fuel-desk');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('delivery_header_line');
    }
  });

  it('refuses a repeated field', () => {
    const r = readEnvelopeFields('source: a\nsource: b');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('delivery_header_repeated');
    }
  });

  it('refuses an empty block', () => {
    expect(isErr(readEnvelopeFields('\n\n'))).toBe(true);
  });
});

describe('readDeliveryFile', () => {
  it('reads the envelope and the rows', () => {
    const delivery = unwrap(readDeliveryFile(file));
    expect(delivery.envelopeFields['source']).toBe('fuel-desk');
    expect(delivery.rows).toHaveLength(2);
    expect(delivery.rows[0]!['referral_code']).toBe('AB3K9ZQ');
  });

  it('reads a pipe dialect body', () => {
    const piped = file.replace(/,/g, '|');
    const delivery = unwrap(readDeliveryFile(piped, { delimiter: '|' }));
    expect(delivery.rows).toHaveLength(2);
  });

  it('passes a body problem through', () => {
    const short = file.replace('AB3K9ZQ,card,2025-03-15T15:04:00Z', 'AB3K9ZQ,card');
    const r = readDeliveryFile(short);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('csv_row_width');
    }
  });

  it('passes an envelope problem through', () => {
    expect(isErr(readDeliveryFile('nonsense\n---\na,b'))).toBe(true);
  });

  it('reads a delivery with a header and no rows', () => {
    const empty = file.split('\n').slice(0, 8).join('\n');
    expect(unwrap(readDeliveryFile(empty)).rows).toEqual([]);
  });
});

describe('toEnvelopeInput', () => {
  it('turns the counted fields into numbers', () => {
    const delivery = unwrap(readDeliveryFile(file));
    const input = toEnvelopeInput(delivery.envelopeFields);
    expect(input['declaredRows']).toBe(2);
    expect(input['sequence']).toBe(118);
    expect(input['source']).toBe('fuel-desk');
  });

  it('produces something the envelope reader accepts', () => {
    const delivery = unwrap(readDeliveryFile(file));
    const envelope = unwrap(readEnvelope(toEnvelopeInput(delivery.envelopeFields)));
    expect(envelope.sequence).toBe(118);
    expect(envelope.zone).toBe('America/Chicago');
  });
});

describe('writeDeliveryFile', () => {
  it('round trips', () => {
    const delivery = unwrap(readDeliveryFile(file));
    const written = writeDeliveryFile(
      delivery.envelopeFields,
      ['referral_code', 'channel', 'occurred_at'],
      delivery.rows,
    );
    const again = unwrap(readDeliveryFile(written));
    expect(again.rows).toEqual(delivery.rows);
    expect(again.envelopeFields).toEqual(delivery.envelopeFields);
  });

  it('writes an empty string for a column a row does not carry', () => {
    const written = writeDeliveryFile({ source: 'a' }, ['x', 'y'], [{ x: '1' }]);
    expect(written.endsWith('1,')).toBe(true);
  });
});
