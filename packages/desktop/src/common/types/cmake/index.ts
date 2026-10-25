export type CmakeAction = 'check' | 'configure' | 'build' | 'test' | 'run';
export type CmakeTools = { cmake: string; ctest: string; cCompiler: string; cxxCompiler: string; make: string };
export type CmakeReadOptions = {
  mode: 'auto' | 'direct' | 'powershell';
  encoding: 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';
  powershellPath: string;
};
export type CmakeReadInfo = { reader: 'direct' | 'powershell'; encoding: string; executable?: string };
export type CmakeDiagnostic = {
  kind: 'read' | 'syntax' | 'unsupported' | 'conflict';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  fieldPath?: string;
  supportedFields?: string[];
  attempts?: Array<{ reader: 'direct' | 'powershell'; code: string; executable?: string }>;
};
export type CmakeVariantWarning = {
  code: 'descriptionAlias' | 'descriptionShadowed';
  fieldPath: string;
};
export type CmakeToolCheck = {
  name: keyof CmakeTools;
  path: string;
  status: 'found' | 'missing' | 'failed';
  version?: string;
  error?: string;
};
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
  read?: CmakeReadOptions;
};
export type CmakeChoice = {
  id: string;
  label: string;
  description?: string;
  buildType?: string;
  settings: Record<string, string | number | boolean>;
  env: Record<string, string>;
};
export type CmakeDimension = {
  name: string;
  label: string;
  description?: string;
  defaultChoice: string;
  choices: CmakeChoice[];
};
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
  toolChecks?: CmakeToolCheck[];
};
export type CmakeProject = {
  projectPath: string;
  workspacePath?: string;
  variantsFile?: string;
  configurationError?: string;
  configurationWarnings?: CmakeVariantWarning[];
  diagnostic?: CmakeDiagnostic;
  readInfo?: CmakeReadInfo;
  toolChecks?: CmakeToolCheck[];
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
  /** `.vscode/settings.json` could not be read, so projects came from a folder scan instead. */
  settingsDiagnostic?: CmakeDiagnostic;
};
export type CmakeJobRead = { job: CmakeJob; output: string; cursor: number; truncated: boolean };
