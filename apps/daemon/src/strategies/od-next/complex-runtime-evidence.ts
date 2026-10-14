import {
  OdNextRuntimeCapabilitySnapshotV1Schema,
  type OpenDesignPlanContractV2,
  type StrategyInputStageV2,
} from '@open-design/contracts';

import {
  hashOdNextRuntimeCapabilitySnapshotV1,
} from '../../runtimes/od-next-capability-gate.js';
import type { OdNextComplexRuntimeEvidence } from './complex-production.js';

interface ComplexRunEvidenceInput {
  phase: 'eligibility' | 'completion';
  taskExecutionId: string;
  runId: string;
  taskRunIndex: number;
  stage: StrategyInputStageV2;
  agentId: string;
  capabilitySnapshot: unknown;
  plan: OpenDesignPlanContractV2;
  run: {
    status: string;
    createdAt: number;
    updatedAt: number;
    events: Array<{ event: string; data: unknown; timestamp?: number }>;
  };
}

/**
 * Build complex evidence only from the admission-frozen capability snapshot.
 *
 * The provider-neutral runtime observations that used to ride along here were
 * built solely for the task-observation exporter, which has been removed; the
 * capability snapshot is what the strategy gates on.
 */
export function resolveDaemonOwnedOdNextComplexRuntimeEvidence(
  input: ComplexRunEvidenceInput,
): OdNextComplexRuntimeEvidence | undefined {
  const parsed = OdNextRuntimeCapabilitySnapshotV1Schema.safeParse(
    input.capabilitySnapshot,
  );
  if (!parsed.success || parsed.data.agentId !== input.agentId) return undefined;
  const { snapshotHash, ...withoutHash } = parsed.data;
  if (hashOdNextRuntimeCapabilitySnapshotV1(withoutHash) !== snapshotHash) {
    return undefined;
  }
  return { capabilitySnapshot: parsed.data };
}
