import { describe, expect, it } from 'vitest';
import { Table, type IndexDefinition } from '../../src/storage/table.js';
import { ascending, byKey } from '../../src/util/ordering.js';
import { isErr, unwrap } from '../../src/util/result.js';

interface Carrier {
  readonly id: string;
  readonly mc: string;
  readonly state: string;
  readonly lanes: readonly string[];
  readonly powerUnits: number;
}

const byMc: IndexDefinition<Carrier> = {
  name: 'mc',
  keys: (row) => [row.mc],
  unique: true,
};

const byState: IndexDefinition<Carrier> = {
  name: 'state',
  keys: (row) => [row.state],
  unique: false,
};

const byLane: IndexDefinition<Carrier> = {
  name: 'lane',
  keys: (row) => row.lanes,
  unique: false,
};

function carrier(overrides: Partial<Carrier> = {}): Carrier {
  return {
    id: 'cxr_1',
    mc: 'MC884210',
    state: 'IL',
    lanes: ['IL-TX', 'TX-IL'],
    powerUnits: 2,
    ...overrides,
  };
}

function table() {
  return new Table<Carrier>((row) => row.id, [byMc, byState, byLane]);
}

describe('the primary key', () => {
  it('stores and reads back', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    expect(rows.get('cxr_1')!.mc).toBe('MC884210');
    expect(rows.has('cxr_1')).toBe(true);
    expect(rows.size).toBe(1);
  });

  it('replaces rather than doubling', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    unwrap(rows.put(carrier({ powerUnits: 9 })));
    expect(rows.size).toBe(1);
    expect(rows.get('cxr_1')!.powerUnits).toBe(9);
  });

  it('refuses a blank key', () => {
    const rows = table();
    const r = rows.put(carrier({ id: '  ' }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('table_key_blank');
    }
  });

  it('removes', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    expect(rows.remove('cxr_1')).toBe(true);
    expect(rows.remove('cxr_1')).toBe(false);
    expect(rows.size).toBe(0);
  });
});

describe('a unique index', () => {
  it('finds one row', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    expect(unwrap(rows.oneBy('mc', 'MC884210'))!.id).toBe('cxr_1');
  });

  it('refuses a second row on the same key', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    const r = rows.put(carrier({ id: 'cxr_2' }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('table_unique_violated');
    }
  });

  it('lets a row keep its own unique key on an update', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    expect(isErr(rows.put(carrier({ powerUnits: 4 })))).toBe(false);
  });

  it('frees the key when the row moves off it', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    unwrap(rows.put(carrier({ mc: 'MC999999' })));
    expect(isErr(rows.put(carrier({ id: 'cxr_2' })))).toBe(false);
  });

  it('frees the key when the row is removed', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    rows.remove('cxr_1');
    expect(isErr(rows.put(carrier({ id: 'cxr_2' })))).toBe(false);
  });

  it('gives nothing for a key nobody holds', () => {
    expect(unwrap(table().oneBy('mc', 'MC000001'))).toBeUndefined();
  });
});

describe('a plain index', () => {
  it('finds every row under a key', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    unwrap(rows.put(carrier({ id: 'cxr_2', mc: 'MC2' })));
    unwrap(rows.put(carrier({ id: 'cxr_3', mc: 'MC3', state: 'TX' })));
    expect(unwrap(rows.by('state', 'IL'))).toHaveLength(2);
    expect(unwrap(rows.by('state', 'TX'))).toHaveLength(1);
  });

  it('refuses to answer oneBy when several rows hold the key', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    unwrap(rows.put(carrier({ id: 'cxr_2', mc: 'MC2' })));
    const r = rows.oneBy('state', 'IL');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('table_index_not_unique');
    }
  });

  it('drops a key nobody holds any more', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    rows.remove('cxr_1');
    expect(unwrap(rows.indexKeys('state'))).toEqual([]);
  });

  it('follows a row that moves between keys', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    unwrap(rows.put(carrier({ state: 'TX' })));
    expect(unwrap(rows.by('state', 'IL'))).toHaveLength(0);
    expect(unwrap(rows.by('state', 'TX'))).toHaveLength(1);
  });
});

describe('an index over several keys per row', () => {
  it('finds the row under each of its keys', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    expect(unwrap(rows.by('lane', 'IL-TX'))).toHaveLength(1);
    expect(unwrap(rows.by('lane', 'TX-IL'))).toHaveLength(1);
  });

  it('does not index a row that has no keys', () => {
    const rows = table();
    unwrap(rows.put(carrier({ lanes: [] })));
    expect(unwrap(rows.indexKeys('lane'))).toEqual([]);
    expect(rows.size).toBe(1);
  });
});

describe('an index that does not exist', () => {
  it('says so rather than answering nothing', () => {
    const rows = table();
    expect(isErr(rows.by('nothing', 'x'))).toBe(true);
    expect(isErr(rows.oneBy('nothing', 'x'))).toBe(true);
    expect(isErr(rows.indexKeys('nothing'))).toBe(true);
  });
});

describe('bulk and scanning', () => {
  it('writes many rows', () => {
    const rows = table();
    unwrap(rows.putAll([carrier(), carrier({ id: 'cxr_2', mc: 'MC2' })]));
    expect(rows.size).toBe(2);
  });

  it('stops on the first bad row', () => {
    const rows = table();
    const r = rows.putAll([carrier(), carrier({ id: 'cxr_2' })]);
    expect(isErr(r)).toBe(true);
    expect(rows.size).toBe(1);
  });

  it('filters and orders', () => {
    const rows = table();
    unwrap(rows.put(carrier({ powerUnits: 9 })));
    unwrap(rows.put(carrier({ id: 'cxr_2', mc: 'MC2', powerUnits: 1 })));
    expect(rows.where((row) => row.powerUnits > 5)).toHaveLength(1);
    expect(rows.ordered(byKey((row: Carrier) => row.powerUnits, ascending))[0]!.id).toBe('cxr_2');
  });

  it('clears everything including the indexes', () => {
    const rows = table();
    unwrap(rows.put(carrier()));
    rows.clear();
    expect(rows.size).toBe(0);
    expect(unwrap(rows.indexKeys('mc'))).toEqual([]);
    expect(rows.keys()).toEqual([]);
  });
});
