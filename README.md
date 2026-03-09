# OpenClaw Contributor Agent 🦞

An AI agent that autonomously guides you from zero to a merged PR in the
[openclaw/openclaw](https://github.com/openclaw/openclaw) open-source project.

## What it does

| Step | Action |
|------|--------|
| 1 | Scans GitHub for open issues suitable for new contributors |
| 2 | Reads the relevant source code to understand the codebase |
| 3 | Helps you clone and set up the dev environment |
| 4 | Implements the fix / feature in a new git branch |
| 5 | Runs tests (`pnpm test`) and build (`pnpm build`) |
| 6 | Drafts a PR description ready to paste into GitHub |

## Setup

```bash
cd openclaw-agent
npm install        # or pnpm install
```

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
npm start
```

## Example session

```
You › find issues
🤖  Scanning openclaw issues…

Here are 5 good first contributions:

1. #40652 – Gateway invalid-config startup error should suggest --fix …
   Why: Small error-message improvement, no deep knowledge needed.
   …

You › work on #40652
🤖  Fetching issue details…
```

## Tech stack

- **Runtime**: Node.js ≥ 22
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`
- **Model**: Claude Opus 4.6 (adaptive thinking)
- **Language**: TypeScript
