import { complete, type Message } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  SessionManager,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATUS_KEY = "handoff";
const COUNTDOWN_SECONDS = 10;

const SYSTEM_PROMPT = `You are a context transfer assistant.

Given a conversation history and the user's goal for a new thread, write a comprehensive handoff document for another instance of the assistant.

Requirements:
1) The handoff must be sufficient for seamless continuation without access to the old conversation.
2) Capture exact technical state, not abstractions.
3) Include concrete file paths, symbol names, commands run, test results, observed failures, decisions made, and partial work when materially relevant.
4) Keep only context relevant to the new goal.
5) Output only the handoff document. No preamble or commentary.

Output format:
## Goal
[What the user is trying to accomplish next]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- [Concrete file paths, symbols, commands, test results, errors, or repository state essential to continue]

## Next Steps
1. [What should happen next]`;

const QUERY_SYSTEM_PROMPT = `You answer questions about a prior pi session.

Rules:
- Use only facts from the provided conversation.
- Prefer concrete outputs: file paths, decisions, TODOs, errors.
- If not present, say explicitly: "Not found in provided session.".
- Keep answer concise.`;

type PendingAutoSubmit = {
  ctx: ExtensionContext;
  sessionFile: string | undefined;
  interval: ReturnType<typeof setInterval>;
  unsubscribeInput: () => void;
};

function isEditableInput(data: string): boolean {
  if (!data) return false;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 32 && code !== 127) return true;
    if (code === 8 || code === 13) return true;
  }

  if (data === "\n" || data === "\r") return true;
  if (data === "\x7f") return true;

  if (data.length > 1 && !data.startsWith("\x1b")) return true;

  return false;
}

function statusLine(ctx: ExtensionContext, seconds: number): string {
  const accent = ctx.ui.theme.fg("accent", `handoff auto-submit in ${seconds}s`);
  const hint = ctx.ui.theme.fg("dim", "(type to edit, Esc to cancel)");
  return `${accent} ${hint}`;
}

function getSessionsRoot(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  const normalized = sessionFile.replace(/\\/g, "/");
  const marker = "/sessions/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) {
    return path.dirname(path.resolve(sessionFile));
  }
  return normalized.slice(0, idx + marker.length - 1);
}

