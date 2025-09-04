import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REFERENCE_PATH,
  buildReference,
  commandLines,
  currentReference,
  reportLines,
  routeLines,
  run,
} from '../../scripts/build-command-reference.js';
import { allRoutes } from '../../src/api/app.js';
import { commandNames } from '../../src/cli/entry.js';
import { RecordingSink } from '../../src/cli/output.js';
import { reportNames } from '../../src/report/registry.js';

const original = readFileSync(REFERENCE_PATH, 'utf8');

afterEach(() => {
  writeFileSync(REFERENCE_PATH, original, 'utf8');
});

describe('commandLines', () => {
  it('names every command the entry point wires', () => {
    const text = commandLines().join('\n');
    for (const name of commandNames(new RecordingSink())) {
      expect(text).toContain(`### ${name}`);
    }
  });

  it('lists the options of a command that has some', () => {
    expect(commandLines().join('\n')).toContain('--program <id>');
  });
});

describe('routeLines', () => {
  it('names every route the api serves', () => {
    const text = routeLines().join('\n');
    for (const route of allRoutes) {
      expect(text).toContain(route.path);
    }
  });

  it('sorts them so the file does not churn', () => {
    expect(routeLines()).toEqual(routeLines());
  });
});

describe('reportLines', () => {
  it('names every report the registry holds', () => {
    const text = reportLines().join('\n');
    for (const name of reportNames()) {
      expect(text).toContain(name);
    }
  });

  it('says which need an advocate', () => {
    expect(reportLines().join('\n')).toContain('| yes |');
  });
});

describe('buildReference', () => {
  it('says it is generated', () => {
    expect(buildReference()).toContain('generated from the code');
  });

  it('is stable across two runs', () => {
    expect(buildReference()).toBe(buildReference());
  });
});

describe('the check mode', () => {
  it('passes against the committed file', () => {
    expect(run(true)).toBe(0);
  });

  it('fails once the committed file has drifted', () => {
    writeFileSync(REFERENCE_PATH, '# reference\n\nsomebody edited this by hand\n', 'utf8');
    expect(run(true)).toBe(1);
  });

  it('writes the file back when not checking', () => {
    writeFileSync(REFERENCE_PATH, 'stale', 'utf8');
    expect(run(false)).toBe(0);
    expect(currentReference()).toBe(buildReference());
  });
});
