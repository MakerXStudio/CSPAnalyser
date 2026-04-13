---
title: MCP Configuration
description: Configure CSP Analyser as an MCP server in your AI coding agent
---

# MCP Configuration

CSP Analyser ships a single entry point for MCP: `csp-analyser start`. This runs the MCP server over stdio and is what every agent configuration below invokes.

## Prerequisites

Install the package so the `csp-analyser` command is on your `PATH`:

```bash
npm install -g @makerx/csp-analyser
csp-analyser setup
```

If you prefer a project-local install, all the examples below still work — just replace `csp-analyser` with `npx csp-analyser`.

## Claude Code

Register CSP Analyser at user scope (available in every project):

```bash
claude mcp add -s user csp-analyser -- csp-analyser start
```

Or add a `.mcp.json` file to your project root for project-scoped access:

```json
{
  "mcpServers": {
    "csp-analyser": {
      "command": "csp-analyser",
      "args": ["start"]
    }
  }
}
```

Claude Code will start the server on demand when CSP tools are needed.

## VS Code (GitHub Copilot)

Add to your VS Code settings (`.vscode/settings.json`):

```json
{
  "mcp": {
    "servers": {
      "csp-analyser": {
        "command": "csp-analyser",
        "args": ["start"]
      }
    }
  }
}
```

## Google Gemini CLI

Add to your Gemini CLI MCP settings:

```json
{
  "mcpServers": {
    "csp-analyser": {
      "command": "csp-analyser",
      "args": ["start"]
    }
  }
}
```

## OpenAI Codex

Configure in your Codex agent's tool configuration:

```json
{
  "mcp_servers": {
    "csp-analyser": {
      "command": "csp-analyser",
      "args": ["start"]
    }
  }
}
```

## Local-build fallback

If you're working on CSP Analyser itself and want to point an MCP client at your dev build rather than a published version, target the CLI entry directly:

```json
{
  "mcpServers": {
    "csp-analyser": {
      "command": "node",
      "args": ["/absolute/path/to/CSPAnalyser/dist/cli.js", "start"]
    }
  }
}
```

## Database location

The MCP server stores its SQLite database in the platform-appropriate user-data directory, regardless of the current working directory:

| Platform | Path |
|----------|------|
| Linux | `$XDG_CONFIG_HOME/csp-analyser/data.db` (defaults to `~/.config/csp-analyser/data.db`) |
| macOS | `~/Library/Application Support/csp-analyser/data.db` |
| Windows | `%LOCALAPPDATA%\csp-analyser\data.db` |

Sessions are tagged with the current project (detected from the nearest `package.json`), so commands like `export`, `score`, and `permissions` auto-resolve to the latest completed session for the project the agent is currently working in.

::: tip
Nothing is written to your project directory. There is no longer a `.csp-analyser/` folder to add to `.gitignore` — data lives in your user-data directory instead.
:::

## Transport

The MCP server uses **stdio** transport exclusively. The agent starts the server as a child process and communicates over stdin/stdout. No network ports are opened for the MCP protocol itself.

::: info
The report collector HTTP server (for capturing CSP violations from the browser) runs on a random available port bound to `127.0.0.1` during analysis sessions. This is separate from the MCP transport and only active while a crawl is in progress.
:::

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `NO_COLOR` | Disable coloured log output | unset |
| `XDG_CONFIG_HOME` | Override the Linux data directory root | `~/.config` |
| `LOCALAPPDATA` | Override the Windows data directory root | Set by Windows |

Logs are written to stderr to avoid interfering with the MCP JSON protocol on stdout.
