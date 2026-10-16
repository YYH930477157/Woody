import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ScmResource } from '@/renderer/pages/conversation/SourceControl/scmModel';
import { ScmResourceRow } from '@/renderer/pages/conversation/SourceControl/ScmResourceRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const resource: ScmResource = {
  file: { pe_id: 'pe-1', relative_path: 'src/main.c' },
  repo_relative_path: 'src/main.c',
  state: 'modified',
  staged: false,
};

describe('ScmResourceRow commit selection', () => {
  it('toggles the commit selection without selecting the diff row', () => {
    const onCommitSelection = vi.fn();
    const onSelect = vi.fn();
    render(
      <ScmResourceRow
        resource={resource}
        selected={false}
        onSelect={onSelect}
        commitSelected={false}
        onCommitSelection={onCommitSelection}
        staging
      />
    );

    fireEvent.click(screen.getByRole('checkbox'));

    expect(onCommitSelection).toHaveBeenCalledWith(resource);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disables commit selection for conflicted resources', () => {
    const conflicted = { ...resource, state: 'conflicted' as const };
    render(
      <ScmResourceRow
        resource={conflicted}
        selected={false}
        onSelect={vi.fn()}
        commitSelected={false}
        onCommitSelection={vi.fn()}
        staging
      />
    );

    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});
