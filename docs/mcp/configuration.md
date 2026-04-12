---
title: MCP Configuration
description: Configure CSP Analyser as an MCP server in your AI coding agent
---

# MCP Configuration

## Claude Code

Add a `.mcp.json` file to your project root:

```json
{
  "mcpServers": {
    "csp-analyser": {
      "command": "node",
      "args": ["node_modules/csp-analyser/dist/mcp-server.js"],
      "env": {}
    }
  }
}
```

Or if CSP Analyser is installed globally:

```json
{
  "mcpServers": {
    "csp-analyser": {
      "command": "csp-analyser-mcp",
      "env": {}
    }
  }
}
```

Claude Code will automatically discover the `.mcp.json` file and start the server when CSP tools are needed.

## VS Code (GitHub Copilot)

Add to your VS Code settings (`.vscode/settings.json`):

```json
{
  "mcp": {
    "servers": {
      "csp-analyser": {
        "command": "node",
        "args": ["node_modules/csp-analyser/dist/mcp-server.js"]
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
      "command": "node",
      "args": ["node_modules/csp-analyser/dist/mcp-server.js"]
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
      "command": "node",
      "args": ["node_modules/csp-analyser/dist/mcp-server.js"]
    }
  }
}
```

## Database location

The MCP server stores its SQLite database at `.csp-analyser/data.db` relative to the working directory. This means:

- Each project gets its own database
- Session data persists across agent conversations
- The `.csp-analyser/` directory is created automatically on first use

::: tip
Add `.csp-analyser/` to your `.gitignore` to avoid committing the database and generated certificates.
:::

## Transport

The MCP server uses **stdio** transport exclusively. The agent starts the server as a child process and communicates over stdin/stdout. No network ports are opened for the MCP protocol itself.

::: info
The report collector HTTP server (for capturing CSP violations from the browser) runs on a random available port during analysis sessions. This is separate from the MCP transport and only active during a crawl.
:::

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging verbosity: `debug`, `info`, `warn`, `error` | `info` |
| `NO_COLOR` | Disable colored log output | unset |

Logs are written to stderr to avoid interfering with the MCP JSON protocol on stdout.
