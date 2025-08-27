import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram, commandNames, load } from '../../src/cli/entry.js';
import { EXIT_FAILED, EXIT_OK, RecordingSink } from '../../src/cli/output.js';
import { programId } from '../../src/domain/identity.js';

let directory: string;
let sink: RecordingSink;

const catalog = {
  programs: [
    {
      id: programId(1),
      name: 'owner operator referral',
      openedOn: '2024-01-01',
      versions: [
        {
          version: 1,
          effectiveFrom: '2024-01-01',
          note: 'opening',
          rules: {
            attributionWindowDays: 90,
            cureWindowDays: 21,
            qualifyingLoadCount: 6,
            qualifyingWindowDays: 120,
            retentionDays: 180,
            programYearCapMinor: 0,
            releaseCeilingMinor: 100000,
            currency: 'USD',
          },
          schedule: {
            currency: 'USD',
            tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25000, marginShare: 0 }],
          },
        },
      ],
    },
  ],
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pintlehook-entry-'));
  sink = new RecordingSink();
});

function catalogPath(): string {
  const path = join(directory, 'catalog.json');
  writeFileSync(path, JSON.stringify(catalog), 'utf8');
  return path;
}

async function run(args: string[]): Promise<number> {
  let code = -1;
  const program = buildProgram(sink, (given) => {
    code = given;
  });
  program.exitOverride();
  await program.parseAsync(['node', 'pintlehook', ...args]);
  return code;
}

describe('the command table', () => {
  it('names every command once', () => {
    const names = commandNames(sink);
    expect(new Set(names).size).toBe(names.length);
  });

  it('carries the commands the desk uses', () => {
    const names = commandNames(sink);
    for (const wanted of ['status', 'verify', 'report', 'cut', 'release', 'pay', 'batches']) {
      expect(names).toContain(wanted);
    }
  });

  it('gives every command a description', () => {
    const program = buildProgram(sink, () => undefined);
    for (const command of program.commands) {
      expect(command.description().length).toBeGreaterThan(10);
    }
  });
});

describe('load', () => {
  it('opens a store and an empty catalogue', () => {
    const loaded = load({ store: directory, zone: 'UTC', actor: 'cli' }, sink);
    expect(typeof loaded).not.toBe('number');
  });

  it('reports a zone it has no rule table for', () => {
    const loaded = load({ store: directory, zone: 'Europe/Riga', actor: 'cli' }, sink);
    expect(loaded).toBe(EXIT_FAILED);
    expect(sink.errorOutput).toContain('session_zone_unsupported');
  });

  it('reports a catalogue file that is not there', () => {
    const loaded = load(
      { store: directory, zone: 'UTC', actor: 'cli', catalog: join(directory, 'nope.json') },
      sink,
    );
    expect(typeof loaded).toBe('number');
    expect(sink.errorOutput).toContain('catalog_file_missing');
  });
});

describe('running commands', () => {
  it('runs status against an empty store', async () => {
    expect(await run(['--store', directory, '--zone', 'UTC', 'status'])).toBe(EXIT_OK);
    expect(sink.output).toContain('0 records');
  });

  it('runs verify against an empty store', async () => {
    expect(await run(['--store', directory, '--zone', 'UTC', 'verify'])).toBe(EXIT_OK);
    expect(sink.output).toContain('records verify');
  });

  it('lists reports without needing a store', async () => {
    expect(await run(['--store', directory, 'reports'])).toBe(EXIT_OK);
    expect(sink.output).toContain('statement');
  });

  it('lists the programs out of a catalogue file', async () => {
    const code = await run([
      '--store',
      directory,
      '--zone',
      'UTC',
      '--catalog',
      catalogPath(),
      'programs',
    ]);
    expect(code).toBe(EXIT_OK);
    expect(sink.output).toContain('owner operator referral');
  });

  it('prints the rules for a program', async () => {
    const code = await run([
      '--store',
      directory,
      '--zone',
      'UTC',
      '--catalog',
      catalogPath(),
      'rules',
      '--program',
      programId(1),
      '--as-of',
      '2025-01-01',
    ]);
    expect(code).toBe(EXIT_OK);
    expect(sink.output).toContain('attribution window 90 days');
  });

  it('saves and reports how many records it wrote', async () => {
    expect(await run(['--store', directory, '--zone', 'UTC', 'save'])).toBe(EXIT_OK);
    expect(sink.output).toContain('wrote 0 records');
  });

  it('previews a cut without writing a batch', async () => {
    const code = await run([
      '--store',
      directory,
      '--zone',
      'UTC',
      '--catalog',
      catalogPath(),
      'cut',
      '--program',
      programId(1),
      '--from',
      '2025-05-01',
      '--until',
      '2025-06-01',
      '--as-of',
      '2025-06-02',
    ]);
    expect(code).toBe(EXIT_OK);
    expect(sink.output).toContain('this was a preview');
  });

  it('reports a bad advocate identifier through the audit command', async () => {
    const code = await run(['--store', directory, '--zone', 'UTC', 'audit', 'nonsense']);
    expect(code).toBe(EXIT_FAILED);
    expect(sink.errorOutput).toContain('surrogate_shape');
  });

  it('lists batches and says there are none', async () => {
    expect(await run(['--store', directory, '--zone', 'UTC', 'batches'])).toBe(EXIT_OK);
    expect(sink.output).toBe('no batches');
  });
});
