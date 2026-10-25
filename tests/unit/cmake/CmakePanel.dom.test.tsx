import React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, getByText, render, screen, waitFor, within } from '@testing-library/react';
import type { CmakeProject, CmakeToolCheck } from '@/common/types/cmake';
import CmakePanel from '@/renderer/pages/cmake/CmakePanel';
import CmakeTools from '@/renderer/pages/cmake/CmakeTools';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  inspect: vi.fn(),
  reload: vi.fn(),
  revealConfiguration: vi.fn(),
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
  mocks.discover.mockResolvedValue({
    workspacePath: 'D:/workspace',
    projects: [{ projectPath: project.projectPath, relativePath: 'meter' }],
    selectedProjectPath: project.projectPath,
  });
  mocks.inspect.mockResolvedValue(project);
  mocks.reload.mockResolvedValue(project);
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
  it('shows compatibility notices without blocking build or tool inspection', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      variantsFile: 'D:/meter/cmake-variants.yaml',
      configurationWarnings: [
        { code: 'descriptionAlias', fieldPath: 'buildType.description' },
        { code: 'descriptionShadowed', fieldPath: 'buildType.choices.debug.description' },
      ],
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByText('tools.cmake.descriptionAlias')).toBeInTheDocument();
    expect(screen.getByText('tools.cmake.descriptionShadowed')).toBeInTheDocument();
    expect(screen.getByText('buildType.description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tools.cmake.build' })).not.toBeDisabled();
  });
  it('explains unsupported fields while leaving AI authorization and recovery available', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      variantsFile: 'D:/meter/cmake-variants.yaml',
      configurationError: 'cmake.unsupportedVariants: buildType.generator',
      diagnostic: {
        kind: 'unsupported',
        message: 'cmake.unsupportedVariants: buildType.generator',
        fieldPath: 'buildType.generator',
        supportedFields: ['default', 'choices', 'short', 'long', 'description'],
      },
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByText('default, choices, short, long, description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tools.cmake.build' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'tools.cmake.reloadConfiguration' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'tools.cmake.revealConfiguration' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'tools.cmake.aiAccess' }));
    await waitFor(() =>
      expect(mocks.setAiEnabled).toHaveBeenCalledWith({ projectPath: project.projectPath, enabled: true })
    );
  });
  it('shows the root directory name instead of a dot and keeps idle logs collapsed', async () => {
    mocks.discover.mockResolvedValue({
      workspacePath: project.projectPath,
      projects: [{ projectPath: project.projectPath, relativePath: '.' }],
      selectedProjectPath: project.projectPath,
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    expect(screen.getByRole('heading', { name: 'meter' })).toBeInTheDocument();
    expect(screen.queryByText('tools.cmake.noOutput')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'tools.cmake.cancel' })).not.toBeInTheDocument();
  });
  it('explains a folder scan caused by unreadable VS Code settings and keeps reader settings reachable', async () => {
    mocks.discover.mockResolvedValue({
      workspacePath: 'D:/workspace',
      projects: [{ projectPath: project.projectPath, relativePath: 'meter' }],
      selectedProjectPath: project.projectPath,
      settingsDiagnostic: { kind: 'read', message: 'cmake.readPowerShellMissing' },
    });
    render(<CmakePanel projectPath='D:/workspace' />);
    expect(await screen.findByText('tools.cmake.sourceSettingsUnreadable')).toBeInTheDocument();
    expect(screen.getByText('tools.cmake.readPowerShellMissing')).toBeInTheDocument();
    expect(await screen.findByText('tools.cmake.readSettings')).toBeInTheDocument();
  });
  it('keeps unverified tool paths collapsed while tool inspection stays available', async () => {
    render(<CmakePanel projectPath={project.projectPath} />);
    await screen.findByRole('button', { name: 'tools.cmake.check' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('tools.cmake.toolPathColumn'));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
  it('shows verified canonical tool paths even when they differ from saved path spelling', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      config: { ...project.config, tools: { ...project.config.tools, cmake: 'D:/alias/cmake.exe' } },
      toolChecks: [{ name: 'cmake', path: 'D:\\real-tools\\cmake.exe', status: 'found', version: '3.29' }],
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.cmake.toolPathColumn'));
    expect(screen.getByText('tools.cmake.toolFound')).toBeInTheDocument();
    expect(screen.getByText('D:\\real-tools\\cmake.exe')).toBeInTheDocument();
  });
  it('checks tools while invalid variants block builds', async () => {
    mocks.inspect.mockResolvedValue({ ...project, configurationError: 'cmake.invalidVariants: broken' });
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByRole('button', { name: 'tools.cmake.check' }));
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith({
        projectPath: project.projectPath,
        action: 'check',
        selection: {},
      })
    );
  });
  it('clears a previous tool readiness report after saving a different executable', async () => {
    const toolChecks = Object.keys(project.config.tools).map((name) => ({
      name,
      path: `D:/tools/${name}.exe`,
      status: 'found',
      version: '1.2',
    }));
    const checked = {
      ...project,
      toolChecks,
      latestJob: {
        id: 'checked',
        projectPath: project.projectPath,
        action: 'check',
        status: 'succeeded',
        startedAt: '',
        buildDirectory: '',
        selection: {},
        toolChecks,
      },
    };
    mocks.inspect.mockResolvedValue(checked);
    mocks.read.mockResolvedValue({ job: checked.latestJob, output: 'versions', cursor: 8, truncated: false });
    render(<CmakePanel projectPath={project.projectPath} />);
    await screen.findByText('tools.cmake.toolsReady');
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/new/cmake.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.save' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(screen.getByText('tools.cmake.toolsUnchecked')).toBeInTheDocument();
  });
  it('shows failed tool checks with expanded logs and no cancel button', async () => {
    const failedJob = {
      id: 'failed-check',
      projectPath: project.projectPath,
      action: 'check',
      status: 'failed',
      startedAt: '2026-10-22T00:00:00Z',
      finishedAt: '2026-10-22T00:00:01Z',
      buildDirectory: '',
      selection: {},
      error: 'cmake.toolNotFound',
      toolChecks: [{ name: 'cmake', path: 'D:/missing.exe', status: 'missing' }],
    };
    mocks.inspect.mockResolvedValue({ ...project, latestJob: failedJob, toolChecks: failedJob.toolChecks });
    mocks.read.mockResolvedValue({ job: failedJob, output: 'version command failed', cursor: 22, truncated: false });
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByText('version command failed')).toBeInTheDocument();
    expect(screen.getByText('tools.cmake.toolsBlocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'tools.cmake.cancel' })).not.toBeInTheDocument();
  });
  it('keeps edited settings available after an explicit configuration reload fails', async () => {
    mocks.reload.mockRejectedValue(new Error('cmake.configurationReadTimeout'));
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/custom/cmake.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.reloadConfiguration' }));
    await screen.findByText('tools.cmake.configurationReadTimeout');
    expect(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' })).toHaveValue('D:/custom/cmake.exe');
  });
  it('reloads a read failure without losing tool edits and removes obsolete choices', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      config: { ...project.config, selections: { obsolete: 'old' } },
      configurationError: 'cmake.invalidVariants: access denied',
      diagnostic: { kind: 'read', message: 'access denied', file: 'D:/meter/cmake-variants.yaml' },
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/custom/cmake.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.reloadConfiguration' }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledWith({ projectPath: project.projectPath }));
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.save' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        projectPath: project.projectPath,
        config: { ...project.config, tools: { ...project.config.tools, cmake: 'D:/custom/cmake.exe' } },
      })
    );
  });
  it('saves only reader settings during recovery and preserves unsaved tool edits', async () => {
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/unsaved/cmake.exe' },
    });
    fireEvent.click(screen.getByText('tools.cmake.readSettings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.powershellPath' }), {
      target: { value: 'D:/pwsh/pwsh.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.applyReadSettings' }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledWith({
      projectPath: project.projectPath,
      config: {
        ...project.config,
        read: { mode: 'auto', encoding: 'auto', powershellPath: 'D:/pwsh/pwsh.exe' },
      },
    });
    expect(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' })).toHaveValue('D:/unsaved/cmake.exe');
  });
  it('reveals the configuration through the validated project bridge and displays successful reader provenance', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      variantsFile: 'D:/meter/cmake-variants.yaml',
      readInfo: { reader: 'powershell', encoding: 'utf-8', executable: 'D:/pwsh.exe' },
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    await screen.findByText('tools.cmake.effectiveReader');
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.revealConfiguration' }));
    await waitFor(() => expect(mocks.revealConfiguration).toHaveBeenCalledWith({ projectPath: project.projectPath }));
  });
  it('recovers removed selections after repairing variants while preserving unsaved tool edits', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      config: { ...project.config, selections: { oldMode: 'removed' } },
      configurationError: 'cmake.invalidVariants: broken',
    });
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/custom/cmake.exe' },
    });
    mocks.inspect.mockResolvedValue(project);
    await waitFor(() => expect(screen.getByRole('button', { name: 'tools.cmake.build' })).toBeEnabled(), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.save' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        projectPath: project.projectPath,
        config: { ...project.config, tools: { ...project.config.tools, cmake: 'D:/custom/cmake.exe' } },
      })
    );
  });

  it('repairs a conflicting saved combination from the build options', async () => {
    const choice = (id: string, mode: string) => ({ id, label: id, settings: { MODE: mode }, env: {} });
    const dimensions = [
      { name: 'board', label: 'Board', defaultChoice: 'meter', choices: [choice('meter', 'one')] },
      { name: 'mode', label: 'Mode', defaultChoice: 'ok', choices: [choice('ok', 'one'), choice('clash', 'two')] },
    ];
    mocks.inspect.mockResolvedValue({
      ...project,
      dimensions,
      config: { ...project.config, selections: { mode: 'clash' } },
      selection: { board: 'meter', mode: 'clash' },
      configurationError: 'cmake.variantConflict: setting conflict MODE',
      diagnostic: { kind: 'conflict', message: 'cmake.variantConflict: setting conflict MODE' },
    });
    render(<CmakePanel projectPath={project.projectPath} />);
    const selector = await screen.findByRole('combobox', { name: 'Mode' });
    fireEvent.click(selector);
    fireEvent.click(await screen.findByText('ok'));
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.build' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        projectPath: project.projectPath,
        config: { ...project.config, selections: { mode: 'ok' } },
      })
    );
  });
  it('keeps project paths and settings visible when variants fail, but blocks build and debug launch', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      workspacePath: 'D:/workspace',
      variantsFile: 'D:/workspace/cmake-variants.yaml',
      configurationError: 'cmake.invalidVariants: broken yaml',
      buildDirectory: '',
    });
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByText(/tools.cmake.invalidVariants: broken yaml/);
    fireEvent.click(screen.getByText('tools.cmake.projectDetails'));
    expect(screen.getByText(/D:\/workspace\/cmake-variants.yaml/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tools.cmake.build' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'tools.cmake.rescan' })).toBeEnabled();
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    expect(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'tools.cmake.save' })).toBeEnabled();
    fireEvent.click(screen.getByText('tools.gdb.debugTab'));
    expect(screen.getByRole('button', { name: 'tools.gdb.start' })).toBeDisabled();
  });

  it('uses the discovered source directory for build, AI access and GDB', async () => {
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    expect(mocks.aiEnabled).toHaveBeenCalledWith({ projectPath: project.projectPath });
    fireEvent.click(screen.getByRole('switch', { name: 'tools.cmake.aiAccess' }));
    await waitFor(() =>
      expect(mocks.setAiEnabled).toHaveBeenCalledWith({ projectPath: project.projectPath, enabled: true })
    );
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.build' }));
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith({ projectPath: project.projectPath, action: 'build', selection: {} })
    );
    expect(mocks.save).toHaveBeenCalledWith({ projectPath: project.projectPath, config: project.config });
    await waitFor(() =>
      expect(mocks.debug).toHaveBeenCalledWith({ projectPath: project.projectPath, operation: 'status' })
    );
    expect(mocks.debug.mock.calls.some(([request]) => request.projectPath === 'D:/workspace')).toBe(false);
  });
  it('pins polling to the discovered source root and does not repeat workspace discovery', async () => {
    render(<CmakePanel projectPath='D:/workspace' />);
    await waitFor(
      () => expect(mocks.inspect).toHaveBeenCalledWith({ projectPath: project.projectPath, discover: false }),
      { timeout: 3000 }
    );
    expect(mocks.discover).toHaveBeenCalledTimes(1);
    expect(mocks.discover).toHaveBeenCalledWith({ projectPath: 'D:/workspace' });
  });
  it('retries a transient AI status failure without repeating discovery', async () => {
    mocks.aiEnabled.mockRejectedValueOnce(new Error('temporary status failure'));
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByText('temporary status failure');
    await screen.findByRole('button', { name: 'tools.cmake.build' }, { timeout: 3000 });
    expect(mocks.inspect).toHaveBeenLastCalledWith({ projectPath: project.projectPath, discover: false });
  });
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
    expect(screen.getByRole('button', { name: 'tools.cmake.rescan' })).toBeDisabled();
  });
  it('keeps unsaved settings when project reload is cancelled', async () => {
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/custom/cmake.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.rescan' }));
    await screen.findByText('tools.cmake.discardChanges');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(mocks.discover).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' })).toHaveValue('D:/custom/cmake.exe');
  });
  it('rechecks active debug work when an already-open reload confirmation is accepted', async () => {
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    fireEvent.click(screen.getByText('tools.cmake.settings'));
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.cmake.cmakePath' }), {
      target: { value: 'D:/custom/cmake.exe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.rescan' }));
    await screen.findByText('tools.cmake.discardChanges');
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'tools.cmake.rescan' })).toBeDisabled(), {
      timeout: 3000,
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    expect(mocks.discover).toHaveBeenCalledTimes(1);
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
    mocks.discover.mockRejectedValueOnce(new Error('cmake.projectMissing'));
    render(<CmakePanel projectPath={project.projectPath} />);
    expect(await screen.findByText('tools.cmake.projectMissing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'tools.cmake.build' })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.discover).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it('offers rescan when no project exists and automatically loads a newly detected project', async () => {
    mocks.discover.mockResolvedValueOnce({ workspacePath: 'D:/workspace', projects: [] });
    render(<CmakePanel projectPath='D:/workspace' />);
    await screen.findByText('tools.cmake.projectMissing');
    expect(mocks.inspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'tools.cmake.rescan' }));
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    expect(mocks.discover).toHaveBeenCalledTimes(2);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('loads the selected project from a multi-project workspace and remembers the choice', async () => {
    mocks.discover.mockResolvedValueOnce({
      workspacePath: 'D:/workspace',
      projects: [
        { projectPath: 'D:/workspace/one', relativePath: 'one' },
        { projectPath: project.projectPath, relativePath: 'meter' },
      ],
    });
    render(<CmakePanel projectPath='D:/workspace' />);
    const selector = await screen.findByRole('combobox', { name: 'tools.cmake.project' });
    expect(mocks.inspect).not.toHaveBeenCalled();
    fireEvent.click(selector);
    fireEvent.click(await screen.findByText('meter'));
    await screen.findByRole('button', { name: 'tools.cmake.build' });
    expect(mocks.discover).toHaveBeenLastCalledWith({ projectPath: 'D:/workspace', selection: 'meter' });
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
  it('can cancel an externally started job before its first log read completes', async () => {
    mocks.inspect.mockResolvedValue({
      ...project,
      latestJob: {
        id: 'waiting-for-output',
        projectPath: project.projectPath,
        action: 'build',
        status: 'running',
        startedAt: '',
        buildDirectory: project.buildDirectory,
        selection: {},
      },
    });
    mocks.read.mockReturnValue(new Promise(() => {}));
    render(<CmakePanel projectPath={project.projectPath} />);
    fireEvent.click(await screen.findByRole('button', { name: 'tools.cmake.cancel' }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ jobId: 'waiting-for-output' }));
  });
});
describe('CMake tool details', () => {
  const found: CmakeToolCheck[] = [{ name: 'cmake', path: 'D:/tools/cmake.exe', status: 'found', version: '3.29' }];
  const missing: CmakeToolCheck[] = [{ name: 'cmake', path: 'D:/tools/cmake.exe', status: 'missing' }];
  const tools = (checks?: CmakeToolCheck[]) => (
    <CmakeTools
      checks={checks}
      tools={project.config.tools}
      disabled={false}
      invalid={false}
      onCheck={async () => {}}
      errorText={(text) => text}
    />
  );

  it('keeps a click that lands before the first render has settled', async () => {
    // Outside act, a non-urgent render commits before its effects run. Clicking in that gap is what a slow test
    // machine does after findBy* resolves; the details must still open.
    const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      const committed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(container, { childList: true, subtree: true });
      });
      root.render(tools(found));
      await committed;
      fireEvent.click(getByText(container, 'tools.cmake.toolPathColumn'));
      await waitFor(() => expect(within(container).getByText('tools.cmake.toolFound')).toBeInTheDocument());
    } finally {
      root.unmount();
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  it('collapses the details when the header is clicked again', () => {
    render(tools(found));
    fireEvent.click(screen.getByText('tools.cmake.toolPathColumn'));
    expect(screen.getByText('tools.cmake.toolFound')).toBeVisible();
    fireEvent.click(screen.getAllByText('tools.cmake.toolPathColumn')[0]);
    expect(screen.getByRole('button', { name: 'tools.cmake.toolPathColumn' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('opens the details when a later check fails and closes them once it passes', () => {
    const { rerender } = render(tools(found));
    expect(screen.queryByText('tools.cmake.toolMissing')).not.toBeInTheDocument();
    rerender(tools(missing));
    expect(screen.getByText('tools.cmake.toolMissing')).toBeInTheDocument();
    rerender(tools(found));
    expect(screen.getByRole('button', { name: 'tools.cmake.toolPathColumn' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});
