import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CmakeJob } from '@/common/types/cmake';
import CmakeConsole from '@/renderer/pages/cmake/BuildView/CmakeConsole';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const job = (status: CmakeJob['status'], error?: string): CmakeJob => ({
  id: `job-${status}`,
  projectPath: 'D:/work/project',
  action: 'build',
  status,
  startedAt: '2026-11-24T00:00:00Z',
  buildDirectory: 'D:/work/project/build',
  selection: {},
  ...(error ? { error } : {}),
});
const output = [
  '[ 50%] Building C object CMakeFiles/sensor.dir/src/sensor.c.obj',
  "src/sensor.c:3:7: warning: unused variable 'unused'",
  'src/logger.c:12:3: error: expected expression',
].join('\n');

const renderConsole = (props: Partial<React.ComponentProps<typeof CmakeConsole>> = {}) =>
  render(
    <CmakeConsole
      job={job('failed', 'cmake.processExit')}
      output={output}
      truncated={false}
      pending={false}
      projectPath='D:/work/project'
      onCopy={vi.fn(async () => {})}
      errorText={(text) => `translated:${text}`}
      {...props}
    />
  );

afterEach(cleanup);

describe('CMake console', () => {
  it('opens a failed build on its problems and opens the file at the reported line', () => {
    const onOpenFile = vi.fn();
    renderConsole({ onOpenFile });
    const problems = screen.getByRole('list', { name: 'tools.cmake.problems' });
    expect(within(problems).getAllByRole('button', { name: /expected expression|unused variable/ })).toHaveLength(2);
    expect(screen.getByText('logger.c:12:3')).toBeInTheDocument();
    // The banner only repeats the failure when nothing better was found.
    expect(screen.queryByText('translated:cmake.processExit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('expected expression'));
    expect(onOpenFile).toHaveBeenCalledWith('D:/work/project/src/logger.c', 12, 3);
  });

  it('shows a problem in the output when there is no editor to open', () => {
    renderConsole();
    fireEvent.click(screen.getByText('expected expression'));
    const log = screen.getByRole('log', { name: 'tools.cmake.output' });
    expect(within(log).getByText('src/logger.c:12:3: error: expected expression')).toBeInTheDocument();
  });

  it('follows a running build in the output and explains a failure without parsed problems', () => {
    const { rerender } = renderConsole({ job: job('running'), output: 'compiling' });
    expect(screen.getByRole('log', { name: 'tools.cmake.output' })).toHaveTextContent('compiling');
    rerender(
      <CmakeConsole
        job={job('failed', 'cmake.toolNotFound')}
        output='version command failed'
        truncated
        pending={false}
        projectPath='D:/work/project'
        onCopy={vi.fn(async () => {})}
        errorText={(text) => `translated:${text}`}
      />
    );
    expect(screen.getByText('translated:cmake.toolNotFound')).toBeInTheDocument();
    expect(screen.getByText('tools.cmake.truncated')).toBeInTheDocument();
    expect(screen.getByText('version command failed')).toBeInTheDocument();
  });

  it('copies the whole output', () => {
    const onCopy = vi.fn(async () => {});
    renderConsole({ onCopy });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.copyOutput' }));
    expect(onCopy).toHaveBeenCalledWith(output);
  });

  it('says nothing has run before the first job', () => {
    renderConsole({ job: undefined, output: '' });
    expect(screen.getByText('tools.cmake.consoleIdle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tools.cmake.copyOutput' })).toBeDisabled();
  });
});
