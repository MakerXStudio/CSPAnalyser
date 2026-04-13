# start

Run the CSP Analyser MCP server over stdio. This is how AI coding agents (Claude Code, Cursor, etc.) invoke CSP Analyser as a tool.

## Usage

```bash
csp-analyser start
```

The command takes no options or arguments. Once started, the process speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdin/stdout and stays running until the transport closes.

You rarely run this directly — agents launch it for you via their MCP server configuration. See the [MCP Server guide](../mcp/) for full details on which tools are exposed, and [MCP Configuration](../mcp/configuration) for how to register the server in Claude Code, Cursor, and other clients.

## Example MCP configuration

Claude Code's `~/.claude.json` entry for the published CLI:

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

Or via the Claude Code CLI:

```bash
claude mcp add csp-analyser -s user -- csp-analyser start
```

## Pointing at a local build

For development — run the server directly from the compiled output without installing globally:

```bash
claude mcp add csp-analyser -s user -- node /path/to/CSPAnalyser/dist/mcp-server.js
```

The `start` subcommand is a thin wrapper that calls `dist/mcp-server.js`, so both forms are equivalent when CSP Analyser is installed.

## Related

- [MCP Server Overview](../mcp/) — what the server does and when to use it
- [MCP Tools Reference](../mcp/tools) — the full list of tools exposed over the MCP transport
- [MCP Configuration](../mcp/configuration) — client-specific setup
