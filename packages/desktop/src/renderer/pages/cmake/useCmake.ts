import { useEffect, useRef, useState } from 'react';
import { cmake } from '@/common/adapter/cmake';
import type { CmakeAction, CmakeConfiguration, CmakeJob, CmakeProject } from '@/common/types/cmake';

/** Poll the desktop-owned job without overwriting unsaved form edits. */
export function useCmake(projectPath: string) {
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
        const result = await cmake.inspect.invoke({ projectPath });
        const enabled = await cmake.aiEnabled.invoke({ projectPath });
        if (stopped || current !== generation.current || observed !== revision.current) return;
        setProject(result);
        setLoadError('');
        setDraft((previous) => previous ?? result.config);
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
        if (!stopped)
          timer = setTimeout(() => {
            void poll();
          }, 800);
      }
    }
    if (projectPath) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      generation.current++;
    };
  }, [projectPath]);

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
    if (!draft) return;
    const current = generation.current;
    await perform(async () => {
      const saved = await cmake.save.invoke({ projectPath, config: draft });
      if (current !== generation.current) return;
      setProject(saved);
      setDraft(saved.config);
      if (action) {
        const started = await cmake.start.invoke({ projectPath, action, selection: saved.config.selections });
        if (current !== generation.current) return;
        setJob(started);
        cursor.current = { id: '', value: 0 };
        setOutput('');
        setTruncated(false);
      }
    });
  }
  return {
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
        await cmake.setAiEnabled.invoke({ projectPath, enabled });
        if (current === generation.current) setAiEnabled(enabled);
      }),
  };
}
