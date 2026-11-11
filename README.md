# THE REAL TALK

**An MCP server and Figma plugin that let Claude build real design systems in Figma Design. Local, unlimited, no paid seat.**

THE REAL TALK started as a fork of [cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp) by Sonny Lazuardi and Grab. We used it every day to build design systems for our clients, hit its limits, and rebuilt most of it. It is now a different connector: 114 tools instead of 44, a secured relay, and commands built for files with thousands of nodes and variables.

Works with Claude Code, Claude Desktop and any MCP client.

## Why not the official Figma MCP server?

The official server is great for reading designs into code. For writing a design system, we needed something else:

- **No usage limits.** Everything runs on your machine through the Figma plugin API. Read as much as you write, which is how you verify an agent's work.
- **No paid seat, no usage billing.** You only need Figma Desktop.
- **Nothing leaves your machine.** The relay listens on 127.0.0.1 only. No analytics, no remote calls.

## What you get on top of the original

### Variables and tokens, the full lifecycle
Create collections, modes and variables (color, number, string, boolean). Set values per mode, aliases, scopes, code syntax, descriptions and publishing. Rename and delete. Bind any variable to fills, strokes, radius, padding, gap and size, or force a mode on a whole subtree.

### Batch work on real files
- `bind_variable_batch`: bind fields on every matching node under a root, filtered by type, name, raw value or existing binding. Dry run first.
- `rebind_variable_usages`: replace one variable by another everywhere, with counts per field. Dry run required.
- `find_variable_usages`, `get_nodes_bindings`: see exactly which node uses what.
- `audit_bindings`: list every raw value that should be a token, with totals per rule.

Batch commands run with a time budget and a cursor, so a huge file is processed in pieces and resumed, never half done in silence.

### Build a whole screen in one call
`build_tree` takes a JSON tree (frames, text, auto layout, components, instances, bindings, styles, modes) and builds it in one call. All or nothing: if one node fails, nothing is left behind. No invented defaults: a property you do not set stays at Figma's default.

### Components, styles and the rest
Components and variants, component properties, instance swap and detach. Text, paint and effect styles. Text range styles, line height in pixels or percent. Pages, layout grids, effects, prototype reactions, boolean operations, SVG import, groups.

### Reliability
- Responses over 1 MB are sent in chunks and reassembled.
- Heavy commands are queued one at a time in the plugin. A command already received is never run twice.
- Per tool timeouts, extended by a progress signal from the plugin, with a hard cap.
- The plugin reconnects by itself on the same channel. Each Figma file gets a fixed channel named after the file, and `list_channels` shows which files are connected.
- Errors always carry the real message, its type and the command that failed.

### Security
- Relay bound to 127.0.0.1, protected by a secret token (created once, file mode 600) and an Origin check.
- Plugin network access limited to `ws://localhost:3055`.
- `set_image_fill` accepts local files or base64 only, no remote URLs.
- The relay log records metadata only (time, channel, command, size, duration, result), never design content.

## How it works

```
MCP client <-stdio-> MCP server (dist/server.js) <-WebSocket 127.0.0.1:3055-> relay (src/socket.ts) <-WebSocket-> Figma plugin
```

## Install

Requirements: [Bun](https://bun.sh) and Figma Desktop.

```bash
git clone https://github.com/jdev88-14/the-real-talk.git
cd the-real-talk
bun install --frozen-lockfile
bun run build
```

Start the relay (it creates your access token on first run):

```bash
bun run socket
```

Add the MCP server to Claude Code:

```bash
claude mcp add TheRealTalk -- bun run /absolute/path/to/the-real-talk/dist/server.js
```

In Figma Desktop: Plugins, Development, Import plugin from manifest, then pick `src/cursor_mcp_plugin/manifest.json`. Run the plugin in your file, paste the token once, and it connects by itself from then on.

Then ask Claude to `list_channels` and `join_channel` with your file.

## Credits

Built by Naaser, from **[Tacelo](https://www.tacelo.ch)**, custom software studio in Valais, Switzerland. We build business software for Swiss companies, and this connector is part of how we design them.

Based on [cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp) by Sonny Lazuardi and contributors, MIT License. Thank you for the foundation.

## License

MIT. See [LICENSE](LICENSE).

## Trademarks

Figma is a trademark of Figma, Inc. Claude is a trademark of Anthropic, PBC. THE REAL TALK is an independent project, not affiliated with, endorsed by or sponsored by Figma or Anthropic.
