/**
 * OpenClaw Contributor Agent
 *
 * Helps you become a contributor to https://github.com/openclaw/openclaw
 * Uses @anthropic-ai/sdk directly with a manual tool-use loop.
 *
 * Tools:
 *  - web_search  (server-side, Anthropic-hosted)
 *  - web_fetch   (server-side, Anthropic-hosted)
 *  - bash        (client-side: executes locally via child_process)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as readline from "readline";

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────
const client = new Anthropic();

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the OpenClaw Contributor Agent — a senior TypeScript/Node.js engineer
whose sole mission is to help the user make real, merged contributions to the
open-source project https://github.com/openclaw/openclaw.

## Project snapshot (as of 2026-03)
- A local-first, multi-channel personal AI assistant (WhatsApp, Telegram,
  Slack, Discord, iMessage, Signal, …)
- Stack: TypeScript / Node.js ≥22, pnpm, Vitest, WebSocket Gateway,
  React UI, Swift (macOS/iOS), Kotlin (Android)
- Dev loop: \`pnpm install && pnpm build\`  /  \`pnpm gateway:watch\`
- Repository: https://github.com/openclaw/openclaw
- Issues tracker: https://github.com/openclaw/openclaw/issues

## Your workflow
1. **Discover** – Search GitHub issues for bug reports or feature requests that
   are (a) clearly scoped, (b) not already claimed, (c) match the user's skills.
   Use web_search and web_fetch to browse issues.

2. **Research** – Once an issue is chosen, fetch the relevant source files from
   GitHub (use raw.githubusercontent.com URLs). Understand the code first.

3. **Set up** – Help the user clone/configure the repo if needed:
     git clone https://github.com/openclaw/openclaw.git
     cd openclaw && pnpm install && pnpm build
   Use a feature branch: git checkout -b fix/<issue-number>-short-desc

4. **Implement** – Write the fix/feature following existing conventions
   (TypeScript strict, camelCase). Add Vitest tests where appropriate.

5. **Verify** – Run pnpm test and pnpm build via the bash tool. Fix failures.

6. **Prepare PR** – Draft a PR title + body that references the issue number
   (e.g. "Fixes #40652").

## Rules
- Always look at actual source before writing code.
- Cite the issue number you're targeting.
- If unsure, ask the user before proceeding.
- Be concise: give actionable next steps.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  // Server-side tools (Anthropic runs them automatically)
  { type: "web_search_20260209", name: "web_search" } as unknown as Anthropic.Tool,
  { type: "web_fetch_20260209", name: "web_fetch" } as unknown as Anthropic.Tool,
  // Client-side bash tool (we execute locally)
  {
    name: "bash",
    description:
      "Run a shell command on the user's local machine. " +
      "Use this to run git, pnpm, node, or any other CLI command. " +
      "Working directory defaults to the user's home directory unless the " +
      "command changes it explicitly. Keep commands non-interactive.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory for the command.",
        },
      },
      required: ["command"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Local bash execution
// ─────────────────────────────────────────────────────────────────────────────
function runBash(command: string, cwd?: string): string {
  try {
    const output = execSync(command, {
      cwd: cwd ?? process.env.HOME,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 4, // 4 MB
    });
    return output || "(no output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";
    const msg = e.message ?? String(err);
    return `ERROR:\n${msg}\nstdout: ${stdout}\nstderr: ${stderr}`.trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agentic loop
// ─────────────────────────────────────────────────────────────────────────────
// Conversation history persists for the whole REPL session
const conversationHistory: Anthropic.MessageParam[] = [];

async function runAgent(userInput: string): Promise<void> {
  conversationHistory.push({ role: "user", content: userInput });

  console.log("\n🤖  Agent is thinking...\n");

  // Max guard to avoid infinite loops
  const MAX_ITERS = 20;
  let iters = 0;

  while (iters < MAX_ITERS) {
    iters++;

    // Stream the response
    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: conversationHistory,
    });

    // Print text deltas in real time
    stream.on("text", (delta) => process.stdout.write(delta));

    const message = await stream.finalMessage();

    // Append assistant response to history
    conversationHistory.push({ role: "assistant", content: message.content });

    // ── end_turn: we're done ──────────────────────────────────────────────
    if (message.stop_reason === "end_turn") {
      console.log("\n");
      break;
    }

    // ── pause_turn: server-side tool hit its iteration cap, continue ──────
    if (message.stop_reason === "pause_turn") {
      // Just loop — the API resumes automatically when we re-send
      continue;
    }

    // ── tool_use: execute client-side tools ───────────────────────────────
    if (message.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of message.content) {
        if (block.type !== "tool_use") continue;

        if (block.name === "bash") {
          const input = block.input as { command: string; cwd?: string };
          console.log(`\n$ ${input.command}\n`);
          const result = runBash(input.command, input.cwd);
          console.log(result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        } else {
          // Unknown client-side tool — shouldn't happen
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
        }
      }

      if (toolResults.length > 0) {
        conversationHistory.push({ role: "user", content: toolResults });
      }

      continue;
    }

    // Any other stop reason (max_tokens, stop_sequence, refusal) — stop
    console.log(`\n[stopped: ${message.stop_reason}]\n`);
    break;
  }

  if (iters >= MAX_ITERS) {
    console.log("\n[max iterations reached]\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       OpenClaw Contributor Agent  🦞                 ║");
  console.log("║  Your path to becoming an openclaw contributor       ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  console.log("Commands:");
  console.log("  find issues    – Scan GitHub for good first contributions");
  console.log("  setup          – Clone & configure the openclaw repo");
  console.log("  work on #<N>   – Start implementing a fix for issue #<N>");
  console.log("  status         – Current git branch state");
  console.log("  prepare pr     – Draft a PR description for the current fix");
  console.log("  quit / exit    – Exit");
  console.log();

  // Check for piped input (non-interactive mode)
  const isPiped = !process.stdin.isTTY;

  while (true) {
    const userInput = await prompt("You › ").catch(() => "quit");
    const trimmed = userInput.trim();

    if (!trimmed) {
      if (isPiped) break; // EOF on pipe
      continue;
    }

    if (["quit", "exit", "q"].includes(trimmed.toLowerCase())) {
      console.log("Goodbye! Good luck with your contributions 🚀");
      rl.close();
      break;
    }

    try {
      await runAgent(trimmed);
    } catch (err) {
      console.error("\n❌  Agent error:", err);
    }

    if (isPiped) break; // One query per pipe invocation
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
