import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecentWorkspace,
  DEFAULT_RECENT_WS_KEY,
  getRecentWorkspaces,
} from '@/renderer/components/workspace/recentWorkspaces';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('recent workspaces', () => {
  it('starts empty', () => {
    expect(getRecentWorkspaces()).toEqual([]);
  });

  it('puts the newest first and keeps each folder once', () => {
    addRecentWorkspace('/a');
    addRecentWorkspace('/b');
    addRecentWorkspace('/a');

    expect(getRecentWorkspaces()).toEqual(['/a', '/b']);
  });

  it('remembers five folders', () => {
    for (const name of ['1', '2', '3', '4', '5', '6']) addRecentWorkspace(`/${name}`);

    expect(getRecentWorkspaces()).toEqual(['/6', '/5', '/4', '/3', '/2']);
  });

  it('keeps separate lists per storage key', () => {
    addRecentWorkspace('/a', 'other');

    expect(getRecentWorkspaces()).toEqual([]);
    expect(getRecentWorkspaces('other')).toEqual(['/a']);
  });

  it.each([
    ['broken JSON', '{oops', []],
    ['a string', '"/a"', []],
    ['an object', '{"length":1}', []],
    ['null', 'null', []],
    ['mixed entries', '["/a",7,null]', ['/a']],
  ])('survives storage holding %s', (_name, stored, expected) => {
    localStorage.setItem(DEFAULT_RECENT_WS_KEY, stored);

    expect(getRecentWorkspaces()).toEqual(expected);
    addRecentWorkspace('/new');
    expect(getRecentWorkspaces()).toEqual(['/new', ...expected]);
  });

  it('works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(getRecentWorkspaces()).toEqual([]);
    expect(() => addRecentWorkspace('/a')).not.toThrow();
  });
});
