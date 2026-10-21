import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CmakeProject } from '@/common/types/cmake';
import CmakePanel from '@/renderer/pages/cmake/CmakePanel';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  save: vi.fn(),
  start: vi.fn(),
  read: vi.fn(),
  cancel: vi.fn(),
  aiEnabled: vi.fn(),
  setAiEnabled: vi.fn(),
  debug: vi.fn(),
  debugAiEnabled: vi.fn(),
  setDebugAiEnabled: vi.fn(),
}));
vi.mock('@/common/adapter/cmake', () => ({
  cmake: Object.fromEntries(Object.entries(mocks).map(([name, invoke]) => [name, { invoke }])),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const project: CmakeProject = {
  projectPath: 'D:/meter',
  buildDirectory: 'D:/meter/build/woody/debug',
  dimensions: [],
  selection: {},
  config: {
    tools: { cmake: '', ctest: '', cCompiler: '', cxxCompiler: '', make: '' },
    selections: {},
    jobs: 2,
    target: '',
    runExecutable: 'meter.exe',
    runArguments: [],
    timeoutMs: 300000,
    require32Bit: true,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue(project);
  mocks.aiEnabled.mockResolvedValue(false);
  mocks.debug.mockResolvedValue({});
  mocks.debugAiEnabled.mockResolvedValue(false);
  mocks.save.mockImplementation(async ({ config }) => ({ ...project, config }));
  mocks.start.mockResolvedValue({
    id: 'job',
    projectPath: project.projectPath,
    action: 'build',
    status: 'running',
    buildDirectory: project.buildDirectory,
    startedAt: '',
  });
  mocks.read.mockResolvedValue({
    job: {
      id: 'job',
      projectPath: project.projectPath,
      action: 'build',
      status: 'running',
      buildDirectory: project.buildDirectory,
      startedAt: '',
    },
    output: 'compiling',
    cursor: 9,
    truncated: false,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addListener() {}, removeListener() {} }),
  });
});
afterEach(cleanup);
describe('CMake build panel', () => {
  it('saves debug configuration without launching a debugger', async () => {
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.gdb.debugTab'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.gdb.gdbPath' }), {
      target: { value: 'D:/tools/gdb.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.save' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        projectPath: project.projectPath,
        config: { ...project.config, gdbPath: 'D:/tools/gdb.exe' },
      })
    );
    expect(mocks.debug.mock.calls.some(([request]) => request.operation === 'start')).toBe(false);
  });
  it('shows a debug configuration save failure without launching a debugger', async () => {
    mocks.save.mockRejectedValue(new Error('cmake.invalidRunExecutable'));
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.gdb.debugTab'));
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.save' }));
    await screen.findByText('tools.cmake.invalidRunExecutable');
    expect(mocks.debug.mock.calls.some(([request]) => request.operation === 'start')).toBe(false);
  });
  it('saves debug settings before starting GDB and never starts on tab selection', async () => {
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.gdb.debugTab'));
    expect(mocks.debug.mock.calls.every(([request]) => request.operation === 'status')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.gdb.gdbPath' }), {
      target: { value: 'D:/tools/gdb.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.gdb.start' }));
    await waitFor(() =>
      expect(mocks.debug).toHaveBeenCalledWith({ projectPath: project.projectPath, operation: 'start' })
    );
    expect(mocks.save.mock.calls[0][0].config.gdbPath).toBe('D:/tools/gdb.exe');
  });
  it('does not launch GDB when saving the selected executable fails', async () => {
    mocks.save.mockRejectedValue(new Error('cmake.invalidRunExecutable'));
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.gdb.debugTab'));
    fireEvent.click(screen.getByRole('button', { name: 'tools.gdb.start' }));
    await screen.findByText('tools.cmake.invalidRunExecutable');
    expect(mocks.debug.mock.calls.some(([request]) => request.operation === 'start')).toBe(false);
  });
  it('disables build commands while an AI-started debug session is active', async () => {
    mocks.debug.mockResolvedValue({
      session: {
        id: 'debug',
        projectPath: project.projectPath,
        state: 'stopped',
        revision: 1,
        breakpoints: [],
        output: '',
      },
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'tools.cmake.build' })).toBeDisabled());
  });
  it('hides a watch value after execution resumes and disables memory reads', async () => {
    const session = {
      id: 'debug',
      projectPath: project.projectPath,
      state: 'stopped',
      revision: 1,
      breakpoints: [],
      output: '',
    };
    mocks.debug.mockImplementation(async (request) =>
      request.operation === 'evaluate'
        ? { session, value: '12345' }
        : request.operation === 'continue'
          ? { session: { ...session, state: 'running', revision: 2 } }
          : { session }
    );
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.gdb.debugTab'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.gdb.expression' }), { target: { value: 'counter' } });
    fireEvent.click(screen.getByRole('button', { name: 'tools.gdb.addWatch' }));
    fireEvent.click(screen.getByRole('button', { name: 'tools.gdb.refresh' }));
    await screen.findByText('12345');
    fireEvent.click(screen.getByRole('button', { name: 'tools.gdb.continue' }));
    await waitFor(() => expect(screen.queryByText('12345')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'tools.gdb.readMemory' })).toBeDisabled();
  });
  it('offers editable recovered settings after saved variants disappear', async () => {
    mocks.inspect.mockResolvedValue({ ...project, invalidSelections: ['meterType=removed'] });
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByText(/tools.cmake.selectionChanged/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.save' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ projectPath: project.projectPath, config: project.config })
    );
  });
  it('saves edited settings before starting a shared build', async () => {
    render(<CmakePanel projectPath={project.projectPath} />);
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/tools/cmake.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.build' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0][0].config.tools.cmake).toBe('D:/tools/cmake.exe');
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
  });
  it('shows project discovery errors without enabling build commands', async () => {
    mocks.inspect.mockRejectedValue(new Error('cmake.projectMissing'));
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByText('tools.cmake.projectMissing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'tools.cmake.build' })).not.toBeInTheDocument();
  });
  it('shows AI-started work and allows the same job to be cancelled', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      latestJob: {
        id: 'ai-job',
        projectPath: project.projectPath,
        action: 'build',
        status: 'running',
        startedAt: '',
        buildDirectory: project.buildDirectory,
      },
    });
    mocks.read.mockResolvedValue({
      job: {
        id: 'ai-job',
        projectPath: project.projectPath,
        action: 'build',
        status: 'running',
        startedAt: '',
        buildDirectory: project.buildDirectory,
      },
      output: 'compiling',
      cursor: 9,
      truncated: false,
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByRole('button', { name: 'tools.cmake.build' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.cancel' }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ jobId: 'ai-job' }));
  });
});
