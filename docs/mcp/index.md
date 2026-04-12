---
title: MCP Overview
description: Using CSP Analyser as an MCP server for AI coding agents
---

# MCP Server

CSP Analyser exposes its full functionality as a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server. This means AI coding agents can analyse websites, generate CSP policies, and export deployment-ready configurations without you running CLI commands.

## What is MCP?

The Model Context Protocol is a standard for AI coding agents to discover and invoke tools provided by external servers. Instead of each agent needing a custom integration, MCP provides a single interface that all compliant agents understand.

CSP Analyser's MCP server communicates over **stdio** transport. The agent starts the server as a child process and sends/receives JSON messages over stdin/stdout.

## Supported agents

| Agent | Support | Configuration |
|-------|:-------:|---------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Yes | `.mcp.json` in project root |
| [OpenAI Codex](https://openai.com/index/codex/) | Yes | Agent configuration file |
| [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) | Yes | MCP settings file |
| [GitHub Copilot](https://github.com/features/copilot) | Yes | VS Code MCP settings |

Any agent that implements the MCP client protocol can use CSP Analyser.

## What you can do with MCP

Through the MCP tools, an AI agent can:

- **Crawl a website** and capture all CSP violations in a single tool call
- **Analyse a single page** for quick checks
- **Generate an optimised policy** from captured violations
- **Export in any format**: nginx, Apache, Cloudflare, HTML meta, raw header, or JSON
- **Score the policy** against best practices (A-F grading)
- **Compare two sessions** to detect policy regressions
- **Query violations** filtered by directive, page, or origin
- **Inspect session details** including pages visited and violation summaries
- **Review Permissions-Policy** headers captured during analysis

See the [tools reference](/mcp/tools) for complete documentation of all 10 tools.

## Quick start

1. Configure your agent to start the MCP server (see [configuration](/mcp/configuration))
2. Ask your agent: *"Analyse https://mysite.com for CSP violations and generate a policy"*
3. The agent will call `start_session`, then `generate_policy` or `export_policy`

The MCP server stores all data in a local SQLite database at `.csp-analyser/data.db`, so sessions persist across agent conversations.
