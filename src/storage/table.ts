/**
 * A table with a primary key and any number of secondary indexes, written by
 * hand rather than reached for out of a library.
 *
 * The reason is not purity. A referral program has to run in whatever container
 * the settlement job is scheduled in, and every embedded database worth using
 * wants a compiler at install time. This is a few hundred lines and it removes
 * that from the deployment, from the tests and from anybody trying to reproduce
 * a settlement three years from now.
 */

import { fail, ok, type Result } from '../util/result.js';
import { sorted, type Comparator } from '../util/ordering.js';

export interface IndexDefinition<T> {
  readonly name: string;
  /** Every key a row belongs under. A row with no keys is simply not indexed. */
  readonly keys: (row: T) => readonly string[];
  readonly unique: boolean;
}

export class Table<T> {
  private readonly rows = new Map<string, T>();
  private readonly indexes = new Map<string, Map<string, Set<string>>>();

  constructor(
    private readonly primaryKey: (row: T) => string,
    private readonly definitions: readonly IndexDefinition<T>[] = [],
  ) {
    for (const definition of definitions) {
      this.indexes.set(definition.name, new Map());
    }
  }

  get size(): number {
    return this.rows.size;
  }

  has(key: string): boolean {
    return this.rows.has(key);
  }

  get(key: string): T | undefined {
    return this.rows.get(key);
  }

  all(): T[] {
    return [...this.rows.values()];
  }

  keys(): string[] {
    return [...this.rows.keys()];
  }

  put(row: T): Result<T> {
    const key = this.primaryKey(row);
    if (key.trim() === '') {
      return fail('table_key_blank', 'a row needs a primary key');
    }
    const existing = this.rows.get(key);
    for (const definition of this.definitions) {
      if (!definition.unique) {
        continue;
      }
      const index = this.indexes.get(definition.name) as Map<string, Set<string>>;
      for (const indexKey of definition.keys(row)) {
        const holders = index.get(indexKey);
        if (holders === undefined) {
          continue;
        }
        for (const holder of holders) {
          if (holder !== key) {
            return fail(
              'table_unique_violated',
              `${definition.name} already holds "${indexKey}" under ${holder}`,
            );
          }
        }
      }
    }
    if (existing !== undefined) {
      this.unindex(key, existing);
    }
    this.rows.set(key, row);
    this.index(key, row);
    return ok(row);
  }

  putAll(rows: readonly T[]): Result<T[]> {
    const written: T[] = [];
    for (const row of rows) {
      const result = this.put(row);
      if (!result.ok) {
        return result;
      }
      written.push(result.value);
    }
    return ok(written);
  }

  remove(key: string): boolean {
    const existing = this.rows.get(key);
    if (existing === undefined) {
      return false;
    }
    this.unindex(key, existing);
    this.rows.delete(key);
    return true;
  }

  by(indexName: string, indexKey: string): Result<T[]> {
    const index = this.indexes.get(indexName);
    if (index === undefined) {
      return fail('table_index_unknown', `there is no index called ${indexName}`);
    }
    const holders = index.get(indexKey);
    if (holders === undefined) {
      return ok([]);
    }
    const rows: T[] = [];
    for (const holder of holders) {
      const row = this.rows.get(holder);
      if (row !== undefined) {
        rows.push(row);
      }
    }
    return ok(rows);
  }

  oneBy(indexName: string, indexKey: string): Result<T | undefined> {
    const rows = this.by(indexName, indexKey);
    if (!rows.ok) {
      return rows;
    }
    if (rows.value.length > 1) {
      return fail('table_index_not_unique', `${indexName} holds several rows for "${indexKey}"`);
    }
    return ok(rows.value[0]);
  }

  indexKeys(indexName: string): Result<string[]> {
    const index = this.indexes.get(indexName);
    return index === undefined
      ? fail('table_index_unknown', `there is no index called ${indexName}`)
      : ok([...index.keys()]);
  }

  where(keep: (row: T) => boolean): T[] {
    return this.all().filter(keep);
  }

  ordered(compare: Comparator<T>): T[] {
    return sorted(this.all(), compare);
  }

  clear(): void {
    this.rows.clear();
    for (const index of this.indexes.values()) {
      index.clear();
    }
  }

  private index(key: string, row: T): void {
    for (const definition of this.definitions) {
      const index = this.indexes.get(definition.name) as Map<string, Set<string>>;
      for (const indexKey of definition.keys(row)) {
        const holders = index.get(indexKey) ?? new Set<string>();
        holders.add(key);
        index.set(indexKey, holders);
      }
    }
  }

  private unindex(key: string, row: T): void {
    for (const definition of this.definitions) {
      const index = this.indexes.get(definition.name) as Map<string, Set<string>>;
      for (const indexKey of definition.keys(row)) {
        const holders = index.get(indexKey);
        if (holders === undefined) {
          continue;
        }
        holders.delete(key);
        if (holders.size === 0) {
          index.delete(indexKey);
        }
      }
    }
  }
}
