# External Media Orchestration

This note describes how an external service can use OpenDesign as a creative
runtime while keeping media provider governance outside OpenDesign.

OpenDesign contributes project context, skills, design systems, previews,
artifact structure, and design-aware prompt composition. The external service
owns caller auth, admission, templates, fanout, retries, accounting, webhooks,
provider credentials, budgets, model routing, and provider rate limits.

## Boundary

Run-scoped `mediaExecution` controls only OpenDesign-owned media generation.
It applies to:

- token-gated `/api/tools/media/generate`
- in-run `od media generate` when `OD_TOOL_TOKEN` is present
- OpenDesign's Codex image generation prompt override
- OpenDesign's media generation prompt contract

It intentionally does not apply to external MCP media tools. If a run receives
MCP tools from an external service, that service owns the provider policy for
those tools.

OpenDesign should not grow a generic provider router, provider account pool,
global media budget system, or external executor API unless there is a separate
owner decision for that product surface.

## Recommended Composition

Use HTTP/SSE between the external service and OpenDesign. Avoid shelling out to
`od` from the external service unless the integration specifically needs the CLI
contract.

1. The external service authenticates the caller and decides provider policy.
2. The external service creates or selects an OpenDesign project.
3. The external service starts a run with `mediaExecution` set to the desired
   OpenDesign-owned media policy.
4. The run includes skills and MCP tools that describe the external media
   workflow.
5. OpenDesign handles design/runtime work. External MCP media tools handle
   provider execution when the external service permits it.
6. The external service stores final provider outputs in the project through
   normal artifact or file APIs, or asks the agent to place returned assets in
   the project workspace.

For runs where the external service owns all provider execution, start with:

```json
{
  "agentId": "codex",
  "projectId": "project_123",
  "conversationId": "conversation_123",
  "message": "Create a campaign concept and produce the requested media through the configured media tools.",
  "mediaExecution": {
    "mode": "disabled"
  }
}
```

For runs where OpenDesign may use only a narrow part of its own media path,
use allowlists:

```json
{
  "mediaExecution": {
    "mode": "enabled",
    "allowedSurfaces": ["image"],
    "allowedModels": ["gpt-image-2"]
  }
}
```

## Skill Pattern

A skill should describe creative intent and routing expectations. It should not
embed provider credentials or provider-account policy.

Example `SKILL.md` fragment:

```md
# Media Campaign Skill

Use OpenDesign project context, design-system guidance, and artifact previews
to plan the campaign. When media bytes are needed, use the configured external
media MCP tools. Do not call OpenDesign-owned media generation unless the run
policy explicitly permits it.

For every generated asset, write a short project note that records:

- creative brief
- requested surface and dimensions
- provider-facing prompt summary
- returned asset path or URL
- usage constraints supplied by the external media tool
```

This keeps the skill focused on design workflow. The external tool remains the
authority for provider execution and fulfillment rules.

## MCP Tool Pattern

MCP is the preferred way to expose external media execution to an agent run
without making OpenDesign own provider auth or budgets.

A media MCP server can expose tools such as:

- `media.describe_policy`: return available surfaces, model families, budget
  hints, and safety constraints for the current caller
- `media.submit`: submit a provider request and return an external request id
- `media.status`: poll or fetch completion state
- `media.cancel`: cancel a pending request when supported
- `media.attach_result`: return a URL or project-file placement instruction for
  completed media

These names are illustrative. The stable contract belongs to the MCP server and
the external service, not to OpenDesign core.

The MCP server should receive its own credentials from the external service or
from its deployment environment. OpenDesign should only see the MCP tool
surface made available to the run.

## Artifact Handoff

Prefer one of these handoff shapes:

- The MCP tool returns a downloadable URL and the agent writes or imports the
  asset into the project.
- The external service uploads the fulfilled asset through an OpenDesign
  project file/artifact API after provider completion.
- The MCP tool returns metadata that the agent records in a project manifest or
  handoff note, while the external service keeps the provider artifact as the
  source of truth.

Avoid storing provider credentials, account ids, budget ids, or retry policy in
OpenDesign project files. Project artifacts should describe creative output,
not provider-account governance.

## External Coding Agents (Claude Code / Codex / Cursor / raw API loops)

The sections above describe an external *service* orchestrating OpenDesign. This
one is the smaller, local case: a coding agent working in the user's own repo
wants an image, and OpenDesign owns the provider credentials. The agent never
sees an API key — the daemon reads them from Settings → Media. Three channels,
in preference order.

All three hit the same playground endpoint
(`POST /api/media/playground/generate`): scratch by default, no run, no
conversation, no project required, synchronous. `model` is optional everywhere —
omitting it means "use the daemon's default", the first model in catalog order
whose provider is configured (a stored/env key, or a borrowed sign-in such as
codex-auth). A base URL alone is *not* a configured provider: every image
renderer fails without a key, so resolving one as the default would only produce
a failed card — and, being earlier in catalog order, would shadow a later
provider that does have a key.

Pass the catalog id and let the daemon translate: when `model` names that
provider's *default* catalog model (`gpt-image-2`, `grok-imagine-image`), the
daemon sends the model configured in Settings → Media as the wire name instead,
so an agent never needs to know the real model name behind a custom gateway
that serves exactly one model. An explicit non-default pick (`dall-e-3`) is sent
verbatim — that is a deliberate choice, not something to silently redirect. If
the id still does not exist upstream, the failure is classified `switch-model`
rather than `contact-support`, which is the signal to retry once with another
model from `list_media_models`.

### 1. MCP (recommended)

