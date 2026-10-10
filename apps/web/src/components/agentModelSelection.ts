import type { AgentInfo, AgentModelChoice } from '../types';

type AgentModelSource =
  | {
      id: AgentInfo['id'];
      models?: Array<{ id: string; enabled?: boolean; default?: boolean }>;
      modelsSource?: 'live' | 'fallback';
    }
  | null
  | undefined;

/** The synthetic "let the CLI decide" model id (daemon `DEFAULT_MODEL_OPTION`). */
export const DEFAULT_AGENT_MODEL_ID = 'default';

/**
 * The model options a picker may OFFER for an agent.
 *
 * `agent.models` is only trustworthy when the daemon actually read it off the
 * installed CLI (`modelsSource === 'live'`). When the probe failed — CLI not on
 * PATH, `models` subcommand unsupported, listing timed out — the daemon
 * substitutes its own hard-coded table and marks it `'fallback'`; those ids are
 * a snapshot of what the CLI accepted when OpenDesign shipped, and offering
 * them invites the user to pick a model their version may not know.
 *
 * So a fallback catalogue collapses to the one entry that is always true: the
 * synthetic `default` ("Default (CLI config)"), which is exactly what the CLI
 * resolves on its own. Pickers keep their free-text / "current value" path
 * beside it, so a user on a brand-new model is never blocked.
 *
 * `modelsSource` absent means an older daemon: keep the historical behaviour
 * and offer the list as given.
 */
export function offeredAgentModelOptions<
  T extends { id: string },
>(
  agent:
    | {
        models?: T[];
        modelsSource?: 'live' | 'fallback';
      }
    | null
    | undefined,
): T[] {
  const models = agent?.models ?? [];
  if (agent?.modelsSource !== 'fallback') return models;
  return models.filter((model) => model.id === DEFAULT_AGENT_MODEL_ID);
}

export function defaultAgentModelId(agent: AgentModelSource): string | null {
  const models = agent?.models ?? [];
  return (
    models.find((model) => model.default === true && model.enabled !== false)?.id ??
    models.find((model) => model.enabled !== false)?.id ??
    null
  );
}

export function normalizeAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  const configuredModel =
    typeof choice?.model === 'string' && choice.model ? choice.model : null;
  if (!configuredModel) return null;
  if (configuredModel === 'default') return null;

  const matchingModel = agent?.models?.find((model) => model.id === configuredModel) ?? null;
  // The one rule this file applies to a model id, shared with
  // `agentModelIsSelectable`: a catalogue can only judge the ids it actually
  // lists. An id it does not list is the user's own hand-typed model — newer
  // than this build, entered in Settings, or read off the CLI — so it is kept,
  // never coerced back to the declared default. Only an id the catalogue lists
  // AND explicitly disables is replaced (the plan gate). `modelsSource` does
  // not enter into it: a fallback table is just a catalogue that cannot see the
  // user's model either (see `offeredAgentModelOptions`).
  //
  // The read path has to agree with the offer gate, or the silent revert comes
  // back: the picker offers the hand-typed id, the click is written, and this
  // function immediately puts the table's default back (and it is not
  // display-only: `effectiveAgentModelChoice` is what `ProjectView` sends).
  if (!matchingModel || matchingModel.enabled !== false) return null;

  const fallbackModel = defaultAgentModelId(agent);
  if (!fallbackModel || fallbackModel === configuredModel) return null;

  return {
    ...choice,
    model: fallbackModel,
  };
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return normalizeAgentModelChoice(agent, choice) ?? choice;
}

export function effectiveAgentModelId(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): string | null {
  const configuredModel = effectiveAgentModelChoice(agent, choice)?.model?.trim();
  return configuredModel && configuredModel !== 'default'
    ? configuredModel
    : defaultAgentModelId(agent);
}

/**
 * Whether `modelId` may be OFFERED to the user as a selectable model.
 *
 * One rule, and the exact complement of `normalizeAgentModelChoice`: the only
 * model that is refused is one the agent's catalogue LISTS and explicitly
 * disables (`enabled === false` — the caller's plan does not include it). An id
 * the catalogue does not list is the user's own hand-typed model — entered in
 * Settings, or newer than this build — and a catalogue cannot testify about a
 * model it never listed, so it must never refuse one. `modelsSource`
 * (`'live'`/`'fallback'`/absent) does not change this: every catalogue is
 * equally unable to judge an id it does not contain.
 *
 * Gating offering on the same rule the read path applies is what makes the
 * picker's free-text / "current value" row safe to offer: nothing it offers can
 * be coerced away underneath the user.
 */
export function agentModelIsSelectable(
  agent: AgentModelSource,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  if (modelId === 'default') return true;
  const option = agent?.models?.find((model) => model.id === modelId) ?? null;
  return option === null || option.enabled !== false;
}
