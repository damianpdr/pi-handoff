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
2. Copy `index.ts` to:
   - `~/.pi/agent/extensions/handoff/index.ts`
3. Restart pi.

## Usage
- In a session: `/handoff <goal>`
- In new thread, when needed: call `session_query` with parent session path.

## Notes
- Requires model access for generation/query (`@mariozechner/pi-ai` complete API).
- Extension targets pi coding agent extension API (`@mariozechner/pi-coding-agent`).
