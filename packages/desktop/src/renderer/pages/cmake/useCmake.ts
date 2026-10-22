import { useEffect, useRef, useState } from 'react';
import { cmake } from '@/common/adapter/cmake';
import type { CmakeAction, CmakeConfiguration, CmakeJob, CmakeProject, CmakeWorkspace } from '@/common/types/cmake';

/** Poll the desktop-owned job without overwriting unsaved form edits. */
export function useCmake(projectPath: string) {
  const [workspace, setWorkspace] = useState<CmakeWorkspace>();
  const [discovering, setDiscovering] = useState(false);
  const [scan, setScan] = useState<{ id: number; workspacePath: string; selection?: string }>({
    id: 0,
    workspacePath: '',
  });
  const [project, setProject] = useState<CmakeProject>();
  const [draft, setDraft] = useState<CmakeConfiguration>();
  const [job, setJob] = useState<CmakeJob>();
  const [output, setOutput] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const generation = useRef(0);
  const revision = useRef(0);
  const busy = useRef(false);
  const cursor = useRef({ id: '', value: 0 });
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));

  useEffect(() => {
    const current = ++generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let sourcePath: string | undefined;
    setWorkspace(undefined);
    setDiscovering(!!projectPath);
    setProject(undefined);
    setDraft(undefined);
    setJob(undefined);
    setOutput('');
    setError('');
    setLoadError('');
    setAiEnabled(false);
    cursor.current = { id: '', value: 0 };
    busy.current = false;
    setPending(false);
    async function poll() {
      const observed = revision.current;
      try {
        const result = await cmake.inspect.invoke({ projectPath: sourcePath!, discover: false });
        sourcePath = result.projectPath;
        const enabled = await cmake.aiEnabled.invoke({ projectPath: result.projectPath });
        if (stopped || current !== generation.current || observed !== revision.current) return;
        setProject(result);
        setLoadError('');
        setDraft((previous) => {
          if (!previous) return result.config;
          if (result.configurationError) return previous;
          const selections = Object.fromEntries(
            Object.entries(previous.selections).filter(([name, id]) =>
              result.dimensions.some(
                (dimension) => dimension.name === name && dimension.choices.some((choice) => choice.id === id)
              )
            )
          );
          return Object.keys(selections).length === Object.keys(previous.selections).length
            ? previous
            : { ...previous, selections };
        });
        setAiEnabled(enabled);
        if (result.latestJob) {
          const id = result.latestJob.id;
          const changed = cursor.current.id !== id;
          const read = await cmake.read.invoke({ jobId: id, cursor: changed ? 0 : cursor.current.value });
          if (stopped || current !== generation.current || observed !== revision.current) return;
          cursor.current = { id, value: read.cursor };
          setJob(read.job);
          setOutput((previous) => ((changed ? '' : previous) + read.output).slice(-262144));
          setTruncated((previous) => (changed ? false : previous) || read.truncated);
        }
      } catch (reason) {
        if (!stopped) setLoadError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!stopped && sourcePath)
          timer = setTimeout(() => {
            void poll();
          }, 800);
      }
    }
    async function discover() {
      try {
        const found = await cmake.discover.invoke({
          projectPath,
          ...(scan.workspacePath === projectPath && scan.selection !== undefined ? { selection: scan.selection } : {}),
        });
        if (stopped || current !== generation.current) return;
        setWorkspace(found);
        sourcePath = found.selectedProjectPath;
        if (sourcePath) await poll();
      } catch (reason) {
        if (!stopped) setLoadError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!stopped) setDiscovering(false);
      }
    }
    if (projectPath) void discover();
    return () => {
      stopped = true;
      clearTimeout(timer);
      generation.current++;
    };
  }, [projectPath, scan]);

  async function perform(operation: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    revision.current++;
    const current = generation.current;
    try {
      await operation();
    } catch (reason) {
      if (current === generation.current) report(reason);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
        revision.current++;
      }
    }
  }

  async function saveAndStart(action?: CmakeAction) {
    if (!draft || !project) return;
    const sourcePath = project.projectPath;
    const current = generation.current;
    await perform(async () => {
      const saved = await cmake.save.invoke({ projectPath: sourcePath, config: draft });
      if (current !== generation.current) return;
      setProject(saved);
      setDraft(saved.config);
      if (action) {
        const started = await cmake.start.invoke({
          projectPath: saved.projectPath,
          action,
          selection: saved.config.selections,
        });
        if (current !== generation.current) return;
        setJob(started);
        cursor.current = { id: '', value: 0 };
        setOutput('');
        setTruncated(false);
      }
    });
  }
  return {
    workspace,
    discovering,
    refresh: () => setScan((previous) => ({ id: previous.id + 1, workspacePath: projectPath })),
    selectProject: (selection: string) =>
      setScan((previous) => ({ id: previous.id + 1, workspacePath: projectPath, selection })),
    project,
    draft,
    setDraft,
    job,
    output,
    truncated,
    error: error || loadError,
    pending,
    aiEnabled,
    saveAndStart,
    cancel: () =>
      perform(async () => {
        if (job) await cmake.cancel.invoke({ jobId: job.id });
      }),
    setAiEnabled: (enabled: boolean) =>
      perform(async () => {
        const current = generation.current;
        if (!project) return;
        await cmake.setAiEnabled.invoke({ projectPath: project.projectPath, enabled });
        if (current === generation.current) setAiEnabled(enabled);
      }),
  };
}
