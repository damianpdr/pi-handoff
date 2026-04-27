# pi-handoff

Pi extension for session handoff workflows.

## What it adds
- `/handoff` command
  - summarizes current thread into a structured handoff summary
  - includes repository state when run inside a git repo (`git status`, diff stats, recent commits)
  - trims the middle of very long conversations before generation while preserving early setup and latest turns
  - creates a new session with parent linkage
  - immediately submits the handoff summary in the new session, which triggers the assistant to respond
  - does not open an edit/confirmation step
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
- In a session: `/handoff` or `/handoff <goal>`
- In new thread, when needed: call `session_query` with parent session path.

## Notes
- Requires model access for generation/query (`@mariozechner/pi-ai` complete API).
- Updated for the current pi coding agent extension API (`@mariozechner/pi-coding-agent`).
- Uses `modelRegistry.getApiKeyAndHeaders()` for generation/query auth.
- Generation failures are reported separately from user cancellation.

## Smoke test
1. Run `/reload`.
2. Run `/handoff`.
3. Confirm it does not prompt for a goal, does not open an editor, creates/switches to a new session, and auto-submits the handoff summary.
