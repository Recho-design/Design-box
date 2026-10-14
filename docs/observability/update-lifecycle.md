# Update lifecycle observations

`update_install_result` remains an installer/payload request result, not a restart acknowledgement. `update_apply_observed` remains a later daemon's version-match observation, not proof that a desktop window became usable. Neither event's historical meaning changes.

`update_lifecycle_observed` adds a finite set of stages joined to one installer observation flow by `flow_id`. **These stages are recorded locally only.** The desktop main process writes them into the same install-observation directory as the flow summary, and a later launch reads them back; nothing here is queued, uploaded, or sent to any analytics transport.

| Stage | Meaning | Detail |
|---|---|---|
| install_requested | A persisted install attempt was created | Not installation success |
| shutdown_started | The desktop entered its single shared teardown | Not proof that it exited |
| renderer_quiesced | The window close was requested and the packaged transport barrier blocked new forwarding and aborted in-flight old-origin requests before runtime retirement | Failed means teardown continued but either boundary raised an error |
| cleanup_daemon / cleanup_web | The owned sidecar cleanup returned | Duration, forced and remaining process counts |
| shutdown_completed | Desktop teardown reached its final boundary | Duration and repeated quit count; failed if a caught teardown error occurred |
| predecessor_wait_started | An updater successor started waiting for the old desktop | Only present on after-quit launches |
| predecessor_wait_completed | The predecessor gate resolved | Normal completion, forced termination, or failure; duration |
| desktop_ready | The web mount signal was observed and a healthy main window was revealed | A splash timeout or crash fallback does not count |

Common properties: `flow_id`, `from_version`, `to_version`, `channel`, `platform`, `arch`, `occurred_at`, `observation_version=1`. Stage-specific fields are nonnegative bounded integer milliseconds/counts. No process IDs, file paths, raw errors, credentials or task content are recorded.

## Persistence and local delivery

Each stage is written once to an immutable file beside the existing installer observation. Different stages never rewrite the shared summary. Creation uses a completed temporary file and an exclusive link; duplicate callbacks keep the first observation. Observation I/O is best effort with a 100 ms caller budget, and cannot turn an updater operation into a failure.

The observation root also holds the shared `summary.json` written by the install path (`installer_apply_observation`). A later launch scans that root — at startup and periodically — and joins the stages of the same `flow_id` to that summary. This catches stages written after the earlier daemon exited (particularly desktop readiness) and replays old shutdown stages on a subsequent launch. Collection is stopped with the existing telemetry disposal, and only observations within seven days and the same channel/namespace are considered.

A stage is `queued` only in the sense that its file now exists on disk. No upload acknowledgement is involved, because no upload happens: the record is the durable artifact. A malformed or missing stage file is treated as absent, not as a failed update.

## Reading the records

Group by `flow_id` and slice by from/to version, channel, platform and architecture. Use `occurred_at` for lifecycle ordering — a stage replayed on a later launch keeps its original timestamp, not the time it was read.

- Predecessor-wait latency: duration percentiles of predecessor_wait_completed; split normal/forced/failed.
- Shutdown latency and retries: duration percentiles and repeated_quit_count of shutdown_completed, split by outcome. Require renderer_quiesced to precede cleanup stages for atomic payload handoffs.
- Forced cleanup fraction: forced cleanup events divided by observed cleanup completions, separately for daemon and web.
- Desktop readiness coverage: distinct flows with desktop_ready divided by observed install-request flows, with a defined observation horizon and matching instrumentation versions. Report missing stages as **unknown**, not failure.
- Version-apply success and desktop readiness are separate outcomes. The existing update_apply_observed event supplies the former; do not substitute one for the other.

Old versions can supply their existing flow summaries to the new target but cannot retroactively report their shutdown stages. A client that never starts again leaves its records unread. This is an observed-cohort sample of local records, not an unbiased success rate for all installations. Missing records and retired observation roots must not be counted as failed updates.

Zero remaining processes means the cleanup primitive found no survivors within its owned scope. It is not proof of no unrelated/orphaned processes or of task/data integrity. No claim is made that collection shortens shutdown or rescues an already failed client.

## Acceptance

Exercise both macOS and Windows with a source build containing this instrumentation, then upgrade to the next instrumented candidate. Check flow continuity, normal and forced predecessor waits, slow cleanup, repeated quit requests, and mounted window readiness. Repeat with observation writes failing. Do not use normal launch or a crash-screen reveal as evidence of successful update restart.
