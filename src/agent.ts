/**
 * OpenClaw Contributor Agent
 *
 * Helps you become a contributor to https://github.com/openclaw/openclaw
 *
 * Routing:
 *  - "find issues" / "扫描"  → MiniMax (CN) analyses GitHub REST API results
 *  - everything else          → Claude Opus 4.6 with web_search/web_fetch/bash
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─────────────────────────────────────────────────────────────────────────────
// Load .env (simple parser, no extra deps)
// ─────────────────────────────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────────────────────────────
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY

const minimax = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY ?? "",
  baseURL: "https://api.minimax.chat/v1",
});

// ─────────────────────────────────────────────────────────────────────────────
// System prompt (Claude)
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
1. **Discover** – (handled separately by MiniMax scan) Once the user picks an
   issue, deep-dive using web_search and web_fetch.
2. **Research** – Fetch relevant source files from GitHub
   (raw.githubusercontent.com). Understand the code first.
3. **Set up** – Help clone/configure the repo:
     git clone https://github.com/openclaw/openclaw.git
     cd openclaw && pnpm install && pnpm build
   Feature branch: git checkout -b fix/<issue-number>-short-desc
4. **Implement** – Write fix/feature following existing conventions
   (TypeScript strict, camelCase). Add Vitest tests.
5. **Verify** – Run pnpm test and pnpm build. Fix failures.
6. **Prepare PR** – Draft PR title + body referencing the issue
   (e.g. "Fixes #40652").

## Rules
- Always look at actual source before writing code.
- Cite the issue number you're targeting.
- If unsure, ask the user before proceeding.
- Be concise: give actionable next steps.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tools (Claude)
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  { type: "web_search_20260209", name: "web_search" } as unknown as Anthropic.Tool,
  { type: "web_fetch_20260209", name: "web_fetch" } as unknown as Anthropic.Tool,
  {
    name: "bash",
    description:
      "Run a shell command on the user's local machine. " +
      "Use this to run git, pnpm, node, or any other CLI command. " +
      "Keep commands non-interactive.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: { type: "string", description: "Optional working directory." },
      },
      required: ["command"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax: scan GitHub issues
// ─────────────────────────────────────────────────────────────────────────────
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  comments: number;
  html_url: string;
  created_at: string;
}

async function fetchGitHubIssues(count = 30): Promise<GitHubIssue[]> {
  const url =
    `https://api.github.com/repos/openclaw/openclaw/issues` +
    `?state=open&per_page=${count}&sort=created&direction=desc`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openclaw-contributor-agent",
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json() as Promise<GitHubIssue[]>;
}

async function scanIssuesWithMinimax(): Promise<void> {
  console.log("\n🔍  [MiniMax] 正在从 GitHub 拉取 open issues...\n");

  const issues = await fetchGitHubIssues(30);

  // Build a compact summary for the prompt
  const issueList = issues
    .map((i) => {
      const labels = i.labels.map((l) => l.name).join(", ") || "无标签";
      const body = (i.body ?? "").slice(0, 300).replace(/\n+/g, " ");
      return `#${i.number} [${labels}] ${i.title}\n   ${body}`;
    })
    .join("\n\n");

  console.log(`🔍  [MiniMax] 获取到 ${issues.length} 个 issues，正在分析...\n`);

  const stream = await minimax.chat.completions.create({
    model: "MiniMax-Text-01",
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "你是一位资深开源贡献顾问，专注于帮助开发者找到合适的入门贡献机会。" +
          "项目 openclaw 是一个 TypeScript/Node.js 本地 AI 助手，支持多渠道消息。",
      },
      {
        role: "user",
        content:
          `下面是 openclaw 项目当前所有 open issues（共 ${issues.length} 个）。\n\n` +
          `${issueList}\n\n` +
          `请从中挑选 **5 个最适合新贡献者** 入手的 issue，按推荐度排序。\n` +
          `对每个 issue 给出：\n` +
          `1. Issue 编号和标题\n` +
          `2. 为什么适合新手（难度、范围清晰度）\n` +
          `3. 需要哪些技术技能\n` +
          `4. 大致实现思路（1-2 句话）\n\n` +
          `回答用中文，格式清晰。`,
      },
    ],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    process.stdout.write(text);
  }

  console.log("\n");

  // Inject result summary into Claude's conversation history for follow-up
  const issueNumbers = issues.slice(0, 5).map((i) => `#${i.number}`).join(", ");
  conversationHistory.push({
    role: "user",
    content:
      `[系统提示] MiniMax 已完成 issue 扫描，推荐关注：${issueNumbers}。` +
      `用户可以输入 "work on #<编号>" 来开始实现某个 issue。`,
  });
  conversationHistory.push({
    role: "assistant",
    content:
      "已收到 MiniMax 的 issue 分析结果。请告诉我你想从哪个 issue 开始，我来帮你深入研究代码并实现它。",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Local bash execution
// ─────────────────────────────────────────────────────────────────────────────
function runBash(command: string, cwd?: string): string {
  try {
    const output = execSync(command, {
      cwd: cwd ?? process.env.HOME,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 4,
    });
    return output || "(no output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `ERROR:\n${e.message ?? String(err)}\nstdout: ${e.stdout ?? ""}\nstderr: ${e.stderr ?? ""}`.trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude agentic loop
// ─────────────────────────────────────────────────────────────────────────────
const conversationHistory: Anthropic.MessageParam[] = [];

async function runAgent(userInput: string): Promise<void> {
  conversationHistory.push({ role: "user", content: userInput });
  console.log("\n🤖  [Claude] 正在处理...\n");

  const MAX_ITERS = 20;
  let iters = 0;

  while (iters < MAX_ITERS) {
    iters++;

    const stream = claude.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: conversationHistory,
    });

    stream.on("text", (delta) => process.stdout.write(delta));
    const message = await stream.finalMessage();
    conversationHistory.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "end_turn") {
      console.log("\n");
      break;
    }

    if (message.stop_reason === "pause_turn") continue;

    if (message.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "bash") {
          const input = block.input as { command: string; cwd?: string };
          console.log(`\n$ ${input.command}\n`);
          const result = runBash(input.command, input.cwd);
          console.log(result);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        } else {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
        }
      }

      if (toolResults.length > 0) {
        conversationHistory.push({ role: "user", content: toolResults });
      }
      continue;
    }

    console.log(`\n[stopped: ${message.stop_reason}]\n`);
    break;
  }

  if (iters >= MAX_ITERS) console.log("\n[max iterations reached]\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: detect "scan/find issues" commands
// ─────────────────────────────────────────────────────────────────────────────
function isScanCommand(input: string): boolean {
  const lower = input.toLowerCase();
  return (
    lower.includes("find issues") ||
    lower.includes("scan issues") ||
    lower.includes("扫描") ||
    lower.includes("找 issue") ||
    lower.includes("找issue") ||
    lower === "issues"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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
  console.log("  find issues    – 🔍 MiniMax 扫描并推荐最佳 issue");
  console.log("  setup          – Clone & configure the openclaw repo");
  console.log("  work on #<N>   – 🤖 Claude 实现指定 issue 的修复");
  console.log("  status         – Current git branch state");
  console.log("  prepare pr     – Draft a PR description");
  console.log("  quit / exit    – Exit");
  console.log();

  const isPiped = !process.stdin.isTTY;

  while (true) {
    const userInput = await prompt("You › ").catch(() => "quit");
    const trimmed = userInput.trim();

    if (!trimmed) {
      if (isPiped) break;
      continue;
    }

    if (["quit", "exit", "q"].includes(trimmed.toLowerCase())) {
      console.log("Goodbye! 🚀");
      rl.close();
      break;
    }

    try {
      if (isScanCommand(trimmed)) {
        await scanIssuesWithMinimax();
      } else {
        await runAgent(trimmed);
      }
    } catch (err) {
      console.error("\n❌  Error:", err);
    }

    if (isPiped) break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
