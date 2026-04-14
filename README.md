# pi-handoff

Pi extension for session handoff workflows.

## What it adds
- `/handoff` command
  - summarizes current thread into a structured draft
  - creates a new session with parent linkage
  - pre-fills editor in new session
  - auto-submits after 10s (cancel with `Esc`, stop by typing)
- `session_query` tool
  - query facts from prior `.jsonl` session files
  - path guardrails for sessions directory

## Install
1. Clone this repo.
2. Copy `index.ts` to either:
   - `~/.pi/agent/extensions/handoff/index.ts` (global)
   - `.pi/extensions/handoff/index.ts` (project-local)
3. Restart pi or run `/reload`.

## Usage
- In a session: `/handoff <goal>`
- In new thread, when needed: call `session_query` with parent session path.

## Notes
- Requires model access for generation/query (`@mariozechner/pi-ai` complete API).
- Updated for the current pi coding agent extension API (`@mariozechner/pi-coding-agent`).
- Uses current session events and `modelRegistry.getApiKeyAndHeaders()` for generation/query auth.
