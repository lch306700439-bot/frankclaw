/**
 * OpenClaw Contributor Agent
 *
 * Helps you become a contributor to https://github.com/openclaw/openclaw
 *
 * Fully powered by MiniMax (CN) via OpenAI-compatible API:
 *  - "find issues"  → MiniMax-Text-01 analyses GitHub REST API results
 *  - everything else → MiniMax-Text-01 agentic loop with function calling
 *
 * Client-side tools (executed locally):
 *  - web_fetch  – Node.js fetch()
 *  - web_search – GitHub Search API
 *  - bash       – child_process.execSync
 */

import OpenAI from "openai";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─────────────────────────────────────────────────────────────────────────────
// Load .env
// ─────────────────────────────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax client
// ─────────────────────────────────────────────────────────────────────────────
const MINIMAX_MODEL = "MiniMax-Text-01"; // change to MiniMax-M1 for reasoning

const minimax = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY ?? "",
  baseURL: "https://api.minimax.chat/v1",
});

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
- Dev loop: pnpm install && pnpm build  /  pnpm gateway:watch
- Repository: https://github.com/openclaw/openclaw
- Issues tracker: https://github.com/openclaw/openclaw/issues

## Your workflow
1. Discover – Use web_search/web_fetch to read issue details on GitHub.
2. Research – Fetch relevant source from raw.githubusercontent.com. Read code first.
3. Set up   – Clone repo: git clone https://github.com/openclaw/openclaw.git
              Branch: git checkout -b fix/<issue-number>-short-desc
4. Implement – Follow existing conventions (TypeScript strict, camelCase).
5. Verify   – Run pnpm test && pnpm build via bash tool.
6. PR       – Draft title + body referencing the issue (e.g. "Fixes #40775").

## Rules
- Always read actual source before writing code.
- Cite the issue number you're working on.
- Ask the user when unsure. Be concise.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions (OpenAI function-calling format)
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch the contents of any URL and return the raw text. " +
        "Use raw.githubusercontent.com for GitHub source files. " +
        "Use api.github.com for GitHub REST API calls.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." },
          headers: {
            type: "object",
            description: "Optional HTTP headers (key-value pairs).",
            additionalProperties: { type: "string" },
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search GitHub issues, code, or the web. " +
        "For GitHub issue search use: https://api.github.com/search/issues?q=<query>+repo:openclaw/openclaw. " +
        "For GitHub code search use: https://api.github.com/search/code?q=<query>+repo:openclaw/openclaw.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string." },
          url: {
            type: "string",
            description: "Full GitHub Search API URL (overrides query if provided).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command on the user's local machine (git, pnpm, node, etc.). " +
        "Keep commands non-interactive.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          cwd: { type: "string", description: "Optional working directory." },
        },
        required: ["command"],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────
async function toolWebFetch(url: string, headers?: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "openclaw-contributor-agent",
        Accept: "application/vnd.github.v3+json, text/plain, */*",
        ...headers,
      },
    });
    const text = await res.text();
    // Truncate very large responses
    return text.length > 20_000 ? text.slice(0, 20_000) + "\n...[truncated]" : text;
  } catch (err) {
    return `fetch error: ${String(err)}`;
  }
}

async function toolWebSearch(query: string, url?: string): Promise<string> {
  const target =
    url ??
    `https://api.github.com/search/issues?q=${encodeURIComponent(query + " repo:openclaw/openclaw")}`;
  return toolWebFetch(target);
}

function toolBash(command: string, cwd?: string): string {
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

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "web_fetch":
      return toolWebFetch(args.url as string, args.headers as Record<string, string> | undefined);
    case "web_search":
      return toolWebSearch(args.query as string, args.url as string | undefined);
    case "bash":
      return toolBash(args.command as string, args.cwd as string | undefined);
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax: scan GitHub issues
// ─────────────────────────────────────────────────────────────────────────────
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  html_url: string;
}

