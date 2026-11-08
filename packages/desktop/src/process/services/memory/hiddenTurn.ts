// Polling follows the turn as it runs and must stay sequential.
/* eslint-disable no-await-in-loop */
/**
 * One hidden turn in an existing conversation: AionCore keeps hidden user messages in
 * the agent's context but out of the chat view (the Git workflow uses the same path).
 * The caller can cancel it, which the send box does before the user's next message.
 */

export type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;

type Runtime = { is_processing?: boolean; can_send_message?: boolean; turn_id?: string | null };
type Conversation = { runtime?: Runtime };
type Message = {
  id: string;
  msg_id?: string;
  position?: string;
  type: string;
  status?: string;
  hidden?: boolean;
  content: unknown;
};
type MessagePage = { items: Message[]; newest_cursor: string | null; has_more_after: boolean };

export class HiddenTurnError extends Error {
  constructor(
    readonly reason: 'busy' | 'cancelled' | 'failed' | 'timeout',
    message: string = reason
  ) {
    super(message);
  }
}

/** Message content is plain text, an object with `content`, or that object as JSON text. */
const readText = (content: unknown): string => {
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && 'content' in parsed) return readText(parsed);
    } catch {
      // Plain text content is valid.
    }
    return content;
  }
  if (content && typeof content === 'object' && 'content' in content) {
    const value = (content as { content?: unknown }).content;
    return typeof value === 'string' ? value : '';
  }
  return '';
};

export type HiddenTurn = {
  /** Resolves with the agent's answer text. */
  answer: Promise<string>;
  cancel: () => Promise<void>;
};

export function startHiddenTurn(
  request: Request,
  conversationId: string,
  prompt: string,
  options: { wait: (ms: number) => Promise<void>; timeoutMs: number; now: () => number }
): HiddenTurn {
  const base = `/api/conversations/${encodeURIComponent(conversationId)}`;
  let turnId: string | undefined;
  let cancelled = false;

  const readAnswer = async (msgId: string): Promise<string> => {
    let path = `${base}/messages?anchor_message_id=${encodeURIComponent(msgId)}&content_mode=full&limit=100`;
    let found = false;
    const answers: string[] = [];
    for (let page = 0; page < 100; page++) {
      const result = await request<MessagePage>('GET', path);
      for (const message of result.items) {
        if (message.id === msgId || message.msg_id === msgId) {
          found = true;
          continue;
        }
        if (!found) continue;
        // The user wrote while the hidden turn ran: the answer is no longer ours alone.
        if (message.position === 'right' && !message.hidden) throw new HiddenTurnError('busy');
        if (message.status === 'error') throw new HiddenTurnError('failed', readText(message.content));
        if (message.type === 'text' && message.position !== 'right') answers.push(readText(message.content));
      }
      if (!result.has_more_after) {
        if (!found) throw new HiddenTurnError('failed', 'The hidden message is missing');
        return answers.join('\n');
      }
      if (!result.newest_cursor) throw new HiddenTurnError('failed');
      path = `${base}/messages?after=${encodeURIComponent(result.newest_cursor)}&content_mode=full&limit=100`;
    }
    throw new HiddenTurnError('failed', 'The answer is too long');
  };

  const answer = (async () => {
    const conversation = await request<Conversation>('GET', base);
    if (!conversation.runtime || conversation.runtime.is_processing || !conversation.runtime.can_send_message)
      throw new HiddenTurnError('busy');
    if (cancelled) throw new HiddenTurnError('cancelled');
    const sent = await request<{ turn_id: string; msg_id: string }>('POST', `${base}/messages`, {
      content: prompt,
      hidden: true,
    });
    turnId = sent.turn_id;
    if (!turnId || !sent.msg_id) throw new HiddenTurnError('failed');
    const deadline = options.now() + options.timeoutMs;
    while (options.now() < deadline) {
      if (cancelled) throw new HiddenTurnError('cancelled');
      const current = await request<Conversation>('GET', base);
      const runtime = current.runtime;
      if (!runtime) throw new HiddenTurnError('failed');
      if (runtime.turn_id && runtime.turn_id !== turnId) throw new HiddenTurnError('busy');
      if (!runtime.is_processing && runtime.can_send_message) return readAnswer(sent.msg_id);
      await options.wait(1000);
    }
    throw new HiddenTurnError('timeout');
  })();
  // A cancelled or failed turn must never surface as an unhandled rejection.
  answer.catch((): void => {});

  const cancel = async () => {
    cancelled = true;
    if (!turnId) return;
    await request('POST', `${base}/cancel`, { turn_id: turnId }).catch((): void => {});
    // Wait briefly for the agent to stop, so the user's message starts a new turn.
    const deadline = options.now() + 5000;
    while (options.now() < deadline) {
      const current = await request<Conversation>('GET', base).catch((): undefined => undefined);
      if (!current?.runtime?.is_processing) return;
      await options.wait(200);
    }
  };
  return { answer, cancel };
}
