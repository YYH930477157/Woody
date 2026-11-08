import { ipcBridge } from '@/common';

/**
 * Long enough for Woody to stop a memory distill running in this conversation (it
 * waits up to five seconds for the agent), short enough never to hold a send for long.
 */
const RECALL_TIMEOUT_MS = 8000;

/**
 * The message with the project's relevant memories appended in a `[[WOODY_MEMORY]]`
 * block, which the chat view hides. Any failure sends the message as typed.
 */
export async function withRecalledMemory(conversationId: string, input: string): Promise<string> {
  if (typeof window === 'undefined' || !window.electronAPI) return input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const recall = await Promise.race([
      ipcBridge.memory.recall.invoke({ conversationId, text: input }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), RECALL_TIMEOUT_MS);
      }),
    ]);
    return recall?.block ? `${input}\n\n${recall.block}` : input;
  } catch {
    return input;
  } finally {
    clearTimeout(timer);
  }
}
