// Brand labels for the agents that still exist, plus two non-CLI groups:
//
//   * the six BYOK protocol agent ids (`*-api`), which is how a BYOK turn is
//     stamped on the message (`utils/byokProvider.ts`), and
//   * `qoder` / `cursor`, which are *editor* handoff targets (`HostEditorId`)
//     rather than local CLI agents, so their names still need to read right.
//
// The eighteen CLIs retired in S5a used to be listed here. They are gone: an id
// nothing can spawn should not keep a brand string alive. Historical messages
// that still carry one fall through to the raw id, which is the honest answer.
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  'deepseek-harness': 'DeepSeek Harness',
  'grok-build': 'Grok Build',
  antigravity: 'Antigravity',
  qoder: 'Qoder',
  cursor: 'Cursor',
  'anthropic-api': 'Anthropic API via OpenCode',
  'openai-api': 'OpenAI API via OpenCode',
  'google-gemini-api': 'Google Gemini via OpenCode',
  'deepseek-api': 'DeepSeek API via OpenCode',
  'xai-api': 'xAI API via OpenCode',
  'custom-api': 'Custom API via OpenCode',
};

const AGENT_ALIASES: Record<string, string> = {
  'claude code': 'claude',
  'codex cli': 'codex',
  'deepseek tui': 'deepseek',
  'deepseek-tui': 'deepseek',
  'deepseek harness': 'deepseek-harness',
  'grok build': 'grok-build',
  'qoder cli': 'qoder',
  qodercli: 'qoder',
  agy: 'antigravity',
};

export function agentDisplayName(
  agentId?: string | null,
  fallbackName?: string | null,
): string | null {
  for (const raw of [agentId, fallbackName]) {
    const known = knownAgentLabel(raw);
    if (known) return known;
  }
  for (const raw of [fallbackName, agentId]) {
    const fallback = safeFallbackLabel(raw);
    if (fallback) return fallback;
  }
  return null;
}

/** Canonical icon id for `AgentIcon` (maps to `apps/web/public/agent-icons/`).
 * Returns the agent id whose brand asset should render; falls back to a
 * normalized basename so `AgentIcon`'s letter fallback still reads sensibly.
 */
export function agentIconId(
  agentId?: string | null,
  fallbackName?: string | null,
): string {
  for (const raw of [agentId, fallbackName]) {
    if (!raw) continue;
    const base = raw.split(' · ')[0]?.trim() || raw;
    const key = normalizeKey(base);
    const alias = AGENT_ALIASES[key] ?? key;
    if (AGENT_LABELS[alias]) return alias;
    for (const id of Object.keys(AGENT_LABELS)) {
      if (alias.includes(id)) return id;
    }
  }
  const fallback = normalizeKey(agentId ?? fallbackName ?? '');
  return fallback || 'claude';
}

export function exactAgentDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeKey(raw);
  const alias = AGENT_ALIASES[key] ?? key;
  return AGENT_LABELS[alias] ?? null;
}

export function agentModelDisplayName(
  agentId?: string | null,
  fallbackName?: string | null,
  model?: string | null,
): string | undefined {
  const label = agentDisplayName(agentId, fallbackName) ?? undefined;
  const modelId = displayableModelId(model);
  if (!modelId) return label;
  return label ? `${label} · ${modelId}` : modelId;
}

function knownAgentLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeKey(raw);
  const alias = AGENT_ALIASES[key] ?? key;
  const direct = AGENT_LABELS[alias];
  if (direct) return direct;
  for (const [agentId, label] of Object.entries(AGENT_LABELS)) {
    if (key.includes(agentId)) return label;
  }
  return null;
}

function safeFallbackLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function displayableModelId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === 'default') return null;
  return trimmed;
}

function normalizeKey(raw: string): string {
  const basename = raw.trim().split(/[\\/]/).pop() ?? raw.trim();
  return basename
    .replace(/\.(cmd|exe|bat)$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
