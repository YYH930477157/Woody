export type StaticScanTool = 'clang-tidy' | 'pc-lint';
export type StaticScanScope = 'selected' | 'repository';
export type StaticScanSeverity = 'error' | 'warning' | 'info';

export type StaticScanConfig = {
  tool: StaticScanTool;
  executablePath: string;
  scope: StaticScanScope;
  arguments: string[];
  compileCommandsPath?: string;
  timeoutMs?: number;
};

export type StaticScanDiagnostic = {
  tool: StaticScanTool;
  file: string;
  line: number;
  column?: number;
  severity: StaticScanSeverity;
  message: string;
  rule?: string;
};

export type StaticScanResult = {
  tool: StaticScanTool;
  diagnostics: StaticScanDiagnostic[];
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  executableMissing?: boolean;
};

export type StaticScanMachineConfig = {
  tools: Partial<Record<StaticScanTool, string>>;
};

export type StaticScanProjectConfig = {
  build?: {
    executable?: string;
    arguments?: string[];
    cwd?: string;
    timeoutMs?: number;
    system?: 'iar' | 'cmake';
    project?: string;
    configuration?: string;
    buildDirectory?: string;
  };
  clangTidy?: Omit<StaticScanConfig, 'tool' | 'executablePath'> & { executablePath?: string };
  pcLint?: Omit<StaticScanConfig, 'tool' | 'executablePath'> & { executablePath?: string };
};