Register OpenDesign's stdio MCP server in the repo the agent is working in, and
keep it project-scoped. Do not write the agent's global config for a per-repo
integration: `od mcp install <agent>` targets the agent's own (often
user-scoped) config, so use its `--print` mode and paste the snippet into the
repo's project-level file instead.

- Any agent that reads a project-level `.mcp.json` (Claude Code, Cursor, …):
  point the entry at `od mcp` with no arguments — the server discovers the live
  daemon itself (`OD_DAEMON_URL`, inherited sidecar status, then
  `http://127.0.0.1:7456`), so the entry survives daemon restarts and ephemeral
  ports.
- `od mcp install <agent> --print` writes nothing: it reports what it would do,
  and `--print --json` also emits the resolved launch spec (absolute command,
  args, env) plus the config preview it would merge — the same payload
  Settings → MCP shows. Build the project-level entry from that output rather
  than letting the write path decide where the entry goes: paste it into
  `<repo>/.mcp.json` (Claude Code) or `<repo>/.cursor/mcp.json` (Cursor).
- The snippet carries absolute paths and env for the machine that printed it, so
  each developer runs `--print` once in their own checkout; a committed file is
  only right when everyone shares the same install path.

Tools on this path:

- `list_media_models` — read-only: the image model ids the configured providers
  can run (with provider and catalog name), the provider ids, and the aspect
  options. Call it when the agent wants to pick a model; it is not required.
- `generate_image` — `prompt` required; `model`, `project`, `aspect`, `quality`,
  `resolution`, `count` (1-10, default 1) optional. `project` omitted means
  scratch; `model` omitted means the daemon default.

Sync semantics and artifact location:

- The call returns when every slot has finished: expect 10-60s, longer for
  several images or 4K. There is nothing to poll, and `start_run`/`get_run` is
  not a substitute.
- `outputDir` in the response is the absolute base directory and each
  `files[].name` is relative to it, so `<outputDir>/<name>` is the file on disk.
- Scratch results also carry a per-slot `downloadUrl`
  (`GET /api/media/playground/files/<generationId>/<slot>`) for fetching bytes
  over HTTP with curl/GET. Project results do not — that endpoint deliberately
  serves scratch only, so one artifact never has two permission paths; read
  project results back with `get_file`.
- A slot that failed carries its own `error` while its siblings still return, so
  read the per-file shape rather than assuming the call as a whole succeeded.

### 2. CLI shell-out

For an agent that can run a shell but cannot host an MCP server:

```bash
od media models                                            # ids + providers + aspects
od media models --json                                     # raw GET /api/media/models
od media playground generate --prompt "a red panda astronaut" --count 2
od media playground generate --model gpt-image-2 --prompt "..." --aspect 16:9
```

- `--model` is optional: omit it and the daemon resolves the default model. Use
  `od media models` when a specific id is wanted; an invalid id is rejected with
  the list of valid ones.
- Output is one JSON line — the whole generation row, including `outputDir`.
- Exit codes follow the media CLI convention, unchanged: 2 = usage, 3 = daemon
  unreachable, 4 = daemon refused (stderr carries
  `{"error":{"code","message","nextStep"}}`). See `od media playground --help`
  for the full option list.
- `od media generate` (the project-scoped, task-polling path) still requires
  `--model`; only the playground path gained the default.

### 3. Raw HTTP

For a script, or an agent loop that would rather speak HTTP:

```bash
curl -sS -X POST http://127.0.0.1:7456/api/media/playground/generate \
  -H 'content-type: application/json' \
  -d '{"surface":"image","prompt":"a red panda astronaut","count":1}'

curl -sS http://127.0.0.1:7456/api/media/models
curl -sS -o out.png http://127.0.0.1:7456/api/media/playground/files/<generationId>/0
```

- No authentication header. The playground routes are same-origin guarded, where
  a request with no `Origin` header at all (a non-browser client) and a loopback
  `Host` counts as local; a browser page from another origin is rejected with
  403.
- Replace the port with the daemon's own: 7456 is the default, and
  `od daemon status --json` reports the port a running daemon actually bound
  (a dev runtime picks its own).
- The response body is the same generation row the CLI prints and MCP returns,
  so the three channels stay interchangeable.

## Legacy Media Endpoint Caveat

`POST /api/projects/:id/media/generate` predates run-scoped media policy. It is
still available for normal OpenDesign media generation outside the in-run tool
path. The accepted v1 policy closes the cooperative in-run CLI path by routing
`od media generate` through `/api/tools/media/generate` when `OD_TOOL_TOKEN` is
present.

The legacy route is now policy-aware when a tool grant is present. In sandbox
mode it rejects a missing tool token with `TOOL_TOKEN_MISSING`, rejects a token
whose project does not match the route project, and applies the granted run's
media policy. A raw in-run HTTP call can therefore no longer bypass run policy
in sandbox mode.

Outside sandbox mode, a same-origin local UI/CLI caller may still use the
legacy route without a grant for compatibility; that path receives the default
media policy because it is not associated with a run. In-run integrations
should use `OD_TOOL_TOKEN` and `/api/tools/media/generate` instead of depending
on the non-sandbox compatibility behavior.

## Non-goals

This composition pattern does not add:

- `request-only` run mode in OpenDesign core
- OpenDesign media request persistence for external provider work
- a generic HTTP executor provider inside OpenDesign
- provider credentials or account pools in OpenDesign
- OpenDesign-owned provider budgets, retries, or global media limits
- MCP tool routing based on `mediaExecution.allowedSurfaces` or
  `mediaExecution.allowedModels`

If MCP orchestration needs its own constraints later, add a separate explicit
contract for that surface instead of reusing `mediaExecution`.
