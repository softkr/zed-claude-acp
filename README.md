# Zed Claude ACP

A Yarn-based ACP (Agent Client Protocol) server that bridges Zed External Agents to Claude Code SDK, enabling Claude AI capabilities directly within the Zed editor.

## Features

- ✅ Full ACP protocol implementation for Zed External Agents
- ✅ Session persistence with Claude's native session management
- ✅ Real-time streaming responses
- ✅ Comprehensive tool call support
- ✅ Dynamic permission mode switching
- ✅ Debug logging to stderr (stdout reserved for protocol)
- ✅ ESM-only, TypeScript, Node.js 18+
- ✅ Buffered streaming to reduce update churn
- ✅ Output size capping for large tool outputs/errors
- ✅ Idle session GC for long-running stability
- ✅ Localization (ko/en), lively emojis, optional thinking banner

## Installation

The server automatically detects your preferred package manager based on your project's lock files:
- If `yarn.lock` exists → uses Yarn
- If `package-lock.json` exists → uses npm  
- If `.yarnrc.yml` exists → uses Yarn
- Default fallback → Yarn

### Using Yarn

```bash
yarn dlx zed-claude-acp
```

### Using npm

```bash
npx zed-claude-acp
```

### From Source

```bash
git clone https://github.com/softkr/zed-claude-acp.git
cd zed-claude-acp
yarn install
yarn build
node dist/cli.js
```

## Authentication

Before using the server, you need to authenticate with Claude:

```bash
claude setup-token
```

This will store your authentication in `~/.claude/config.json`. The server automatically uses this authentication.

## Configuration in Zed

Add to your Zed `settings.json`. The server works with both Yarn and npm:

### Basic Configuration

**Using Yarn:**
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "yarn",
      "args": ["dlx", "zed-claude-acp"]
    }
  }
}
```

**Using npm:**
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["--yes", "zed-claude-acp"]
    }
  }
}
```

### Recommended Configuration

With auto-accept edits for better workflow:

**Using Yarn:**
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "yarn",
      "args": ["dlx", "zed-claude-acp"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits"
      }
    }
  }
}
```

**Using npm:**
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["--yes", "zed-claude-acp"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits"
      }
    }
  }
}
```

### With Debug Logging

For troubleshooting:

**Using Yarn:**
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "yarn",
      "args": ["dlx", "zed-claude-acp"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits",
        "ACP_DEBUG": "true"
      }
    }
  }
}
```

**Using npm:**
```json
{
  "agent_servers": {
    "claude-code": {
      "command": "npx",
      "args": ["--yes", "zed-claude-acp"],
      "env": {
        "ACP_PERMISSION_MODE": "acceptEdits",
        "ACP_DEBUG": "true"
      }
    }
  }
}
```

## Permission Modes

The server supports different permission modes for Claude's file operations:

- **`default`** - Asks for permission on all operations (default)
- **`acceptEdits`** - Auto-accepts file edits, asks for other operations (recommended)
- **`bypassPermissions`** - Bypasses all permission checks (use with caution!)
- **`plan`** - Planning mode for structured task execution

### Dynamic Permission Mode Switching

You can change permission modes during a conversation by including special markers in your prompt:

- `[ACP:PERMISSION:ACCEPT_EDITS]` - Switch to acceptEdits mode
- `[ACP:PERMISSION:BYPASS]` - Switch to bypassPermissions mode
- `[ACP:PERMISSION:DEFAULT]` - Switch back to default mode
- `[ACP:PERMISSION:PLAN]` - Switch to plan mode

Note: When `ACP_ENABLE_BYPASS=false`, the BYPASS marker is ignored for safety, and the agent will notify you.

Example:
```
[ACP:PERMISSION:ACCEPT_EDITS]
Please update all TypeScript files to use the new API
```

## Environment Variables

- `ACP_DEBUG` - Set to `"true"` to enable debug logging to stderr
- `ACP_PERMISSION_MODE` - Set default permission mode (`default`, `acceptEdits`, `bypassPermissions`, `plan`)
- `ACP_ALLOW_CONSOLE_LOG` - Set to `"true"` to allow console.log output to stderr (debugging only)
- `ACP_TIMEOUT_MS` - Max time per Claude query in ms (default: 60000)
- `ACP_THINKING_MESSAGE` - Set to `"false"` to hide the initial thinking banner
- `ACP_LANG` / `ACP_LOCALE` - UI language for agent messages (`en`, `ko`; default: `ko`)
- `ACP_ENABLE_BYPASS` - Allow permission bypass switching (default: `true`; set `false` to ignore `[ACP:PERMISSION:BYPASS]`)
- `ACP_TEXT_BUFFER_MS` - Buffering window for streaming text chunks (default: 60)
- `ACP_TEXT_BUFFER_FLUSH_BYTES` - Immediate flush threshold for buffered text in bytes (default: 2048)
- `ACP_MAX_TOOL_OUTPUT_BYTES` - Truncate oversized tool outputs/errors to this many bytes (default: 16384)
- `ACP_SESSION_TTL_MS` - Idle session TTL before GC removal (default: 1800000)
- `ACP_INACTIVITY_TIMEOUT_MS` - Abort a stuck query if no stream activity for this many ms (default: 0, disabled)

## Architecture

This server implements the ACP (Agent Client Protocol) to bridge between:
- **Zed Editor** (ACP client) ← ACP Protocol → **This Server** (ACP agent) ← Claude SDK → **Claude AI**

Key design principles:
- **stdout** is strictly reserved for ACP protocol frames
- All logging goes to **stderr** to avoid protocol corruption
- Session persistence using Claude's native session management
- Clean error handling without crashing the process
- Real-time streaming for responsive interactions
- Buffered text streaming and safe truncation of oversized outputs

## Development

### Prerequisites

- Node.js 18 or higher
- Yarn or npm package manager

### Building from Source

**Using Yarn:**
```bash
# Install dependencies
yarn install

