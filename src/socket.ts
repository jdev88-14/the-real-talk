#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Secret access token: generated once, stored outside the repository (mode 600).
const TOKEN_PATH = join(homedir(), ".config", "the-real-talk", "token");

function loadOrCreateToken(): string {
  if (!existsSync(TOKEN_PATH)) {
    mkdirSync(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
    try {
      // flag "wx": never overwrites an existing token
      writeFileSync(TOKEN_PATH, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
      console.log(`Token generated once: ${TOKEN_PATH}`);
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  chmodSync(TOKEN_PATH, 0o600);
  const token = readFileSync(TOKEN_PATH, "utf8").trim();
  if (token.length < 32) throw new Error(`Invalid token in ${TOKEN_PATH}`);
  return token;
}

const TOKEN = loadOrCreateToken();

function tokenMatches(presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Accepted Origin: the Figma plugin's (sandboxed iframe, Origin "null").
// The MCP server is not a browser and sends no Origin: accepted only with
// the token. Any web page sends its real Origin (https://...) and is refused.
const FIGMA_PLUGIN_ORIGIN = "null";
function originAllowed(origin: string | null): boolean {
  return origin === null || origin === FIGMA_PLUGIN_ORIGIN;
}


// Relay log: metadata only (time, channel, command name, id, size in bytes, duration, result),
// never message content. Rotates at 5 MB, 3 files kept (log, .1, .2).
// Path: TALK_TO_FIGMA_JOURNAL (for tests) or ~/.config/the-real-talk/relay.log.
const JOURNAL_PATH =
  process.env.TALK_TO_FIGMA_JOURNAL || join(homedir(), ".config", "the-real-talk", "relay.log");
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
const JOURNAL_FILES = 3;
let journalSize = 0;
try {
  mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
  journalSize = existsSync(JOURNAL_PATH) ? statSync(JOURNAL_PATH).size : 0;
} catch {
  // the log must never stop the relay from running
}

function rotateJournal() {
  // .2 is overwritten, .1 becomes .2, the current log becomes .1
  for (let i = JOURNAL_FILES - 1; i >= 1; i--) {
    const from = i === 1 ? JOURNAL_PATH : `${JOURNAL_PATH}.${i - 1}`;
    if (existsSync(from)) renameSync(from, `${JOURNAL_PATH}.${i}`);
  }
  journalSize = 0;
}

function journal(line: string) {
  const text = `${new Date().toISOString()} ${line}\n`;
  try {
    const bytes = Buffer.byteLength(text);
    if (journalSize + bytes > JOURNAL_MAX_BYTES) rotateJournal();
    appendFileSync(JOURNAL_PATH, text, { mode: 0o600 });
    journalSize += bytes;
  } catch {
    // same: never blocking
  }
}

// In-flight commands (by id): used to compute the duration and cumulative size of the response.
const inflightCommands = new Map<string, { command: string; channel: string; t0: number; bytes: number }>();
function pruneInflight() {
  const limit = Date.now() - 15 * 60_000;
  for (const [id, c] of inflightCommands) if (c.t0 < limit) inflightCommands.delete(id);
}

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// Per-connection data (set at upgrade).
interface ClientData {
  role: "plugin" | "mcp" | null;
  channel: string | null;
  instanceId: string | null;
  fileName: string | null;
  lastSeen: number; // ms, last message received from this client
}

// A plugin silent for longer than this is considered dead: its channel can be taken over.
// Deliberately generous: timers in a background Figma tab can be throttled.
const STALE_MS = 150_000;

function pluginHolder(channelName: string, except: ServerWebSocket<ClientData>): ServerWebSocket<ClientData> | null {
  const clients = channels.get(channelName);
  if (!clients) return null;
  for (const c of clients) {
    if (c !== except && c.data?.role === "plugin" && c.readyState === WebSocket.OPEN) return c;
  }
  return null;
}

function removeFromChannels(ws: ServerWebSocket<ClientData>) {
  for (const [name, clients] of channels) {
    if (clients.delete(ws) && clients.size === 0) channels.delete(name);
  }
}

// Structured event for the MCP clients of a channel (plugin joined / left).
function notifyMcp(channelName: string, payload: object) {
  channels.get(channelName)?.forEach((c) => {
    if (c.data?.role !== "plugin" && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({ type: "system", channel: channelName, ...payload }));
    }
  });
}

function hhmmss(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

function handleConnection(ws: ServerWebSocket<ClientData>) {
  // Don't add to clients immediately - wait for channel join
  journal("connection");

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));
}

// Port: 3055 by default. TALK_TO_FIGMA_PORT is only for tests on a separate relay.
const PORT = Number(process.env.TALK_TO_FIGMA_PORT) || 3055;

const server = Bun.serve({
  port: PORT,
  // Listens on loopback only: never reachable from the network.
  hostname: "127.0.0.1",
  fetch(req: Request, server: Server) {
    // No CORS response: no web page can talk to this relay.
    const origin = req.headers.get("origin");
    if (!originAllowed(origin)) {
      journal(`refused origin=${JSON.stringify(String(origin).slice(0, 80))}`);
      return new Response("Forbidden", { status: 403 });
    }

    const token = new URL(req.url).searchParams.get("token");
    if (!tokenMatches(token)) {
      journal(`refused token origin=${JSON.stringify(String(origin ?? "none").slice(0, 80))}`);
      return new Response("Unauthorized", { status: 401 });
    }

    const data: ClientData = { role: null, channel: null, instanceId: null, fileName: null, lastSeen: Date.now() };
    if (server.upgrade(req, { data })) {
      return; // Upgraded to WebSocket
    }

    return new Response("Bad Request", { status: 400 });
  },
  websocket: {
    open: handleConnection,
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string);
        ws.data.lastSeen = Date.now();

        // Plugin heartbeat: lastSeen updated above, immediate reply, never logged.
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        // Log: metadata only, never content.
        const size = typeof message === "string" ? Buffer.byteLength(message) : (message as Buffer).byteLength;
        const m = data.message;
        if (data.type === "message" && m && typeof m === "object") {
          const channel = String(data.channel ?? "");
          if (typeof m.command === "string") {
            pruneInflight();
            inflightCommands.set(String(m.id), { command: m.command, channel, t0: Date.now(), bytes: 0 });
            journal(`command channel=${channel} command=${m.command} id=${m.id} bytes=${size}`);
          } else if (m.id !== undefined) {
            const id = String(m.id);
            const c = inflightCommands.get(id);
            if (c) c.bytes += size;
            const isChunk = m.chunk && typeof m.chunk === "object";
            if (!isChunk || m.chunk.index + 1 === m.chunk.total) {
              const outcome = m.error !== undefined ? `error${m.code ? ":" + m.code : ""}` : "ok";
              journal(
                `response channel=${channel} command=${c?.command ?? "?"} id=${id} bytes=${c ? c.bytes : size}` +
                  `${isChunk ? ` chunks=${m.chunk.total}` : ""}` +
                  ` duration_ms=${c ? Date.now() - c.t0 : "?"} result=${outcome}`
              );
              inflightCommands.delete(id);
            }
          }
        } else if (data.type !== "progress_update") {
          journal(`message type=${String(data.type)} channel=${String(data.channel ?? "")} bytes=${size}`);
        }

        // Read-only: the channels held by a connected plugin. Belongs to no channel.
        if (data.type === "list_channels") {
          const now = Date.now();
          const list: any[] = [];
          for (const [name, clients] of channels) {
            for (const c of clients) {
              if (c.data?.role === "plugin" && c.readyState === WebSocket.OPEN) {
                list.push({
                  channel: name,
                  fileName: c.data.fileName,
                  lastSeen: new Date(c.data.lastSeen).toISOString(),
                  secondsSinceLastSeen: Math.round((now - c.data.lastSeen) / 1000),
                });
              }
            }
          }
          list.sort((a, b) => a.channel.localeCompare(b.channel));
          ws.send(JSON.stringify({ type: "channels", id: data.id, channels: list }));
          return;
        }

        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const role = data.role === "plugin" ? "plugin" : "mcp";

          // Only one live plugin per channel. The same plugin launch (same instanceId)
          // reconnecting takes its place back; so does a plugin silent for too long.
          if (role === "plugin") {
            const holder = pluginHolder(channelName, ws);
            if (holder) {
              const sameInstance =
                typeof data.instanceId === "string" && holder.data.instanceId === data.instanceId;
              const stale = Date.now() - holder.data.lastSeen > STALE_MS;
              if (sameInstance || stale) {
                journal(`channel=${channelName} taken over (${sameInstance ? "same plugin" : "old silent plugin"})`);
                removeFromChannels(holder);
                holder.close(4000, "Channel taken over");
                notifyMcp(channelName, { event: "plugin_left" });
              } else {
                const fileInfo = holder.data.fileName ? ` (file "${holder.data.fileName}")` : "";
                journal(`refused channel=${channelName} already held by a connected plugin`);
                ws.send(JSON.stringify({
                  type: "error",
                  code: "channel_taken",
                  id: data.id,
                  channel: channelName,
                  message:
                    `Channel "${channelName}" is already held by a connected plugin${fileInfo}, ` +
                    `last heartbeat at ${hhmmss(holder.data.lastSeen)}. ` +
                    `Close the other plugin before starting a second one on this file.`,
                }));
                return;
              }
            }
          }

          // A client is in only one channel at a time
          removeFromChannels(ws);
          ws.data.role = role;
          ws.data.channel = channelName;
          ws.data.instanceId = typeof data.instanceId === "string" ? data.instanceId : null;
          ws.data.fileName = typeof data.fileName === "string" ? data.fileName : null;

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);

          journal(`joined channel=${channelName} role=${role} clients=${channelClients.size}`);

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          if (role === "plugin") notifyMcp(channelName, { event: "plugin_joined" });

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          // No plugin on the channel: immediate error reply to the MCP server, instead
          // of a lost message and a timeout.
          if (ws.data.role !== "plugin" && data.message?.command && !pluginHolder(channelName, ws)) {
            ws.send(JSON.stringify({
              type: "broadcast",
              channel: channelName,
              sender: "relay",
              message: {
                id: data.message.id,
                code: "plugin_absent",
                error: `Figma plugin absent from channel "${channelName}"`,
                result: {},
              },
            }));
            journal(`plugin absent channel=${channelName} command=${String(data.message.command)} id=${data.message.id}`);
            inflightCommands.delete(String(data.message.id));
            return;
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          
          if (broadcastCount === 0) {
            journal(`no recipient channel=${channelName}`);
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        journal(`processing error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`);
      }
    },
    close(ws: ServerWebSocket<ClientData>) {
      const channelName = ws.data?.channel;
      const clients = channelName ? channels.get(channelName) : undefined;
      const wasMember = !!clients && clients.has(ws);
      removeFromChannels(ws);
      journal(`disconnection role=${ws.data?.role ?? "not joined"}${channelName ? ` channel=${channelName}` : ""}`);
      if (wasMember && ws.data.role === "plugin" && channelName) {
        notifyMcp(channelName, { event: "plugin_left" });
      }
      if (wasMember && clients) {
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "system",
              message: "A user has left the channel",
              channel: channelName,
            }));
          }
        });
      }
    }
  }
});

journal(`relay started port=${server.port} log=${JOURNAL_PATH}`);
console.log(`WebSocket server running on port ${server.port} (log: ${JOURNAL_PATH})`);
