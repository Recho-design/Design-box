# `mocks/golden/` — daemon-event regression snapshots

Each `<trace-id>.events.json` is a committed snapshot of the event
sequence that flows out of the OD daemon's stream handler when fed the
matching mock CLI's output for that recording.

The shape is:

```json
{
  "agent": "claude",
  "trace": "314d6833-...",
  "events": [
    { "type": "status", ... },
    { "type": "tool_use", "name": "Read", ... },
    { "type": "tool_result", ... },
    ...
  ]
}
```

## Why these exist

`mocks/scripts/smoke-test.sh` confirms the mock CLIs *run* and emit
events. It doesn't tell you whether the events have the *right shape*
— a parser change in `apps/daemon/src/runtimes/claude-stream.ts` or
`runtimes/json-event-stream.ts` could silently drop a field, rename
`sessionID` → `sessionId`, or stop emitting `turn_end`. The goldens
pin the expected shape so such a change is visible; the daemon test
that diffed them automatically was removed with the repository's test
layer, so after a parser change compare a live replay against the
committed snapshot manually (or with `mocks/scripts/smoke-test.sh`
output redirected to a file) and treat any diff the same way: if it
matches what the parser refactor intended, regenerate; if it doesn't,
the refactor broke something.

## Updating after an intentional parser change

Re-run a mock CLI recording through the daemon and write the new event
sequence to the matching `mocks/golden/<trace-id>.events.json`, then
let the diff be the part the reviewer eyeballs:

```bash
git diff mocks/golden/
git add mocks/golden/ && git commit -m "mocks: refresh goldens — parser X now emits Y"
```

If the change matches what the parser refactor intended, ship. If it
doesn't, the refactor broke something.

## Coverage

| File | Agent | Trace | Tools | Why it's representative |
|---|---|---|---|---|
| `314d6833…events.json` | claude | 17-tool agent-browser session | 8 | Median complexity for claude; exercises Read / Write / Edit / Bash tool shapes + content_block streaming |
| `9a9522ec…events.json` | opencode | data-report session | 7 | Covers `step_start` / `step_finish` / `tool_use` / `cost` envelope |
| `dcdff3b3…events.json` | codex | 14-tool refactor | 14 | High tool density; exercises `thread.started` + thread message streaming |

Other agents are not golden-tested here for different reasons:

- Plain streams (`deepseek`, `grok`) do not emit structured tool events.
- The retained Gemini parser emits structured `tool_use` / `tool_result`
  events but has no committed golden.
- ACP agents use JSON-RPC over stdio rather than streamed stdout and need a
  different harness.
