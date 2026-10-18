import { describe, expect, it } from 'vitest';
import { mapTodoScanSession } from '@/process/services/todo/emailScanSessions';

describe('mapTodoScanSession', () => {
  it('maps a persisted conversation into a scan session', () => {
    expect(
      mapTodoScanSession(
        { id: 'conversation-1', name: 'Mail scan', created_at: 100, updated_at: 200, status: 'finished' },
        'Email scan',
        300
      )
    ).toEqual({
      id: 'conversation-1',
      name: 'Mail scan',
      created_at: 100,
      updated_at: 200,
      status: 'finished',
    });
  });

  it('ignores conversations without an id and fills missing metadata', () => {
    expect(mapTodoScanSession({ name: 'missing id' }, 'Email scan', 300)).toBeNull();
    expect(mapTodoScanSession({ id: 'conversation-2' }, 'Email scan', 300)).toEqual({
      id: 'conversation-2',
      name: 'Email scan',
      created_at: 300,
      updated_at: 300,
      status: undefined,
    });
  });
});
