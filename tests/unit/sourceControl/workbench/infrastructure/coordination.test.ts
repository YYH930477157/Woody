import { describe, expect, it } from 'vitest';
import { createRepositoryCoordinator } from '@process/services/sourceControl/workbench/coordinator';

describe('repository operation coordination', () => {
  it('serializes linked worktrees sharing refs and releases the queue after failure', async () => {
    const coordinator = createRepositoryCoordinator(async () => 'shared-git-directory');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = coordinator.run('worktree-one', async () => {
      events.push('first');
      await gate;
      throw new Error('failed operation');
    });
    const caught = first.catch(() => events.push('failed'));
    const second = coordinator.run('worktree-two', async () => {
      events.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['first']);
    release();
    await Promise.all([caught, second]);
    expect(events).toEqual(expect.arrayContaining(['first', 'failed', 'second']));
    expect(events.indexOf('second')).toBeGreaterThan(events.indexOf('first'));
  });

  it('allows independent repositories but rejects nested acquisitions rather than bypassing the queue', async () => {
    const coordinator = createRepositoryCoordinator(async (root) => root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.run('one', async () => {
      await expect(coordinator.run('one', async () => 42)).rejects.toThrow(/nested/i);
      await gate;
    });
    expect(await coordinator.run('two', async () => 'independent')).toBe('independent');
    release();
    await first;
  });
});