function getFallbackSessionsRoot(): string | undefined {
  const configuredDir = process.env.PI_CODING_AGENT_DIR;
  const candidate = configuredDir
    ? path.resolve(configuredDir, "sessions")
    : path.resolve(os.homedir(), ".pi", "agent", "sessions");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function normalizeSessionPath(sessionPath: string, sessionsRoot: string | undefined): string {
  if (path.isAbsolute(sessionPath)) return path.resolve(sessionPath);
  if (sessionsRoot) return path.resolve(sessionsRoot, sessionPath);
  return path.resolve(sessionPath);
}

function sessionPathAllowed(candidate: string, sessionsRoot: string | undefined): boolean {
  if (!sessionsRoot) return true;
  const root = path.resolve(sessionsRoot);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export default function (pi: ExtensionAPI) {
  let pending: PendingAutoSubmit | null = null;

  const clearPending = (ctx?: ExtensionContext, notify?: string) => {
    if (!pending) return;

    clearInterval(pending.interval);
    pending.unsubscribeInput();
    pending.ctx.ui.setStatus(STATUS_KEY, undefined);

    const local = pending;
    pending = null;

    if (notify && ctx) {
      ctx.ui.notify(notify, "info");
    } else if (notify) {
      local.ctx.ui.notify(notify, "info");
    }
  };

  const autoSubmitDraft = () => {
    if (!pending) return;

    const active = pending;
    const currentSession = active.ctx.sessionManager.getSessionFile();
    if (active.sessionFile && currentSession !== active.sessionFile) {
      clearPending(undefined);
      return;
    }

    const draft = active.ctx.ui.getEditorText().trim();
    clearPending(undefined);

    if (!draft) {
      active.ctx.ui.notify("Handoff draft is empty", "warning");
      return;
    }

    active.ctx.ui.setEditorText("");

    try {
      if (active.ctx.isIdle()) {
        pi.sendUserMessage(draft);
      } else {
        pi.sendUserMessage(draft, { deliverAs: "followUp" });
      }
    } catch {
      pi.sendUserMessage(draft);
    }
  };

  const startCountdown = (ctx: ExtensionContext) => {
    clearPending(ctx);

    let seconds = COUNTDOWN_SECONDS;
    ctx.ui.setStatus(STATUS_KEY, statusLine(ctx, seconds));

    const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, Key.escape)) {
        clearPending(ctx, "Handoff auto-submit cancelled");
        return { consume: true };
      }

      if (isEditableInput(data)) {
        clearPending(ctx, "Handoff auto-submit stopped (editing)");
      }

      return undefined;
    });

    const interval = setInterval(() => {
      if (!pending) return;

      seconds -= 1;
      if (seconds <= 0) {
        autoSubmitDraft();
        return;
      }

      ctx.ui.setStatus(STATUS_KEY, statusLine(ctx, seconds));
    }, 1000);

    pending = {
      ctx,
      sessionFile: ctx.sessionManager.getSessionFile(),
      interval,
      unsubscribeInput,
    };
  };

  pi.on("session_start", (_event, ctx) => {
    if (pending) clearPending(ctx);
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (pending) clearPending(ctx);
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (pending) clearPending(ctx);
  });

  pi.on("session_before_tree", (_event, ctx) => {
    if (pending) clearPending(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (pending) clearPending(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (pending) clearPending(ctx);
  });

  pi.registerTool({
    name: "session_query",
    label: "Session Query",
    description:
      "Query a prior pi session file. Use when handoff prompt references a parent session and you need details.",
    promptSnippet: "Query an older pi session file for facts needed by the current thread",
    promptGuidelines: [
      "Use this when a handoff references a parent session and you need concrete details from that older session.",
      "Ask focused factual questions; do not use this as a generic search over unrelated sessions.",
    ],
    parameters: Type.Object({
      sessionPath: Type.String({
        description:
          "Session .jsonl path. Absolute path, or relative to sessions root (e.g. 2026-02-16/foo/session.jsonl)",
      }),
      question: Type.String({ description: "Question about that session" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const sessionsRoot = getSessionsRoot(currentSessionFile) ?? getFallbackSessionsRoot();
      const resolvedPath = normalizeSessionPath(params.sessionPath, sessionsRoot);

      const error = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: { error: true },
      });

      const cancelled = () => ({
        content: [{ type: "text" as const, text: "Session query cancelled." }],
        details: { cancelled: true },
      });

      if (signal?.aborted) {
        return cancelled();
      }

      if (!resolvedPath.endsWith(".jsonl")) {
        return error(`Invalid session path (expected .jsonl): ${params.sessionPath}`);
      }

      if (!sessionPathAllowed(resolvedPath, sessionsRoot)) {
        return error(`Session path outside allowed sessions directory: ${params.sessionPath}`);
      }

      if (!fs.existsSync(resolvedPath)) {
        return error(`Session file not found: ${resolvedPath}`);
      }

      let fileStats: fs.Stats;
      try {
        fileStats = fs.statSync(resolvedPath);
      } catch (err) {
        return error(`Failed to stat session file: ${String(err)}`);
      }

      if (!fileStats.isFile()) {
        return error(`Session path is not a file: ${resolvedPath}`);
      }

      onUpdate?.({
        content: [{ type: "text", text: `Querying: ${resolvedPath}` }],
        details: { status: "loading", sessionPath: resolvedPath },
      });

      let sessionManager: SessionManager;
      try {
        sessionManager = SessionManager.open(resolvedPath);
      } catch (err) {
        return error(`Failed to open session: ${String(err)}`);
      }

      const branch = sessionManager.getBranch();
      const messages = branch
        .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
        .map((entry) => entry.message);

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Session has no messages." }],
          details: { empty: true, sessionPath: resolvedPath },
        };
      }

      if (!ctx.model) {
        return error("No model selected for session query.");
      }

      const conversationText = serializeConversation(convertToLlm(messages));
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!auth.ok || !auth.apiKey) {
          return error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
        }

        const userMessage: Message = {
          role: "user",
          content: [
            {
              type: "text",
              text: `## Session\n\n${conversationText}\n\n## Question\n\n${params.question}`,
            },
          ],
          timestamp: Date.now(),
        };

        const response = await complete(
          ctx.model,
          { systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
          { apiKey: auth.apiKey, headers: auth.headers, signal },
        );

        if (response.stopReason === "aborted") {
          return cancelled();
        }

        const answer = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();

        return {
          content: [{ type: "text" as const, text: answer || "No answer generated." }],
          details: {
            sessionPath: resolvedPath,
            question: params.question,
            messageCount: messages.length,
          },
        };
      } catch (err) {
        if (signal?.aborted) {
          return cancelled();
        }
        if (err instanceof Error && err.name === "AbortError") {
          return cancelled();
        }
        return error(`Session query failed: ${String(err)}`);
      }
    },
  });

  pi.registerCommand("handoff", {
    description: "Create a new session with inherited context and auto-submit draft",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      let goal = args.trim();
      if (!goal) {
        const entered = await ctx.ui.input("handoff goal", "What should the new thread do?");
        if (!entered?.trim()) {
          ctx.ui.notify("Handoff cancelled", "info");
          return;
        }
        goal = entered.trim();
      }

      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
        .map((entry) => entry.message);

      if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "warning");
        return;
      }

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      const generatedPrompt = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating handoff draft...");
        loader.onAbort = () => done(null);

        const run = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) {
            throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
          }

          const userMessage: Message = {
            role: "user",
            content: [
              {
                type: "text",
                text: `## Source Session File\n\n${currentSessionFile ?? "(unknown)"}\n\n## Conversation\n\n${conversationText}\n\n## Goal\n\n${goal}`,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") return null;

          return response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
        };

        run()
          .then(done)
          .catch((err) => {
            console.error("handoff generation failed", err);
            done(null);
          });

        return loader;
      });

      if (!generatedPrompt) {
        ctx.ui.notify("Handoff cancelled", "info");
        return;
      }

      const parentSessionBlock = currentSessionFile
        ? `**Parent session:** \`${currentSessionFile}\`\n\nUse tool \`session_query\` with this path when details from prior thread are needed.\n\n`
        : "";

      const prefillDraft = `${parentSessionBlock}${generatedPrompt}`.trim();

      const editedPrompt = await ctx.ui.editor("Edit handoff draft", prefillDraft);
      if (editedPrompt === undefined) {
        ctx.ui.notify("Handoff cancelled", "info");
        return;
      }

      const next = await ctx.newSession({
        parentSession: currentSessionFile,
      });

      if (next.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      const newSessionFile = ctx.sessionManager.getSessionFile();
      if (newSessionFile) {
        ctx.ui.notify(`Switched to new session: ${newSessionFile}`, "info");
      }

      ctx.ui.setEditorText(editedPrompt);
      startCountdown(ctx);
    },
  });
}
