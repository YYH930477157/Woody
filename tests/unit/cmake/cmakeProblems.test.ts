import { describe, expect, it } from 'vitest';
import {
  classifyOutputLines,
  parseCmakeProblems,
  projectRelativePath,
  resolveProblemPath,
  splitOutputLines,
} from '@/renderer/pages/cmake/cmakeProblems';

describe('parseCmakeProblems', () => {
  it('reads gcc and clang diagnostics with and without a column', () => {
    const problems = parseCmakeProblems(
      [
        '[ 50%] Building C object CMakeFiles/sensor.dir/src/sensor.c.obj',
        "D:/work/project/src/sensor.c:3:7: warning: unused variable 'unused' [-Wunused-variable]",
        "src/logger.c:12: error: 'level' undeclared (first use in this function)",
        'src/logger.c:14:2: note: each undeclared identifier is reported only once',
      ].join('\n')
    );
    expect(problems).toEqual([
      {
        severity: 'warning',
        file: 'D:/work/project/src/sensor.c',
        line: 3,
        column: 7,
        message: "unused variable 'unused' [-Wunused-variable]",
        outputLine: 1,
      },
      {
        severity: 'error',
        file: 'src/logger.c',
        line: 12,
        column: undefined,
        message: "'level' undeclared (first use in this function)",
        outputLine: 2,
      },
    ]);
  });

  it('reads MSVC diagnostics', () => {
    const [problem] = parseCmakeProblems(
      "D:\\work\\project\\src\\status.c(21,5): error C2065: 'flag': undeclared identifier"
    );
    expect(problem).toMatchObject({
      severity: 'error',
      file: 'D:\\work\\project\\src\\status.c',
      line: 21,
      column: 5,
      message: "'flag': undeclared identifier",
    });
  });

  it('joins the indented message under a CMake error header', () => {
    const [problem] = parseCmakeProblems(
      [
        'CMake Error at CMakeLists.txt:4 (add_executable):',
        '  Cannot find source file:',
        '',
        '    src/missing.c',
        '',
        '-- Configuring incomplete',
      ].join('\n')
    );
    expect(problem).toEqual({
      severity: 'error',
      file: 'CMakeLists.txt',
      line: 4,
      message: 'Cannot find source file:',
      outputLine: 0,
    });
  });

  it('reads CMake warning categories but leaves the unused-cli notice Woody causes in the log only', () => {
    const problems = parseCmakeProblems(
      [
        'CMake Warning (unused-cli):',
        '  Manually-specified variables were not used by the project:',
        '',
        '    CMAKE_CXX_COMPILER',
        'CMake Warning (dev) at CMakeLists.txt:7 (option):',
        '  Policy CMP0077 is not set.',
      ].join('\n')
    );
    expect(problems).toEqual([
      { severity: 'warning', file: 'CMakeLists.txt', line: 7, message: 'Policy CMP0077 is not set.', outputLine: 4 },
    ]);
  });

  it('keeps linker failures and drops the collect2 summary when a cause was found', () => {
    const problems = parseCmakeProblems(
      [
        'C:/tools/mingw64/bin/../lib/gcc/x86_64-w64-mingw32/bin/ld.exe: skipping incompatible C:/tools/libkernel32.a',
        'C:/tools/mingw64/bin/../lib/gcc/x86_64-w64-mingw32/bin/ld.exe: cannot find -lkernel32: No such file or directory',
        "main.c:(.text+0x1e): undefined reference to `sensor_read'",
        'collect2.exe: error: ld returned 1 exit status',
        // CMake repeats a failed test compile, so the summary can appear more than once.
        'collect2.exe: error: ld returned 1 exit status',
      ].join('\n')
    );
    expect(problems.map((problem) => problem.message)).toEqual([
      'ld: cannot find -lkernel32: No such file or directory',
      "undefined reference to `sensor_read'",
    ]);
    expect(problems[1].file).toBe('main.c');
  });

  it('keeps the collect2 summary when it is the only error and reads tool errors', () => {
    expect(parseCmakeProblems('collect2.exe: error: ld returned 1 exit status')[0].message).toBe(
      'collect2.exe: ld returned 1 exit status'
    );
    expect(parseCmakeProblems('C:\\tools\\bin\\gcc.exe: fatal error: no input files')[0].message).toBe(
      'gcc.exe: no input files'
    );
    expect(parseCmakeProblems("gcc: error: unrecognized command-line option '-m33'")[0]).toMatchObject({
      severity: 'error',
      message: "gcc: unrecognized command-line option '-m33'",
    });
  });

  it('ignores colors, duplicates and ordinary progress lines', () => {
    const line = '\u001b[01m\u001b[Ksrc/a.c:1:1:\u001b[m\u001b[K \u001b[01;31m\u001b[Kerror: \u001b[m\u001b[Kbroken';
    const problems = parseCmakeProblems([line, line, '-- Build files have been written to: D:/build'].join('\r\n'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'src/a.c', line: 1, message: 'broken' });
  });
});

describe('console helpers', () => {
  it('colors problem lines and command echoes', () => {
    const output = '> ["cmake","--build","."]\nok\nsrc/a.c:2:1: warning: careful';
    const lines = splitOutputLines(output);
    expect(classifyOutputLines(lines)).toEqual(['command', 'plain', 'warning']);
  });

  it('shows paths inside the project relative to it', () => {
    expect(projectRelativePath('D:\\work\\project\\build\\debug', 'D:/Work/Project')).toBe('build/debug');
    expect(projectRelativePath('/home/project/build', '/home/project/')).toBe('build');
    expect(projectRelativePath('/home/project-two/build', '/home/project')).toBe('/home/project-two/build');
    expect(projectRelativePath('/home/Project/build', '/home/project')).toBe('/home/Project/build');
    expect(projectRelativePath('D:/work/project', 'D:/work/project')).toBe('D:/work/project');
  });

  it('resolves relative problem paths against the project', () => {
    expect(resolveProblemPath('src/a.c', 'D:/work/project/')).toBe('D:/work/project/src/a.c');
    expect(resolveProblemPath('./src/a.c', 'D:\\work\\project')).toBe('D:\\work\\project\\src/a.c');
    expect(resolveProblemPath('D:/other/b.c', 'D:/work/project')).toBe('D:/other/b.c');
    expect(resolveProblemPath('/usr/src/c.c', '/home/project')).toBe('/usr/src/c.c');
  });
});
