export type CmakeAction = 'check' | 'configure' | 'build' | 'test' | 'run';
export type CmakeTools = { cmake: string; ctest: string; cCompiler: string; cxxCompiler: string; make: string };
export type CmakeConfiguration = {
  tools: CmakeTools;
  selections: Record<string, string>;
  jobs: number;
  target: string;
  runExecutable: string;
  runArguments: string[];
  timeoutMs: number;
  require32Bit: boolean;
  gdbPath?: string;
};
export type CmakeChoice = {
  id: string;
  label: string;
  description?: string;
  buildType?: string;
  settings: Record<string, string | number | boolean>;
  env: Record<string, string>;
};
export type CmakeDimension = { name: string; label: string; defaultChoice: string; choices: CmakeChoice[] };
export type CmakeJob = {
  id: string;
  projectPath: string;
  action: CmakeAction;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  buildDirectory: string;
  selection: Record<string, string>;
};
export type CmakeProject = {
  projectPath: string;
  workspacePath?: string;
  variantsFile?: string;
  configurationError?: string;
  config: CmakeConfiguration;
  dimensions: CmakeDimension[];
  selection: Record<string, string>;
  buildDirectory: string;
  latestJob?: CmakeJob;
  invalidSelections?: string[];
};
export type CmakeWorkspace = {
  workspacePath: string;
  projects: Array<{ projectPath: string; relativePath: string }>;
  selectedProjectPath?: string;
};
export type CmakeJobRead = { job: CmakeJob; output: string; cursor: number; truncated: boolean };
