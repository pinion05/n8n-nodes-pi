# n8n-nodes-pi

n8n community node that launches the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) headlessly (`pi -p --mode json`) from a workflow — fire a coding agent with tools, reuse sessions, or keep it ephemeral.

## Modes

| Mode | What it does | Session |
|---|---|---|
| **One-shot (세션 없음)** | `--no-session` — fire and forget, nothing persisted | ✗ |
| **New Session (새 세션)** | generates a UUID and passes `--session-id` — **sessionId is returned deterministically** (+ `--name`) | ✓ created |
| **Continue Session (재개)** | `--session-id` — continue an existing session with full context | ✓ reused |

Verified E2E: a new session answered "42", a separate continue call recalled "42" — context persists across executions.

## Parameters

- **Prompt** — the prompt (one agent turn)
- **Model** — pattern or `provider/id` (empty = pi default)
- **Working Directory** — project root for the agent (default `/tmp`)
- **Timeout (초)** — kill after N seconds (default 600)
- **Options** — `--no-tools` (text-only, cheaper), extra CLI args

## Output

```json
{
  "ok": true, "mode": "new", "sessionId": "…uuid…",
  "text": "final assistant text",
  "model": "glm-5.3", "usage": {…}, "cost": 0.0007, "durationMs": 4166,
  "exitCode": 0, "stderrTail": null
}
```

## Requirements

- Self-hosted n8n on the same machine/user as your pi CLI + credentials
- pi binary resolvable: `$PI_BIN` env → `PATH` → `~/.npm-global/bin/pi` → npx cache glob

## Install (self-hosted, from source)

```bash
cd ~/.n8n/nodes && npm install <path-to-this-repo>
# then restart n8n
```

Once published to npm: *Settings → Community Nodes → install `n8n-nodes-pi`*.

## Combining with n8n-nodes-intercom

Trigger (cron/webhook) → **Pi Agent** (do the work) → **Intercom** (report result to a live session).

## License

MIT
