import { describe, expect, it } from 'vitest';

import { parseClangTidyDiagnostics, parsePcLintDiagnostics } from '@/process/services/sourceControl/staticScanParser';

describe('static scan diagnostic parsers', () => {
  it('parses clang-tidy file, location, severity, message and check', () => {
    expect(
      parseClangTidyDiagnostics(
        'src/main.cpp:12:7: warning: use nullptr [modernize-use-nullptr]\n' +
          'src/main.cpp:20:3: error: expected expression [clang-diagnostic-error]\n'
      )
    ).toEqual([
      {
        tool: 'clang-tidy',
        file: 'src/main.cpp',
        line: 12,
        column: 7,
        severity: 'warning',
        message: 'use nullptr',
        rule: 'modernize-use-nullptr',
      },
      {
        tool: 'clang-tidy',
        file: 'src/main.cpp',
        line: 20,
        column: 3,
        severity: 'error',
        message: 'expected expression',
        rule: 'clang-diagnostic-error',
      },
    ]);
  });

  it('parses common PC-lint output and ignores unrelated lines', () => {
    expect(
      parsePcLintDiagnostics(
        'src/main.c(42): Error (641) Converting pointer to integer\n' +
          'src/main.c:55:9: Warning (534) Ignoring return value\n' +
          'summary: 2 messages\n'
      )
    ).toEqual([
      {
        tool: 'pc-lint',
        file: 'src/main.c',
        line: 42,
        severity: 'error',
        message: 'Converting pointer to integer',
        rule: '641',
      },
      {
        tool: 'pc-lint',
        file: 'src/main.c',
        line: 55,
        column: 9,
        severity: 'warning',
        message: 'Ignoring return value',
        rule: '534',
      },
    ]);
  });
});
