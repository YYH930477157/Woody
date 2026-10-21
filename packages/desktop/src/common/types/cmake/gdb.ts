export type GdbFrame = { level: string; func?: string; file?: string; fullname?: string; line?: string; addr?: string };
export type GdbBreakpoint = { number: string; location: string; file?: string; line?: string };
export type GdbSession = {
  id: string;
  projectPath: string;
  buildDirectory: string;
  executable: string;
  gdbPath: string;
  state: 'starting' | 'running' | 'stopped' | 'stopping' | 'exited' | 'failed';
  reason?: string;
  error?: string;
  frame?: GdbFrame;
  breakpoints: GdbBreakpoint[];
  output: string;
  outputTruncated: boolean;
  revision: number;
};
type SessionInput = { projectPath: string; sessionId: string };
export type GdbRequest =
  | { projectPath: string; operation: 'start' | 'status' }
  | (SessionInput & { operation: 'stop' | 'pause' | 'continue' | 'next' | 'step' | 'finish' | 'stack' | 'locals' })
  | (SessionInput & { operation: 'breakpointAdd'; location: string })
  | (SessionInput & { operation: 'breakpointRemove'; number: string })
  | (SessionInput & { operation: 'evaluate'; expression: string })
  | (SessionInput & { operation: 'memory'; address: string; count: number });
export type GdbReply = {
  session?: GdbSession;
  value?: string;
  stack?: GdbFrame[];
  variables?: { name: string; value?: string; type?: string }[];
  memory?: { begin: string; contents: string }[];
};