# Type checking
yarn typecheck

# Build the project
yarn build

# Run in development mode
yarn dev

# Format code
yarn format

# Lint code
yarn lint
```

**Using npm:**
```bash
# Install dependencies
npm install

# Type checking
npm run typecheck

# Build the project
npm run build

# Run in development mode
npm run dev

# Format code
npm run format

# Lint code
npm run lint
```

### Project Structure

```
zed-claude-acp/
├── src/
│   ├── cli.ts      # CLI entry point
│   ├── index.ts    # Main application bootstrap
│   ├── agent.ts    # ACP Agent implementation
│   └── types.ts    # TypeScript type definitions
├── dist/           # Compiled JavaScript output
├── package.json    # Package configuration
├── tsconfig.json   # TypeScript configuration
└── README.md       # This file
```

## Debugging

Enable debug logging by setting `ACP_DEBUG=true` in your Zed configuration or environment:

```bash
ACP_DEBUG=true yarn dev
```

Debug logs are written to stderr and include:
- Session creation and management
- Message processing details
- Tool call execution
- Claude SDK interactions
- Stream processing events

## Localization and UX

- Set `ACP_LANG=en` for English or omit for Korean defaults.
- The agent uses clearer, lively emojis for tool start/completion/errors and TODO progress.
- Hide the “thinking” preface with `ACP_THINKING_MESSAGE=false`.

## Changelog

### v0.2.0

- Locale (ko/en) + lively emoji UX
- Configurable timeout, optional thinking banner
- Safe permission BYPASS gating (`ACP_ENABLE_BYPASS`)
- Buffered text streaming (`ACP_TEXT_BUFFER_MS`)
- Tool output/error size cap (`ACP_MAX_TOOL_OUTPUT_BYTES`)
- Idle session GC (`ACP_SESSION_TTL_MS`)
- README updates and environment variable docs

## Safety

- **stdout** is reserved exclusively for ACP protocol communication
- Never use `console.log()` in production code
- All logs, errors, and debug output go to **stderr**
- The server handles errors gracefully without crashing

## Troubleshooting

### "Claude Code process exited" error

Make sure you're authenticated:
```bash
claude setup-token
```

### Session not persisting

The server maintains session context using Claude's native session management. Each ACP session maps to a Claude session that persists throughout the conversation.

### Tool calls not working

Ensure your Zed client is configured to handle tool call updates properly. Check debug logs for tool call events.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Acknowledgments

- [Zed Industries](https://zed.dev) for the amazing editor and ACP protocol
- [Anthropic](https://anthropic.com) for Claude AI and the Claude Code SDK
- The ACP community for protocol development

## Future Enhancements

- [ ] Support for image/audio content blocks
- [ ] Session export/import functionality
- [ ] Improved tool UX with structured panels
- [ ] Metrics and tracing hooks
- [ ] Configuration schema validation

## Links

- [Zed External Agents Documentation](https://zed.dev/docs/ai/external-agents)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [Claude Code SDK](https://github.com/anthropic-ai/claude-code)
