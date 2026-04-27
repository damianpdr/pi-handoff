import { complete, type Message } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  SessionManager,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

const MAX_CONVERSATION_CHARS = 120_000;
const CONVERSATION_HEAD_CHARS = 20_000;
const COMMAND_TIMEOUT_MS = 2_000;
const COMMAND_MAX_BUFFER = 512 * 1024;

type PreparedConversation = {
  text: string;
  originalChars: number;
  truncatedChars: number;
};

type HandoffGenerationResult =
  | { ok: true; text: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim();
  return `${text.slice(0, maxChars).trimEnd()}\n… [truncated ${text.length - maxChars} chars]`;
}

function prepareConversation(conversationText: string): PreparedConversation {
  if (conversationText.length <= MAX_CONVERSATION_CHARS) {
    return { text: conversationText, originalChars: conversationText.length, truncatedChars: 0 };
  }

  const tailChars = MAX_CONVERSATION_CHARS - CONVERSATION_HEAD_CHARS;
  const head = conversationText.slice(0, CONVERSATION_HEAD_CHARS).trimEnd();
  const tail = conversationText.slice(-tailChars).trimStart();
  const omitted = conversationText.length - head.length - tail.length;
  const marker = `\n\n[... ${omitted} characters omitted from the middle of a long session. Earlier setup and the latest turns are preserved. Use session_query against the parent session if deeper history is needed. ...]\n\n`;

  return {
    text: `${head}${marker}${tail}`,
    originalChars: conversationText.length,
    truncatedChars: omitted,
  };
}

function runGit(cwd: string, args: string[], maxChars = 20_000): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return truncateText(output.trim(), maxChars);
  } catch {
    return undefined;
  }
}

function collectRepositoryState(cwd = process.cwd()): string {
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"], 4_000);
  if (!root) {
    return `Current working directory: ${cwd}\nGit repository: not detected from this working directory.`;
  }

  const branch = runGit(root, ["branch", "--show-current"], 1_000) || "(detached or unknown)";
  const status = runGit(root, ["status", "--short", "--branch"], 30_000) || "(unable to read status)";
  const unstagedStat = runGit(root, ["diff", "--stat", "--"], 20_000) || "(no unstaged diff)";
  const stagedStat = runGit(root, ["diff", "--cached", "--stat", "--"], 20_000) || "(no staged diff)";
  const recentCommits = runGit(root, ["log", "--oneline", "-5"], 10_000) || "(no recent commits available)";

  return [
    `Current working directory: ${cwd}`,
    `Repository root: ${root}`,
    `Current branch: ${branch}`,
    "",
    "### Git status",
    status,
    "",
    "### Unstaged diff stat",
    unstagedStat,
    "",
    "### Staged diff stat",
    stagedStat,
    "",
    "### Recent commits",
    recentCommits,
  ].join("\n");
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
    description: "Create a new session and auto-submit a handoff summary",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const goal = args.trim() || "Continue from the current conversation in a new session.";

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
      const preparedConversation = prepareConversation(conversationText);
      const repositoryState = collectRepositoryState();
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const truncationNotice = preparedConversation.truncatedChars
        ? `\n\n## Conversation Truncation Notice\n\nThe serialized conversation was ${preparedConversation.originalChars} characters, so ${preparedConversation.truncatedChars} middle characters were omitted before handoff generation. The first ${CONVERSATION_HEAD_CHARS} characters and latest turns were preserved. The generated handoff should mention that the new session can use session_query on the parent session if omitted history is needed.`
        : "";

      const generatedPrompt = await ctx.ui.custom<HandoffGenerationResult>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating handoff summary...");
        loader.onAbort = () => done({ ok: false, cancelled: true });

        const run = async (): Promise<HandoffGenerationResult> => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) {
            return {
              ok: false,
              cancelled: false,
              error: auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error,
            };
          }

          const userMessage: Message = {
            role: "user",
            content: [
              {
                type: "text",
                text: `## Source Session File\n\n${currentSessionFile ?? "(unknown)"}\n\n## Repository State\n\n${repositoryState}${truncationNotice}\n\n## Conversation\n\n${preparedConversation.text}\n\n## Goal\n\n${goal}`,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") {
            return { ok: false, cancelled: true };
          }

          const text = response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();

          if (!text) {
            return { ok: false, cancelled: false, error: "Model returned an empty handoff summary." };
          }

          return { ok: true, text };
        };

        run()
          .then(done)
          .catch((err) => {
            console.error("handoff generation failed", err);
            if (loader.signal.aborted) {
              done({ ok: false, cancelled: true });
              return;
            }
            done({ ok: false, cancelled: false, error: errorMessage(err) });
          });

        return loader;
      });

      if (!generatedPrompt.ok) {
        ctx.ui.notify(
          generatedPrompt.cancelled ? "Handoff cancelled" : `Handoff generation failed: ${generatedPrompt.error}`,
          generatedPrompt.cancelled ? "info" : "error",
        );
        return;
      }

      const parentSessionBlock = currentSessionFile
        ? `**Parent session:** \`${currentSessionFile}\`\n\nUse tool \`session_query\` with this path when details from prior thread are needed.\n\n`
        : "";

      const handoffSummary = `${parentSessionBlock}${generatedPrompt.text}`.trim();

      const next = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          const newSessionFile = replacementCtx.sessionManager.getSessionFile();
          if (newSessionFile) {
            replacementCtx.ui.notify(`Switched to new session: ${newSessionFile}`, "info");
          }

          await replacementCtx.sendUserMessage(handoffSummary);
        },
      });

      if (next.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
      }
    },
  });
}
