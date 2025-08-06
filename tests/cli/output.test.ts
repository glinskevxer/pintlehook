import { describe, expect, it } from 'vitest';
import { errorFrom } from '../../src/api/errors.js';
import {
  EXIT_FAILED,
  EXIT_NOTHING_FOUND,
  EXIT_OK,
  EXIT_REFUSED,
  RecordingSink,
  describeExit,
  emit,
  emitJson,
  emitLines,
  exitCodeFor,
  reportProblems,
} from '../../src/cli/output.js';
import { fail, ok, problem } from '../../src/util/result.js';

describe('exit codes', () => {
  it('gives each one its own number', () => {
    const codes = [EXIT_OK, EXIT_FAILED, EXIT_REFUSED, EXIT_NOTHING_FOUND];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('maps a refusal to the refused code', () => {
    expect(exitCodeFor(errorFrom([problem('hold_not_liftable', 'x')]))).toBe(EXIT_REFUSED);
    expect(exitCodeFor(errorFrom([problem('batch_bad_transition', 'x')]))).toBe(EXIT_REFUSED);
  });

  it('maps a missing thing to the nothing found code', () => {
    expect(exitCodeFor(errorFrom([problem('carrier_unknown', 'x')]))).toBe(EXIT_NOTHING_FOUND);
  });

  it('maps anything else to failed', () => {
    expect(exitCodeFor(errorFrom([problem('field_missing', 'x')]))).toBe(EXIT_FAILED);
    expect(exitCodeFor(errorFrom([]))).toBe(EXIT_FAILED);
  });

  it('describes each code', () => {
    expect(describeExit(EXIT_OK)).toBe('ok');
    expect(describeExit(EXIT_REFUSED)).toBe('refused');
    expect(describeExit(9)).toBe('exit 9');
  });
});

describe('reportProblems', () => {
  it('writes the first problem as the headline', () => {
    const sink = new RecordingSink();
    reportProblems(sink, [problem('carrier_unknown', 'no carrier cxr_9')]);
    expect(sink.errorOutput).toBe('404 carrier_unknown: no carrier cxr_9');
  });

  it('writes the rest underneath', () => {
    const sink = new RecordingSink();
    reportProblems(sink, [problem('a', 'first'), problem('b', 'second')]);
    expect(sink.errors).toHaveLength(2);
    expect(sink.errors[1]).toContain('also b: second');
  });

  it('writes nothing to the output stream', () => {
    const sink = new RecordingSink();
    reportProblems(sink, [problem('a', 'first')]);
    expect(sink.lines).toEqual([]);
  });
});

describe('emit', () => {
  it('writes the rendered value and exits ok', () => {
    const sink = new RecordingSink();
    expect(emit(sink, ok(41), (value) => `answer ${value}`)).toBe(EXIT_OK);
    expect(sink.output).toBe('answer 41');
  });

  it('writes nothing for an empty rendering', () => {
    const sink = new RecordingSink();
    emit(sink, ok(1), () => '');
    expect(sink.lines).toEqual([]);
  });

  it('reports a failure and gives its exit code', () => {
    const sink = new RecordingSink();
    expect(emit(sink, fail('carrier_unknown', 'no carrier'), String)).toBe(EXIT_NOTHING_FOUND);
    expect(sink.errorOutput).toContain('carrier_unknown');
  });
});

describe('emitJson', () => {
  it('writes indented json', () => {
    const sink = new RecordingSink();
    emitJson(sink, ok({ a: 1 }));
    expect(sink.output).toBe('{\n  "a": 1\n}');
  });

  it('reports a failure the same way', () => {
    const sink = new RecordingSink();
    expect(emitJson(sink, fail('hold_not_liftable', 'no'))).toBe(EXIT_REFUSED);
  });
});

describe('emitLines', () => {
  it('writes one line each and exits ok', () => {
    const sink = new RecordingSink();
    expect(emitLines(sink, ['one', 'two'])).toBe(EXIT_OK);
    expect(sink.lines).toEqual(['one', 'two']);
  });

  it('writes nothing for an empty list', () => {
    const sink = new RecordingSink();
    emitLines(sink, []);
    expect(sink.output).toBe('');
  });
});