async function scanIssuesWithMinimax(): Promise<void> {
  console.log("\n🔍  [MiniMax] 正在从 GitHub 拉取 open issues...\n");

  const res = await fetch(
    "https://api.github.com/repos/openclaw/openclaw/issues?state=open&per_page=30&sort=created&direction=desc",
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "openclaw-contributor-agent",
      },
    }
  );
  const issues = (await res.json()) as GitHubIssue[];

  const issueList = issues
    .map((i) => {
      const labels = i.labels.map((l) => l.name).join(", ") || "无标签";
      const body = (i.body ?? "").slice(0, 300).replace(/\n+/g, " ");
      return `#${i.number} [${labels}] ${i.title}\n   ${body}`;
    })
    .join("\n\n");

  console.log(`🔍  [MiniMax] 获取到 ${issues.length} 个 issues，正在分析...\n`);

  const stream = await minimax.chat.completions.create({
    model: MINIMAX_MODEL,
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "你是一位资深开源贡献顾问，帮助开发者找到合适的入门贡献机会。" +
          "项目 openclaw 是一个 TypeScript/Node.js 本地 AI 助手，支持多渠道消息。",
      },
      {
        role: "user",
        content:
          `下面是 openclaw 项目当前 open issues（共 ${issues.length} 个）。\n\n` +
          `${issueList}\n\n` +
          `请从中挑选 **5 个最适合新贡献者** 入手的 issue，按推荐度排序。\n` +
          `每个给出：编号标题 / 为什么适合新手 / 需要的技术 / 大致实现思路（1-2句）。\n` +
          `用中文回答，格式清晰。`,
      },
    ],
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
  }
  console.log("\n");

  // Seed Claude-style context for follow-up
  conversationHistory.push({
    role: "user",
    content:
      `[系统] MiniMax 已完成 issue 扫描。用户可以输入 "work on #编号" 开始实现。`,
  });
  conversationHistory.push({
    role: "assistant",
    content:
      "已收到扫描结果。请告诉我你想从哪个 issue 开始，我来帮你研究代码并实现修复。",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax agentic loop
// ─────────────────────────────────────────────────────────────────────────────
const conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

async function runAgent(userInput: string): Promise<void> {
  conversationHistory.push({ role: "user", content: userInput });
  console.log("\n🤖  [MiniMax] 正在处理...\n");

  const MAX_ITERS = 20;
  let iters = 0;

  while (iters < MAX_ITERS) {
    iters++;

    const stream = await minimax.chat.completions.create({
      model: MINIMAX_MODEL,
      stream: true,
      tools: TOOLS,
      tool_choice: "auto",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversationHistory,
      ],
    });

    // Collect streamed response
    let textBuffer = "";
    const toolCalls: Array<{
      index: number;
      id: string;
      name: string;
      arguments: string;
    }> = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text delta
      if (delta.content) {
        process.stdout.write(delta.content);
        textBuffer += delta.content;
      }

      // Tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { index: idx, id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }

    // Build assistant message for history
    const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = toolCalls.length > 0
      ? {
          role: "assistant",
          content: textBuffer || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : { role: "assistant", content: textBuffer };

    conversationHistory.push(assistantMsg);

    // No tool calls → done
    if (toolCalls.length === 0) {
      console.log("\n");
      break;
    }

    // Execute tools
    console.log();
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch { /* ignore */ }

      console.log(`\n🔧  ${tc.name}(${JSON.stringify(args)})\n`);
      const result = await dispatchTool(tc.name, args);

      // Show bash output, truncate fetch output
      if (tc.name === "bash") {
        console.log(result);
      } else {
        const preview = result.slice(0, 500);
        console.log(preview + (result.length > 500 ? "\n...[truncated for display]" : ""));
      }

      conversationHistory.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  if (iters >= MAX_ITERS) console.log("\n[max iterations reached]\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
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
const prompt = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       OpenClaw Contributor Agent  🦞                 ║");
  console.log(`║  Powered by MiniMax (${MINIMAX_MODEL})        ║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log();
  console.log("Commands:");
  console.log("  find issues    – 🔍 扫描并推荐最佳 issue");
  console.log("  setup          – Clone & configure the openclaw repo");
  console.log("  work on #<N>   – 🤖 实现指定 issue 的修复");
  console.log("  status         – Current git branch state");
  console.log("  prepare pr     – Draft a PR description");
  console.log("  quit / exit    – Exit");
  console.log();

  const isPiped = !process.stdin.isTTY;

  while (true) {
    const userInput = await prompt("You › ").catch(() => "quit");
    const trimmed = userInput.trim();

    if (!trimmed) { if (isPiped) break; continue; }
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

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
