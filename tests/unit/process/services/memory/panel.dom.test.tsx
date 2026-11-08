import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '@/common/types/memory';
import MemoryPanel from '@/renderer/pages/conversation/Memory';
import { withRecalledMemory } from '@/renderer/pages/conversation/platforms/aionrs/memoryRecall';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  openFolder: vi.fn(),
  distill: vi.fn(),
  recall: vi.fn(),
  workspaceOf: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { memory: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])) },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const key = (name: string) => `conversation.memory.${name}`;
const entry: MemoryEntry = {
  file: 'alarm.md',
  name: '报警阈值',
  description: '过流阈值存在 EEPROM',
  type: 'project',
  body: 'AlarmPara 在 parameter.c。',
  updatedAt: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true });
  api.list.mockResolvedValue({ workspace: 'E:\\fw', directory: 'C:\\mem\\E--fw\\memory', entries: [entry] });
  api.getSettings.mockResolvedValue({ autoDistill: true, autoRecall: true });
  api.workspaceOf.mockResolvedValue('E:\\fw');
});
afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('memory panel', () => {
  it('lists the memories of the conversation workspace and edits one', async () => {
    api.save.mockResolvedValue(entry);
    render(<MemoryPanel workspace='E:/fw' conversationId='c1' />);
    fireEvent.click(await screen.findByRole('button', { name: '报警阈值' }));
    // aionrs keys the folder by the conversation's own workspace string.
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ workspace: 'E:\\fw' }));
    fireEvent.change(screen.getByLabelText(key('fields.body')), { target: { value: '新的内容' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        workspace: 'E:\\fw',
        input: expect.objectContaining({ file: 'alarm.md', body: '新的内容', name: '报警阈值' }),
      })
    );
  });

  it('distills the open aionrs conversation on request and switches settings', async () => {
    api.distill.mockResolvedValue({ added: 2, updated: 1 });
    api.setSettings.mockImplementation(async (next) => next);
    render(<MemoryPanel workspace='E:/fw' conversationId='c1' />);
    const distill = await screen.findByRole('button', { name: key('distill') });
    await waitFor(() => expect(distill).not.toBeDisabled());
    fireEvent.click(distill);
    await waitFor(() => expect(api.distill).toHaveBeenCalledWith({ conversationId: 'c1' }));
    expect(await screen.findByText(key('distillDone'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: key('autoRecall') }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({ autoDistill: true, autoRecall: false }));
  });

  it('offers no distill for a conversation of another agent, and searches', async () => {
    api.workspaceOf.mockResolvedValue(null);
    api.search.mockResolvedValue([]);
    render(<MemoryPanel workspace='E:/fw' conversationId='acp-1' />);
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ workspace: 'E:/fw' }));
    expect(screen.getByRole('button', { name: key('distill') })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(key('search')), { target: { value: '没有的' } });
    expect(await screen.findByText(key('noResults'))).toBeInTheDocument();
    expect(api.search).toHaveBeenCalledWith({ workspace: 'E:/fw', query: '没有的' });
  });
});

describe('memories added before sending', () => {
  it('appends the recalled block, and sends the message as typed when recall fails or is slow', async () => {
    api.recall.mockResolvedValueOnce({ block: '[[WOODY_MEMORY]]\nx\n[[/WOODY_MEMORY]]', names: ['x'] });
    expect(await withRecalledMemory('c1', '改阈值')).toBe('改阈值\n\n[[WOODY_MEMORY]]\nx\n[[/WOODY_MEMORY]]');
    api.recall.mockRejectedValueOnce(new Error('backend down'));
    expect(await withRecalledMemory('c1', '改阈值')).toBe('改阈值');
    vi.useFakeTimers();
    try {
      api.recall.mockReturnValueOnce(new Promise(() => undefined));
      const pending = withRecalledMemory('c1', '改阈值');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(await pending).toBe('改阈值');
    } finally {
      vi.useRealTimers();
    }
  });
});
