import { useCallback } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import type { Project } from '../../types';

export type ProjectDuplicateHandler = (id: string) => Promise<void> | void;

/**
 * 复制项目 from a card or a rail row: hands the id to the shell's duplicate
 * handler (which POSTs `/api/projects/:id/duplicate`, the same call
 * `od project duplicate` makes) and reports the outcome once, so both
 * surfaces tell one analytics story.
 *
 * Resolves `true` once the copy exists and `false` when the request failed —
 * the failure is already logged and tracked here, so a caller only needs the
 * boolean to decide whether its menu stays open to say so (the switcher's row
 * menu does; the cards let the failure pass).
 */
export function useProjectDuplicateFlow(input: {
  onDuplicate?: ProjectDuplicateHandler;
  analyticsPage?: string;
  workspaceContext: WorkspaceCollabContext | null | undefined;
}) {
  const { onDuplicate, analyticsPage, workspaceContext } = input;
    const duplicate = useCallback(async (project: Project): Promise<boolean> => {
    if (!onDuplicate) return false;
    try {
      await onDuplicate(project.id);
            return true;
    } catch (err) {
      console.warn('[useProjectDuplicateFlow] duplicate project failed:', err);
            return false;
    }
  }, [ analyticsPage, onDuplicate, workspaceContext]);
  return { duplicate };
}
