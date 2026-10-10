
/** HTTPS links for the web UI when an agent is unavailable. Keys match `AGENT_DEFS[].id`. */
const AGENT_INSTALL_LINKS: Record<
  string,
  { installUrl?: string; docsUrl?: string }
> = {
  claude: {
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    installUrl: 'https://github.com/openai/codex',
    docsUrl: 'https://developers.openai.com/codex',
  },
  opencode: {
    installUrl: 'https://opencode.ai/docs',
    docsUrl: 'https://github.com/sst/opencode',
  },
  deepseek: {
    installUrl: 'https://github.com/Hmbown/CodeWhale',
    docsUrl: 'https://github.com/Hmbown/CodeWhale/blob/main/README.md',
  },
  'deepseek-harness': {
    installUrl: 'https://www.deepseek.com/harness/en/',
    docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
  },
};

function sanitizeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function installMetaForAgent(
  agentId: string,
  configuredEnv: Record<string, string> = {},
): { installUrl?: string; docsUrl?: string } {
  const meta = AGENT_INSTALL_LINKS[agentId];
  if (!meta) return {};
  const installUrl = sanitizeHttpsUrl(
    meta.installUrl,
  );
  const docsUrl = sanitizeHttpsUrl(meta.docsUrl);
  return {
    ...(installUrl ? { installUrl } : {}),
    ...(docsUrl ? { docsUrl } : {}),
  };
}
