import { claudeAgentDef } from './defs/claude.js';
import { codexAgentDef } from './defs/codex.js';
import { opencodeAgentDef } from './defs/opencode.js';
import { byokOpenCodeAgentDef } from './defs/byok-opencode.js';
import { grokBuildAgentDef } from './defs/grok-build.js';
import { deepseekAgentDef } from './defs/deepseek.js';
import { deepseekHarnessAgentDef } from './defs/deepseek-harness.js';
import { antigravityAgentDef } from './defs/antigravity.js';
import { readLocalAgentProfileDefs as readLocalAgentProfileDefsFromFile } from './local-profiles.js';
import type { RuntimeAgentDef } from './types.js';

/**
 * The agents this build ships, before anything a particular machine adds.
 *
 * `AGENT_DEFS` below appends whatever local profiles the user has declared, so
 * it answers "what can this machine run" — a different question from "what do
 * we ship", and the wrong list for anything that must hold everywhere. A local
 * profile id is required not to collide with one of these (see
 * `createLocalAgentDef`), so it is always an id we have never heard of.
 */
export const SHIPPED_AGENT_DEFS: RuntimeAgentDef[] = [
  claudeAgentDef,
  codexAgentDef,
  opencodeAgentDef,
  byokOpenCodeAgentDef,
  grokBuildAgentDef,
  deepseekAgentDef,
  deepseekHarnessAgentDef,
  antigravityAgentDef,
];

export function readLocalAgentProfileDefs(
  baseDefs: RuntimeAgentDef[] = SHIPPED_AGENT_DEFS,
): RuntimeAgentDef[] {
  return readLocalAgentProfileDefsFromFile(baseDefs);
}

export const AGENT_DEFS: RuntimeAgentDef[] = [
  ...SHIPPED_AGENT_DEFS,
  ...readLocalAgentProfileDefs(SHIPPED_AGENT_DEFS),
];

const ids = new Set();
for (const def of AGENT_DEFS) {
  if (ids.has(def.id)) {
    throw new Error(`Duplicate agent definition id: ${def.id}`);
  }
  ids.add(def.id);
}

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
