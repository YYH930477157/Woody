/**
 * Long-term memory of the aionrs agent, per project: Markdown files with a small
 * frontmatter in aionrs's own memory folder, indexed by MEMORY.md. Woody reads and
 * writes the same files, recalls the relevant ones before each message, and distills
 * new ones after a conversation goes quiet.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export type MemoryEntry = {
  /** File name inside the memory folder, such as `cmake-build.md`. */
  file: string;
  name: string;
  description: string;
  type?: MemoryType;
  body: string;
  updatedAt: number;
};

export type MemoryProject = {
  workspace: string;
  /** The folder aionrs uses for this workspace; it may not exist yet. */
  directory: string;
  entries: MemoryEntry[];
};

export type MemorySettings = {
  /** Distill memories from a conversation once it has been quiet for five minutes. */
  autoDistill: boolean;
  /** Add the most relevant memories to each message sent to the agent. */
  autoRecall: boolean;
};

export type MemoryInput = {
  /** Update this file; omit to create a new memory. */
  file?: string;
  name: string;
  description: string;
  type?: MemoryType;
  body: string;
};

export type MemoryDistillResult = {
  added: number;
  updated: number;
};

export type MemoryRecall = {
  /** Block to append to the message, or empty when nothing is relevant. */
  block: string;
  names: string[];
};
