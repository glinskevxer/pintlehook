/**
 * The command line. Commander is wired here and only here, so every command
 * body stays a plain function that a test can call.
 *
 * The exit code is returned rather than thrown, and the process only exits in
 * main. A library that calls process.exit is a library nobody can embed.
 */

import { Command } from 'commander';
import { systemClock } from '../service/context.js';
import type { Catalog } from '../service/catalog.js';
import { catalogOrEmpty } from './catalogFile.js';
import {
  auditCommand,
  exceptionsCommand,
  programsCommand,
  rulesCommand,
  saveCommand,
  statusCommand,
  verifyCommand,
} from './commands.js';
import { EXIT_FAILED, consoleSink, reportProblems, type Sink } from './output.js';
import { listReportsCommand, reportCommand, reportPackCommand } from './reportCommands.js';
import { batchesCommand, cutCommand, payCommand, releaseCommand } from './settlementCommands.js';
import { openSession, saveSession, type Session } from './session.js';

export interface GlobalOptions {
  readonly store: string;
  readonly catalog?: string | undefined;
  readonly zone: string;
  readonly actor: string;
}

export interface Loaded {
  readonly session: Session;
  readonly catalog: Catalog;
}

export function load(options: GlobalOptions, sink: Sink): Loaded | number {
  const session = openSession({
    directory: options.store,
    zone: options.zone,
    actor: options.actor,
    clock: systemClock(),
  });
  if (!session.ok) {
    return reportProblems(sink, session.problems);
  }
  const catalog = catalogOrEmpty(options.catalog);
  if (!catalog.ok) {
    return reportProblems(sink, catalog.problems);
  }
  return { session: session.value, catalog: catalog.value };
}

function isLoaded(value: Loaded | number): value is Loaded {
  return typeof value !== 'number';
}

export function buildProgram(sink: Sink, onExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('pintlehook')
    .description('carrier referral bounty administration for a freight brokerage')
    .option('--store <directory>', 'where the journal lives', '.pintlehook')
    .option('--catalog <file>', 'the program catalogue json file')
    .option('--zone <zone>', 'the terminal zone feeds are stamped in', 'America/Chicago')
    .option('--actor <name>', 'who is running this', 'cli');

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();

  const withLoaded = (run: (loaded: Loaded) => number): void => {
    const loaded = load(globals(), sink);
    onExit(isLoaded(loaded) ? run(loaded) : loaded);
  };

  program
    .command('status')
    .description('what is loaded and whether it holds together')
    .action(() => {
      withLoaded(({ session }) => statusCommand(session, sink));
    });

  program
    .command('verify')
    .description('walk the journal and run every integrity check')
    .action(() => {
      withLoaded(({ session }) => verifyCommand(session, sink));
    });

  program
    .command('save')
    .description('write the journal and a snapshot back to the store directory')
    .action(() => {
      withLoaded(({ session }) => saveCommand(session, sink));
    });

  program
    .command('programs')
    .description('list the programs in the catalogue')
    .action(() => {
      withLoaded(({ catalog }) => programsCommand(catalog, sink));
    });

  program
    .command('rules')
    .description('the rules in force on a day')
    .requiredOption('--program <id>', 'the program')
    .option('--as-of <day>', 'the day to read them on')
    .action((options: { program: string; asOf?: string }) => {
      withLoaded(({ session, catalog }) => rulesCommand(session, catalog, sink, options));
    });

  program
    .command('exceptions')
    .description('everything the referral desk has to work')
    .requiredOption('--program <id>', 'the program')
    .option('--as-of <day>', 'the day to age them against')
    .action((options: { program: string; asOf?: string }) => {
      withLoaded(({ session, catalog }) => exceptionsCommand(session, catalog, sink, options));
    });

  program
    .command('audit <advocate>')
    .description('walk everything that names an advocate')
    .action((advocate: string) => {
      withLoaded(({ session }) => auditCommand(session, sink, advocate));
    });

  program
    .command('reports')
    .description('list the reports that can be run')
    .action(() => {
      onExit(listReportsCommand(sink));
    });

  program
    .command('report <name>')
    .description('run one report')
    .requiredOption('--program <id>', 'the program')
    .option('--advocate <id>', 'the advocate, for reports that need one')
    .option('--currency <code>', 'the program currency')
    .option('--as-of <day>', 'the day to run it for')
    .option('--shape <shape>', 'text, csv or json', 'text')
    .action((name: string, options: Record<string, string | undefined>) => {
      withLoadedOf(program, sink, onExit, ({ session, catalog }) =>
        reportCommand(session, catalog, sink, name, options),
      );
    });

  program
    .command('report-pack')
    .description('run every report in one go')
    .requiredOption('--program <id>', 'the program')
    .option('--advocate <id>', 'the advocate, for reports that need one')
    .option('--shape <shape>', 'text, csv or json', 'text')
    .action((options: Record<string, string | undefined>) => {
      withLoadedOf(program, sink, onExit, ({ session, catalog }) =>
        reportPackCommand(session, catalog, sink, options),
      );
    });

  program
    .command('cut')
    .description('cut a settlement batch, previewing unless told to commit')
    .requiredOption('--program <id>', 'the program')
    .requiredOption('--from <day>', 'the first day of the period')
    .requiredOption('--until <day>', 'the day after the period')
    .option('--as-of <day>', 'the day the batch is cut on')
    .option('--currency <code>', 'the program currency')
    .option('--commit', 'write the batch rather than previewing it')
    .action((options: Record<string, string | boolean | undefined>) => {
      withLoadedOf(program, sink, onExit, ({ session, catalog }) => {
        const code = cutCommand(session, catalog, sink, options as never);
        if (options['commit'] === true) {
          const saved = saveSession(session);
          if (!saved.ok) {
            return reportProblems(sink, saved.problems);
          }
        }
        return code;
      });
    });

  program
    .command('batches')
    .description('list settlement batches')
    .option('--state <state>', 'filter to one state')
    .action((options: { state?: string }) => {
      withLoadedOf(program, sink, onExit, ({ session }) =>
        batchesCommand(session, sink, options.state),
      );
    });

  program
    .command('release <batch>')
    .description('release a cut batch')
    .option('--on <day>', 'the day it was released')
    .action((batch: string, options: { on?: string }) => {
      withLoadedOf(program, sink, onExit, ({ session }) => {
        const code = releaseCommand(session, sink, batch, options.on);
        saveSession(session);
        return code;
      });
    });

  program
    .command('pay <batch>')
    .description('mark a released batch paid')
    .option('--on <day>', 'the day it was paid')
    .action((batch: string, options: { on?: string }) => {
      withLoadedOf(program, sink, onExit, ({ session }) => {
        const code = payCommand(session, sink, batch, options.on);
        saveSession(session);
        return code;
      });
    });

  return program;
}

function withLoadedOf(
  program: Command,
  sink: Sink,
  onExit: (code: number) => void,
  run: (loaded: Loaded) => number,
): void {
  const loaded = load(program.opts<GlobalOptions>(), sink);
  onExit(isLoaded(loaded) ? run(loaded) : loaded);
}

export function commandNames(sink: Sink): string[] {
  return buildProgram(sink, () => undefined)
    .commands.map((command) => command.name())
    .sort();
}

export async function main(argv: readonly string[]): Promise<number> {
  const sink = consoleSink();
  let code = EXIT_FAILED;
  const program = buildProgram(sink, (given) => {
    code = given;
  });
  program.exitOverride();
  try {
    await program.parseAsync([...argv]);
  } catch {
    return EXIT_FAILED;
  }
  return code;
}
