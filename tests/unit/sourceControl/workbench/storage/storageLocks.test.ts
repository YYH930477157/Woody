import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageContext } from '@process/services/sourceControl/workbench/storage/core';
import { fixture, git, scope } from './fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('storage locking', () => {
  it('holds background reads back until a repository mutation has finished', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const contexts = createStorageContext({ ...f.options, git });
    const order: string[] = [];
    let finishMutation: () => void = () => {};

    const mutation = contexts.run(
      scope,
      async () => {
        order.push('mutation started');
        await new Promise<void>((resolve) => (finishMutation = resolve));
        order.push('mutation finished');
      },
      true
    );
    await vi.waitFor(() => expect(order).toEqual(['mutation started']));
    const capture = contexts.run(scope, async () => {
      order.push('capture');
    });
    await flush();

    expect(order).toEqual(['mutation started']);

    finishMutation();
    await Promise.all([mutation, capture]);
    expect(order).toEqual(['mutation started', 'mutation finished', 'capture']);
  });

  it('lets the next action run after one fails', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const contexts = createStorageContext({ ...f.options, git });

    await expect(
      contexts.run(scope, async () => {
        throw new Error('disk full');
      })
    ).rejects.toThrow('disk full');

    await expect(contexts.run(scope, async () => 'ran')).resolves.toBe('ran');
  });
});
