import { bridge } from './bridge';

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

/** Native providers must send an error reply so a rejected handler cannot strand its caller. */
export function replyProvider<T, P>(name: string) {
  const wire = bridge.buildProvider<Reply<T>, P>(name);
  return {
    provider(handler: (params: P) => T | Promise<T>) {
      const wrapped = async (params: P): Promise<Reply<T>> => {
        try {
          return { ok: true, value: await handler(params) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };
      return wire.provider(wrapped as Parameters<typeof wire.provider>[0]);
    },
    async invoke(params: P): Promise<T> {
      const result = await (wire.invoke as (params: P) => Promise<Reply<T>>)(params);
      if (result.ok === false) throw new Error(result.error);
      return result.value;
    },
  };
}
