#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "fs/promises";
import { readFileSync, existsSync, statSync } from "fs";
import { homedir } from "os";
import { join, isAbsolute, resolve, dirname, extname } from "path";
import { compositeOnBackground, parseBackground, pngSize, type Rgba } from "./png.js";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}


// A partial answer is always announced at the top, with what is needed to resume.
function partialNotice(result: any): string | null {
  if (!result || typeof result !== "object") return null;
  const parts: string[] = [];
  if (result.complete === false) {
    parts.push(`PARTIAL ANSWER: the plugin time budget is reached or the volume is cut off.${result.nextCursor !== undefined && result.nextCursor !== null ? ` Resume with cursor = ${JSON.stringify(result.nextCursor)}.` : ""}`);
  }
  if (result.partial === true) parts.push(`PARTIAL ANSWER: ${result.partialReason ?? "incomplete node"}`);
  return parts.length ? parts.join(" ") : null;
}
function textWithNotice(result: any, pretty = false) {
  const notice = partialNotice(result);
  const content: Array<{ type: "text"; text: string }> = [];
  if (notice) content.push({ type: "text", text: notice });
  content.push({ type: "text", text: JSON.stringify(result, null, pretty ? 2 : undefined) });
  return { content };
}
// Shared settings for long reads: plugin time budget (2 to 100 s, 60 s by default) and resumption.
const zBudget = z.number().int().min(2000).max(100000).optional().describe("Time budget of the plugin for this call in ms (default 60000, max 100000). When it is reached the answer says it is PARTIAL and gives nextCursor.");
const zLineHeight = z.object({
  unit: z.enum(["PIXELS", "PERCENT", "AUTO"]),
  value: z.number().positive().optional().describe("Required for PIXELS and PERCENT, forbidden for AUTO"),
}).strict().superRefine((v, ctx) => {
  if (v.unit === "AUTO" && v.value !== undefined) ctx.addIssue({ code: "custom", message: "AUTO takes no value" });
  if (v.unit !== "AUTO" && v.value === undefined) ctx.addIssue({ code: "custom", message: "value is required for PIXELS and PERCENT" });
}).describe("Line height in pixels, percent or AUTO. Do not combine with lineHeightPercent.");
const zCursor = z.any().optional().describe("nextCursor of a previous PARTIAL answer, to continue where it stopped");

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
  timeoutMs: number; // timeout of this call (short or long)
  startedAt: number; // for the absolute cap of heavy calls
  acked: boolean; // the plugin signaled that it received / is processing this call
  chunks?: { total: number; parts: (string | undefined)[]; got: number }; // large answer sent in chunks
}>();

// Timeouts per tool: 30 s for small calls, 180 s for heavy calls. During a heavy call the
// plugin sends a regular "in progress" signal: each signal pushes the timeout back by
// 180 s, but never beyond the absolute cap (a plugin that answers "in progress" forever
// does not block the caller indefinitely).
const LIGHT_TIMEOUT_MS = 30000;
const HEAVY_TIMEOUT_MS = 180000;
const HEAVY_MAX_MS = 600000;
const HEAVY_COMMANDS = new Set<string>([
  "export_node_as_image",
  "scan_text_nodes",
  "get_node_info",
  "build_tree",
  "get_local_variables",
  "get_node_raw",
  "get_nodes_info",
  "bind_variable_batch",
  "find_variable_usages",
  "get_nodes_bindings",
  "audit_bindings",
  "rebind_variable_usages",
]);
function defaultTimeoutFor(command: string): number {
  return HEAVY_COMMANDS.has(command) ? HEAVY_TIMEOUT_MS : LIGHT_TIMEOUT_MS;
}

// Resets the timer of a call in progress.
function rearmTimeout(id: string, request: NonNullable<ReturnType<typeof pendingRequests.get>>, ms: number) {
  clearTimeout(request.timeout);
  request.timeout = setTimeout(() => {
    if (pendingRequests.has(id)) {
      pendingRequests.delete(id);
      logger.error(`Request ${id} timed out after ${Math.round(ms / 1000)} s without activity`);
      const err = new FigmaCallError('Request to Figma timed out', 'timeout');
      err.acked = request.acked;
      request.reject(err);
    }
  }, ms);
}

// Requests to the relay that belong to no channel (list_channels)
const pendingRelay = new Map<string, {
  resolve: (value: any) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

// Track which channel each client is in
let currentChannel: string | null = null;
// True when the current channel is (re)joined on the current connection to the relay
let channelReady = false;
// Counter that goes up at each disconnection (relay) or plugin departure: used to know whether
// an expired call went through a reconnection.
let connectionEpoch = 0;

class FigmaCallError extends Error {
  code?: string;
  acked?: boolean; // the call had been received by the plugin before the failure
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// The relay is always local: no more --server option towards a remote host.
const WS_URL = 'ws://127.0.0.1';

// Relay access token (created by the relay, outside the repository, mode 600).
const TOKEN_PATH = join(homedir(), ".config", "the-real-talk", "token");
function readRelayToken(): string {
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    throw new Error(
      `Relay token not found (${TOKEN_PATH}). Start the relay first: bun run socket`
    );
  }
}

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Selection Tool
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Read My Design Tool
server.tool(
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("read_my_design", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Info Tool
server.tool(
  "get_node_info",
  "Get detailed information about a specific node in Figma, read from the live node down to the requested depth only (if the time budget is reached the answer says PARTIAL) (text nodes carry textStyle {id,name}; frames carry clipsContent). The subtree is limited by depth (default 1: the node and its direct children; deeper levels are replaced by childrenCount). Raise depth only when needed: a whole frame can be huge.",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
    depth: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe("Levels of children to return (default 1; 0 = the node alone)"),
    timeBudgetMs: zBudget,
  },
  async ({ nodeId, depth, timeBudgetMs }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId, depth: depth ?? 1, timeBudgetMs });
      return textWithNotice(filterFigmaNode(result));
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

function rgbaToHex(color: any): string {
  // skip if color is already hex
  if (color.startsWith('#')) {
    return color;
  }

  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a === 255 ? '' : a.toString(16).padStart(2, '0')}`;
}

function filterFigmaNode(node: any) {
  // Skip VECTOR type nodes
  if (node.type === "VECTOR") {
    return null;
  }

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill: any) => {
      const processedFill = { ...fill };

      // Remove boundVariables and imageRef
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      // Process gradientStops if present
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop: any) => {
          const processedStop = { ...stop };
          // Convert color to hex if present
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          // Remove boundVariables
          delete processedStop.boundVariables;
          return processedStop;
        });
      }

      // Convert solid fill colors to hex
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke: any) => {
      const processedStroke = { ...stroke };
      // Remove boundVariables
      delete processedStroke.boundVariables;
      // Convert color to hex if present
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
      ...(node.style.lineHeight !== undefined ? { lineHeight: node.style.lineHeight } : {})
    };
  }

  if (node.extra !== undefined) filtered.extra = node.extra;
  if (node.textStyle !== undefined) filtered.textStyle = node.textStyle;
  if (node.clipsContent !== undefined) filtered.clipsContent = node.clipsContent;
  if (node.layout !== undefined) filtered.layout = node.layout;
  if (node.boundVariables !== undefined) filtered.boundVariables = node.boundVariables;

  if (node.childrenCount !== undefined) {
    filtered.childrenCount = node.childrenCount;
  }
  if (node.childrenOmitted !== undefined) filtered.childrenOmitted = node.childrenOmitted;
  if (node.partial !== undefined) filtered.partial = node.partial;
  if (node.partialReason !== undefined) filtered.partialReason = node.partialReason;
  if (node.nodesRead !== undefined) filtered.nodesRead = node.nodesRead;

  if (node.children) {
    filtered.children = node.children
      .map((child: any) => filterFigmaNode(child))
      .filter((child: any) => child !== null); // Remove null children (VECTOR nodes)
  }

  return filtered;
}

// Nodes Info Tool
server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get information about"),
    depth: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe("Levels of children to return for each node (default 1)"),
    timeBudgetMs: zBudget,
  },
  async ({ nodeIds, depth, timeBudgetMs }: any) => {
    try {
      const settled = await Promise.allSettled(
        nodeIds.map(async (nodeId: any) => {
          const result = await sendCommandToFigma('get_node_info', { nodeId, depth: depth ?? 1, timeBudgetMs });
          return { nodeId, info: result };
        })
      );
      const results: any[] = [];
      const errors: Array<{ nodeId: string; error: string }> = [];
      const partialIds: string[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const doc = filterFigmaNode(r.value.info);
          if (doc && (doc as any).partial) partialIds.push(nodeIds[i]);
          results.push(doc);
        } else {
          errors.push({ nodeId: nodeIds[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
      });
      if (errors.length === 0 && partialIds.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      }
      const banner = `PARTIAL ANSWER: ${errors.length} node(s) without an answer, ${partialIds.length} incomplete node(s) (ids: ${[...errors.map((e) => e.nodeId), ...partialIds].join(", ")}).`;
      return { content: [{ type: "text", text: banner }, { type: "text", text: JSON.stringify({ results, errors }) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);


// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode,
    layoutWrap,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    primaryAxisAlignItems,
    counterAxisAlignItems,
    layoutSizingHorizontal,
    layoutSizingVertical,
    itemSpacing
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
        layoutMode,
        layoutWrap,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        primaryAxisAlignItems,
        counterAxisAlignItems,
        layoutSizingHorizontal,
        layoutSizingVertical,
        itemSpacing
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y });
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export a node as an image. Without savePath the image comes back in the answer (PNG, JPG) or as text (SVG). With savePath (absolute path, extension matching the format, existing folder) the file is written to disk and only its path and size come back; an existing file is refused unless overwrite is true. background (PNG only) lays the export on a solid color so a white component can be seen: '#000000', '#rrggbbaa' or 'transparent' (default, nothing added); the node itself is never changed. PDF needs savePath.",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format (default PNG)"),
    scale: z.number().positive().max(4).optional().describe("Export scale (default 1, max 4; ignored for SVG and PDF)"),
    savePath: z.string().min(1).optional().describe("Absolute path of the file to write"),
    overwrite: z.boolean().optional().describe("Allow replacing an existing file at savePath"),
    background: z.string().optional().describe("PNG only: 'transparent' or a hex color laid behind the image"),
  },
  async ({ nodeId, format, scale, savePath, overwrite, background }: any) => {
    const fmt: "PNG" | "JPG" | "SVG" | "PDF" = format || "PNG";
    const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error exporting node as image: ${text}` }] });
    try {
      // Checks before any call to Figma
      let bg: Rgba | null = null;
      if (background !== undefined) {
        if (fmt !== "PNG") return fail(`background only works with PNG (format is ${fmt}); nothing was exported`);
        bg = parseBackground(background);
        if (!bg) return fail(`background must be 'transparent' or a hex color (#rgb, #rrggbb, #rrggbbaa), got "${background}"`);
      }
      if (fmt === "PDF" && !savePath) return fail("PDF can only be returned as a file: give savePath");
      let target = "";
      if (savePath !== undefined) {
        if (!isAbsolute(savePath)) return fail("savePath must be an absolute path");
        target = resolve(savePath);
        const okExt: Record<string, string[]> = { PNG: [".png"], JPG: [".jpg", ".jpeg"], SVG: [".svg"], PDF: [".pdf"] };
        if (!okExt[fmt].includes(extname(target).toLowerCase())) return fail(`savePath must end with ${okExt[fmt].join(" or ")} for ${fmt}`);
        let dirOk = false;
        try { dirOk = statSync(dirname(target)).isDirectory(); } catch { dirOk = false; }
        if (!dirOk) return fail(`the folder ${dirname(target)} does not exist`);
        if (!overwrite && existsSync(target)) return fail(`${target} already exists (overwrite:true to replace it)`);
      }

      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: fmt,
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string; byteLength?: number };
      let bytes: Buffer = Buffer.from(typedResult.imageData, "base64");
      let composited = false;
      if (bg && bg.a > 0) {
        try {
          bytes = compositeOnBackground(bytes, bg);
          composited = true;
        } catch (e) {
          return fail(`background could not be applied (${e instanceof Error ? e.message : String(e)}); nothing was saved`);
        }
      }
      const size = pngSize(bytes);
      const dims = size ? `${size.width}x${size.height}` : "";

      if (target) {
        await writeFile(target, bytes, { flag: overwrite ? "w" : "wx" });
        return {
          content: [{
            type: "text" as const,
            text: `Exported ${nodeId} as ${fmt}${dims ? " " + dims : ""}${composited ? ` on background ${background}` : ""}: ${target} (${bytes.length} bytes)`,
          }],
        };
      }
      if (fmt === "SVG") return { content: [{ type: "text" as const, text: bytes.toString("utf8") }] };
      return {
        content: [
          {
            type: "image" as const,
            data: bytes.toString("base64"),
            mimeType: typedResult.mimeType || "image/png",
          },
        ],
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
);

// Set Text Content Tool
server.tool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Styles Tool
server.tool(
  "get_styles",
  "Get all styles from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma. For LOCAL components (from get_local_components), use componentId with the id field. For published LIBRARY components, use componentKey with the publishedKey field.",
  {
    componentId: z.string().optional().describe("ID of a local component (use the id field from get_local_components result). Use this for unpublished/local components."),
    componentKey: z.string().optional().describe("Key of a published library component to instantiate (use the publishedKey field from get_local_components result). Only works for published components."),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    parentId: z.string().optional().describe("Optional parent node ID to place the instance into"),
  },
  async ({ componentId, componentKey, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentId,
        componentKey,
        x,
        y,
        parentId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);


// Set Corner Radius Tool
server.tool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      ),
  },
  async ({ nodeId, radius, corners }: any) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// create_variable_collection Tool
server.tool(
  "create_variable_collection",
  "Create a local variable collection in Figma with its modes. Returns the collection ID and the mode IDs.",
  {
    name: z.string().min(1).describe("Name of the collection"),
    modes: z.array(z.string().min(1)).min(1).describe("Names of the modes, in order (the first one renames the default mode)"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("create_variable_collection", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Created collection "${result.name}" (${result.id}) with modes: ${result.modes.map((m: any) => m.name + " = " + m.id).join(", ")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in create_variable_collection: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// create_variable Tool
server.tool(
  "create_variable",
  "Create a variable (COLOR, FLOAT, STRING or BOOLEAN) in an existing collection, with a value for each mode. Colors are #RRGGBB(AA) or {r,g,b,a} in 0-1. Returns the variable ID.",
  {
    collectionId: z.string().describe("ID of the collection"),
    name: z.string().min(1).describe("Variable name (use / for groups)"),
    type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).describe("COLOR = color, FLOAT = number, STRING = text, BOOLEAN = boolean"),
    values: z.record(z.string(), z.union([z.union([z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/), z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional() })]), z.number(), z.string(), z.boolean()])).describe("Value per mode, keyed by mode name or mode ID"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("create_variable", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Created ${result.type} variable "${result.name}" (${result.id}) in collection ${result.collectionId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in create_variable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// set_variable_value Tool
server.tool(
  "set_variable_value",
  "Set the value of an existing variable for one mode. Colors are #RRGGBB(AA) or {r,g,b,a} in 0-1.",
  {
    variableId: z.string().describe("ID of the variable"),
    mode: z.string().describe("Mode name or mode ID"),
    value: z.union([z.union([z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/), z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional() })]), z.number(), z.string(), z.boolean()]).describe("New value, matching the variable type"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_variable_value", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Set "${result.name}" (${result.id}) to ${JSON.stringify(result.value)} for mode ${result.modeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in set_variable_value: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// set_variable_scopes Tool
server.tool(
  "set_variable_scopes",
  "Limit where a variable can be used (scopes such as ALL_SCOPES, GAP, CORNER_RADIUS, WIDTH_HEIGHT, ALL_FILLS, FRAME_FILL, SHAPE_FILL, TEXT_FILL, STROKE_COLOR, TEXT_CONTENT, OPACITY, FONT_SIZE...). Replaces the existing scopes.",
  {
    variableId: z.string().describe("ID of the variable"),
    scopes: z
      .array(
        z.enum([
          "ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP",
          "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR",
          "EFFECT_COLOR", "STROKE_FLOAT", "EFFECT_FLOAT", "OPACITY", "FONT_FAMILY",
          "FONT_STYLE", "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING",
          "PARAGRAPH_SPACING", "PARAGRAPH_INDENT",
        ])
      )
      .min(1)
      .describe("Allowed usages"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_variable_scopes", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Scopes of "${result.name}" (${result.id}): ${result.scopes.join(", ")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in set_variable_scopes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// set_variable_description Tool
server.tool(
  "set_variable_description",
  "Set the description of an existing variable (for example the role of a color). Replaces the existing description.",
  {
    variableId: z.string().describe("ID of the variable"),
    description: z.string().describe("New description text"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_variable_description", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Description of "${result.name}" (${result.id}) set: ${result.description}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in set_variable_description: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// bind_variable Tool
server.tool(
  "bind_variable",
  "Bind a variable to a node property: FILL, STROKE, CORNER_RADIUS, PADDING (all four sides) or PADDING_TOP / PADDING_BOTTOM / PADDING_LEFT / PADDING_RIGHT (one side), CORNER_TOP_LEFT / CORNER_TOP_RIGHT / CORNER_BOTTOM_LEFT / CORNER_BOTTOM_RIGHT (one corner), ITEM_SPACING, WIDTH or HEIGHT. FILL and STROKE need a COLOR variable, the others a FLOAT variable.",
  {
    nodeId: z.string().describe("ID of the node"),
    property: z
      .enum(["FILL", "STROKE", "CORNER_RADIUS", "CORNER_TOP_LEFT", "CORNER_TOP_RIGHT", "CORNER_BOTTOM_LEFT", "CORNER_BOTTOM_RIGHT", "PADDING", "PADDING_TOP", "PADDING_BOTTOM", "PADDING_LEFT", "PADDING_RIGHT", "ITEM_SPACING", "WIDTH", "HEIGHT"])
      .describe("Property to bind (fill, stroke, corner radius, padding, spacing, width, height)"),
    variableId: z.string().describe("ID of the variable"),
    index: z.number().int().min(0).optional().describe("For FILL and STROKE: index of the paint (default 0)"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("bind_variable", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Bound ${result.property} of "${result.name}" to variable "${result.variableName}" (${result.variableId})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in bind_variable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// rename_variable_collection Tool
server.tool(
  "rename_variable_collection",
  "Rename a variable collection (designated by ID or exact name). Variables and their values are not touched.",
  { collection: z.string().min(1).describe("ID or exact name of the collection"), name: z.string().min(1).max(200).describe("New name") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("rename_variable_collection", args as any);
      return { content: [{ type: "text", text: `Collection ${result.id} renamed from "${result.before}" to "${result.name}" (${result.variables} variables untouched)` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in rename_variable_collection: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// convert_to_component Tool
server.tool(
  "convert_to_component",
  "Turn an existing node (usually a frame) into a COMPONENT. The component gets a new ID.",
  { nodeId: z.string().describe("ID of the node") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("convert_to_component", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in convert_to_component: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// combine_as_variants Tool
server.tool(
  "combine_as_variants",
  "Combine COMPONENT nodes into a component set (variants). Name each component beforehand like \"Style=Geste, Taille=Normale\" to define the variant properties. The set is created in parentId, or in the parent of the first component.",
  { nodeIds: z.array(z.string()).min(1).max(200).describe("IDs of the components"), parentId: z.string().optional().describe("Parent of the new set"), name: z.string().min(1).max(200).optional().describe("Name of the set") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("combine_as_variants", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in combine_as_variants: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// add_component_property Tool
server.tool(
  "add_component_property",
  "Add a TEXT, BOOLEAN or INSTANCE_SWAP (defaultValue = ID of a local component) component property to a component set (or a component). Returns the propertyId to reference with set_component_property_reference.",
  { nodeId: z.string().describe("ID of the component set"), name: z.string().min(1).max(100).describe("Property name"), type: z.enum(["TEXT", "BOOLEAN", "INSTANCE_SWAP"]), defaultValue: z.union([z.string(), z.boolean()]).describe("Default value (string for TEXT, boolean for BOOLEAN)") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("add_component_property", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in add_component_property: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_component_property_reference Tool
server.tool(
  "set_component_property_reference",
  "Link a text node (characters) or any node (visible) inside a component to a component property, by propertyId.",
  { nodeId: z.string().describe("ID of the node inside the component"), field: z.enum(["characters", "visible", "mainComponent"]), propertyId: z.string().min(1).describe("propertyId returned by add_component_property") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_component_property_reference", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in set_component_property_reference: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_stroke_options Tool
server.tool(
  "set_stroke_options",
  "Set the stroke alignment (INSIDE, OUTSIDE, CENTER) and/or the stroke weight of a node.",
  { nodeId: z.string().describe("ID of the node"), align: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(), weight: z.number().min(0).optional() },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_stroke_options", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in set_stroke_options: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_corner_radii Tool
server.tool(
  "set_corner_radii",
  "Set each corner radius separately (values in px; omitted corners are left as they are). To link a corner to a variable use bind_variable CORNER_TOP_LEFT etc.",
  { nodeId: z.string().describe("ID of the node"), topLeft: z.number().min(0).optional(), topRight: z.number().min(0).optional(), bottomRight: z.number().min(0).optional(), bottomLeft: z.number().min(0).optional() },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_corner_radii", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in set_corner_radii: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_layout_positioning Tool
server.tool(
  "set_layout_positioning",
  "Set a child of an auto-layout frame to ABSOLUTE (outside the flow) or AUTO, with optional x, y and constraints.",
  { nodeId: z.string().describe("ID of the child"), positioning: z.enum(["AUTO", "ABSOLUTE"]), x: z.number().optional(), y: z.number().optional(), horizontal: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(), vertical: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional() },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_layout_positioning", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in set_layout_positioning: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// create_text_style Tool
server.tool(
  "create_text_style",
  "Create a local text style (family, style, size, line height as lineHeight {unit PIXELS|PERCENT|AUTO, value} or lineHeightPercent, and letter spacing %), with fontFamily, fontWeight and fontSize optionally bound to variables (IDs). Refuses a name that already exists.",
  { name: z.string().min(1).max(200), fontFamily: z.string().min(1), fontStyle: z.string().min(1).describe("Figma font style, e.g. Medium"), fontSize: z.number().positive(), lineHeightPercent: z.number().positive().optional(), lineHeight: zLineHeight.optional(), letterSpacingPercent: z.number().optional(), fontFamilyVariable: z.string().optional().describe("STRING variable ID"), fontWeightVariable: z.string().optional().describe("FLOAT variable ID"), fontSizeVariable: z.string().optional().describe("FLOAT variable ID") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("create_text_style", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in create_text_style: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// create_page Tool
server.tool(
  "create_page",
  "Create a new page in the document (refuses an existing name). Returns its ID, usable as parentId in build_tree, create_component_instance, set_parent. The active page is changed only if activate is true.",
  { name: z.string().min(1).max(200), activate: z.boolean().optional() },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("create_page", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in create_page: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_instance_properties Tool
server.tool(
  "set_instance_properties",
  "Set component properties of an instance: a text property by its short name (e.g. Libell\u00e9) or variant properties (e.g. Style, \u00c9tat) with their value.",
  { nodeId: z.string().describe("ID of the instance"), properties: z.record(z.union([z.string(), z.boolean()])).describe("{property name: value}") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_instance_properties", args as any);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in set_instance_properties: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);


// ---------------------------------------------------------------------------
// Additional tools for full inspection (the plugin executes; nothing is logged).
// ---------------------------------------------------------------------------
function plainTool(name: string, description: string, shape: any) {
  server.tool(name, description, shape, async (args: any) => {
    try {
      const result: any = await sendCommandToFigma(name as any, args as any);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error in ${name}: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}
const zId = z.string().min(1);
const zColorA = z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional() });
const zPaint = z.object({
  type: z.string().describe("SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR or GRADIENT_DIAMOND"),
  color: zColorA.optional().describe("SOLID: raw color (prefer variable)"),
  variable: z.string().optional().describe("SOLID: COLOR variable ID to bind"),
  opacity: z.number().min(0).max(1).optional(), visible: z.boolean().optional(), blendMode: z.string().optional(),
  stops: z.array(z.object({ position: z.number().min(0).max(1), color: zColorA })).optional().describe("Gradients: at least 2 stops"),
  angle: z.number().optional().describe("GRADIENT_LINEAR: angle in degrees"),
});
const zEffect = z.object({
  type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
  color: zColorA.optional(), colorVariable: z.string().optional().describe("COLOR variable ID bound to the shadow color"),
  offset: z.object({ x: z.number(), y: z.number() }).optional(), radius: z.number().min(0).optional(), spread: z.number().optional(),
  visible: z.boolean().optional(), blendMode: z.string().optional(),
  radiusVariable: z.string().optional(), spreadVariable: z.string().optional(), offsetXVariable: z.string().optional(), offsetYVariable: z.string().optional(),
});
const BIND_FIELDS = ["height", "width", "characters", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "visible", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "minHeight", "maxHeight", "minWidth", "maxWidth", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "opacity", "counterAxisSpacing", "fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"] as const;

plainTool("set_node_properties",
  "Set many node properties at once, validated against a whitelist. Numbers: opacity, rotation, x, y, width, height (resize; makes the size FIXED), itemSpacing, padding*, strokeWeight, stroke{Top,Right,Bottom,Left}Weight (per-side inner borders), cornerSmoothing, topLeftRadius..bottomRightRadius, cornerRadius, layoutGrow, paragraphSpacing, paragraphIndent, maxLines. Numbers or null: minWidth, maxWidth, minHeight, maxHeight, counterAxisSpacing. Booleans: visible, locked, clipsContent, isMask, itemReverseZIndex, strokesIncludedInLayout. Strings: name, description (components). Enums: blendMode, layoutMode, layoutWrap (WRAP = flex-wrap), primaryAxisSizingMode, counterAxisSizingMode, primaryAxisAlignItems, counterAxisAlignItems, counterAxisAlignContent, layoutAlign, layoutPositioning, layoutSizingHorizontal, layoutSizingVertical, strokeAlign, strokeJoin, strokeCap, textAutoResize, textAlignHorizontal, textAlignVertical, textCase, textDecoration, textTruncation, leadingTrim. Objects: constraints {horizontal, vertical}; dashPattern [numbers].",
  { nodeId: zId, properties: z.record(z.any()).describe("{property: value}") });
plainTool("bind_variable_field",
  "Bind (or unbind with variableId null) a variable to any bindable node field: " + BIND_FIELDS.join(", ") + ". Use a FLOAT variable for numeric fields, BOOLEAN for visible, STRING for characters, fontFamily and fontStyle.",
  { nodeId: zId, field: z.enum(BIND_FIELDS), variableId: z.string().nullable() });
plainTool("set_paints",
  "Replace the fills or strokes of a node with solid paints (optionally bound to COLOR variables) and/or gradients. Images: use set_image_fill.",
  { nodeId: zId, target: z.enum(["fills", "strokes"]), paints: z.array(zPaint).max(8) });
plainTool("set_effects",
  "Replace the effects of a node: drop shadow, inner shadow (color optionally bound to a variable), layer blur, background blur.",
  { nodeId: zId, effects: z.array(zEffect).max(8) });
plainTool("create_effect_style", "Create a local effect style from effects (same shape as set_effects). Refuses an existing name.",
  { name: z.string().min(1).max(200), effects: z.array(zEffect).max(8) });
plainTool("create_paint_style", "Create a local paint style (fill or stroke style) from paints (same shape as set_paints). Refuses an existing name.",
  { name: z.string().min(1).max(200), paints: z.array(zPaint).max(8) });
plainTool("apply_style", "Apply a local style (by ID or exact name) to a node: TEXT, EFFECT, FILL, STROKE or GRID.",
  { nodeId: zId, kind: z.enum(["TEXT", "EFFECT", "FILL", "STROKE", "GRID"]), style: zId });
plainTool("delete_style", "Delete a local style by ID.", { styleId: zId });
plainTool("edit_text_style", "Edit an existing text style (by ID or name): font, size, line height (lineHeight {unit PIXELS|PERCENT|AUTO, value} or lineHeightPercent), letter spacing %, name, and variable bindings (fontFamily, fontWeight, fontSize, lineHeight, letterSpacing).",
  { style: zId, name: z.string().optional(), fontFamily: z.string().optional(), fontStyle: z.string().optional(), fontSize: z.number().positive().optional(), lineHeightPercent: z.number().positive().optional(), lineHeight: zLineHeight.optional(), letterSpacingPercent: z.number().optional(), fontFamilyVariable: z.string().optional(), fontWeightVariable: z.string().optional(), fontSizeVariable: z.string().optional(), lineHeightVariable: z.string().optional(), letterSpacingVariable: z.string().optional() });
plainTool("set_layout_grids", "Set the layout grids of a frame: GRID (square), COLUMNS or ROWS (count, gutterSize, offset, alignment, sectionSize).",
  { nodeId: zId, grids: z.array(z.object({ pattern: z.enum(["GRID", "COLUMNS", "ROWS"]), count: z.number().optional(), gutterSize: z.number().optional(), offset: z.number().optional(), alignment: z.enum(["MIN", "MAX", "CENTER", "STRETCH"]).optional(), sectionSize: z.number().optional(), visible: z.boolean().optional(), color: zColorA.optional() })).max(8) });

plainTool("add_variable_mode", "Add a mode to a variable collection (ID or name). Returns the new modeId.", { collection: zId, name: zId });
plainTool("rename_variable_mode", "Rename a mode (ID or name) of a collection.", { collection: zId, mode: zId, name: zId });
plainTool("remove_variable_mode", "Remove a mode (ID or name) from a collection.", { collection: zId, mode: zId });
plainTool("rename_variable", "Rename a variable by ID.", { variableId: zId, name: zId });
plainTool("delete_variable", "Delete a variable by ID.", { variableId: zId });
plainTool("delete_variable_collection", "Delete a variable collection (ID or name) and all its variables.", { collection: zId });
plainTool("set_variable_alias", "Make a variable, for one mode, an alias of another variable (same type).", { variableId: zId, mode: zId, aliasVariableId: zId });
plainTool("set_variable_code_syntax", "Set the code syntax of a variable for WEB, ANDROID or iOS.", { variableId: zId, platform: z.enum(["WEB", "ANDROID", "iOS"]), value: z.string() });
plainTool("set_variable_publishing", "Hide or show a variable when the library is published.", { variableId: zId, hidden: z.boolean() });

plainTool("edit_component_property", "Rename a component property and/or change its default value. Returns the (possibly new) propertyId.", { nodeId: zId, propertyId: zId, name: z.string().optional(), defaultValue: z.union([z.string(), z.boolean()]).optional() });
plainTool("delete_component_property", "Delete a component property from a component set or component.", { nodeId: zId, propertyId: zId });
plainTool("create_component", "Create an empty component in a parent (default: current page).", { parentId: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() });
plainTool("swap_instance", "Swap an instance to another local component (for a nested INSTANCE_SWAP).", { nodeId: zId, componentId: zId });
plainTool("detach_instance", "Detach an instance into a plain frame.", { nodeId: zId });
plainTool("reset_instance_overrides", "Reset all overrides of an instance.", { nodeId: zId });

plainTool("list_pages", "List the pages of the file (id, name, isCurrent). Read-only: does not load page contents and does not change the current page.", {});
plainTool("set_current_page", "Make a page the active page (by ID).", { pageId: zId });
plainTool("rename_page", "Rename a page (by ID).", { pageId: zId, name: zId });
plainTool("delete_page", "Delete a page (by ID). Refuses the active page and the only page.", { pageId: zId });
plainTool("set_reactions",
  "Replace the prototype reactions of a node. Each reaction: { trigger: {type: ON_CLICK|ON_HOVER|ON_PRESS|ON_DRAG|AFTER_TIMEOUT|MOUSE_ENTER|MOUSE_LEAVE|MOUSE_UP|MOUSE_DOWN, timeout?, delay?}, actions: [{type: NODE|BACK|CLOSE|URL, destinationId?, navigation?: NAVIGATE|CHANGE_TO|OVERLAY|SWAP|SCROLL_TO, transition?: {type: SMART_ANIMATE|DISSOLVE|MOVE_IN|PUSH|SLIDE_IN, duration (seconds), easing: {type: EASE_IN|EASE_OUT|EASE_IN_AND_OUT|LINEAR|...}}, url?}] }. For variant hover, put ON_HOVER with CHANGE_TO on a variant component and point to the hover variant.",
  { nodeId: zId, reactions: z.array(z.record(z.any())).max(20) });
plainTool("set_flow_start", "Mark a frame as a prototype flow starting point on the current page.", { nodeId: zId, name: z.string().optional() });
plainTool("list_available_fonts", "List installed font families and styles, optionally filtered by a name substring.", { query: z.string().optional(), limit: z.number().int().min(1).max(200).optional() });

plainTool("create_ellipse", "Create an ellipse (a circle if width = height).", { parentId: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() });
plainTool("create_from_svg", "Create vector nodes from an SVG string (icons: chevron, check, burger...). flatten true merges them into one vector.", { svg: z.string().min(1).max(200000), parentId: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), flatten: z.boolean().optional() });
plainTool("boolean_operation", "Combine shapes: UNION, SUBTRACT, INTERSECT or EXCLUDE (2 nodes or more).", { nodeIds: z.array(zId).min(2).max(200), operation: z.enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]), parentId: z.string().optional(), name: z.string().optional() });
plainTool("flatten_nodes", "Flatten nodes into a single vector.", { nodeIds: z.array(zId).min(1).max(200), name: z.string().optional() });
plainTool("group_nodes", "Group nodes.", { nodeIds: z.array(zId).min(1).max(200), parentId: z.string().optional(), name: z.string().optional(), index: z.number().int().min(0).optional() });
plainTool("ungroup_node", "Ungroup a group (or frame): its children move to the parent.", { nodeId: zId });
plainTool("set_text_range_style",
  "Style part of a text (start to end, default the whole text): text style, font family/style, size, decoration, case, fill bound to a COLOR variable, hyperlink URL.",
  { nodeId: zId, start: z.number().int().min(0).optional(), end: z.number().int().min(1).optional(), textStyle: z.string().optional(), fontFamily: z.string().optional(), fontStyle: z.string().optional(), fontSize: z.number().positive().optional(), textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(), textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(), fillVariable: z.string().optional(), hyperlink: z.string().optional() });
plainTool("get_node_raw",
  "Read the raw Figma plugin-API properties of a node (fills with bound variables, effects, layout, min/max, constraints, grids, style IDs, characters, component properties, reactions...). depth = levels of children (default 0). keys = restrict to some properties.",
  { nodeId: zId, depth: z.number().int().min(0).max(10).optional(), keys: z.array(z.string()).max(60).optional() });

// get_clips_content Tool
server.tool(
  "get_clips_content",
  "Read clipsContent (clip content) of a frame.",
  { nodeId: z.string().describe("ID of the frame") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("get_clips_content", args as any);
      return { content: [{ type: "text", text: `"${result.name}" (${result.id}) clipsContent=${result.clipsContent}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in get_clips_content: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_clips_content Tool
server.tool(
  "set_clips_content",
  "Set clipsContent (clip content) of a frame.",
  { nodeId: z.string().describe("ID of the frame"), clipsContent: z.boolean().describe("true to clip") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_clips_content", args as any);
      return { content: [{ type: "text", text: `"${result.name}" (${result.id}) clipsContent=${result.clipsContent}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in set_clips_content: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// clear_fills Tool
server.tool(
  "clear_fills",
  "Remove all fills of a node.",
  { nodeId: z.string().describe("ID of the node") },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("clear_fills", args as any);
      return { content: [{ type: "text", text: `Removed ${result.removed} fill(s) of "${result.name}" (${result.id}), now ${result.fillsCount}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error in clear_fills: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// set_text_style Tool
server.tool(
  "set_text_style",
  "Apply an existing local text style to a text node. The style is designated by its ID or its name.",
  {
    nodeId: z.string().describe("ID of the text node"),
    style: z.string().min(1).describe("Text style ID (S:...) or exact style name"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_text_style", args as any);
      return {
        content: [
          {
            type: "text",
            text: `Applied text style "${result.styleName}" (${result.styleId}) to "${result.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in set_text_style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// get_local_variables Tool
server.tool(
  "get_local_variables",
  "Read-only: list local variable collections with their modes, and every variable with its type, values per mode and scopes. Read in one pass with a time budget: if it is reached the answer says PARTIAL and gives nextCursor (pass it back as cursor).",
  {
    cursor: zCursor,
    timeBudgetMs: zBudget,
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("get_local_variables", args as any);
      return textWithNotice(result, true);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in get_local_variables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// set_explicit_variable_mode Tool
server.tool(
  "set_explicit_variable_mode",
  "Pin the mode of a variable collection on a node and all its children (for example a column in a given mode). Node, collection and mode can be given by ID or by name. Set clear to true to remove the pinned mode.",
  {
    node: z.string().describe("ID or name of the node (a name must be unique on the current page)"),
    collection: z.string().describe("ID or name of the variable collection"),
    mode: z.string().optional().describe("ID or name of the mode (required unless clear is true)"),
    clear: z.boolean().optional().describe("true to remove the pinned mode of this collection on the node"),
  },
  async (args: any) => {
    try {
      const result: any = await sendCommandToFigma("set_explicit_variable_mode", args as any);
      return {
        content: [
          {
            type: "text",
            text: result.cleared
              ? `Removed the pinned mode of collection "${result.collectionName}" on "${result.name}" (${result.id})`
              : `Pinned mode "${result.modeName}" of collection "${result.collectionName}" on "${result.name}" (${result.id}) and its children`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in set_explicit_variable_mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// build_tree: strict, recursive schema of the description (data only, no code).
// The full schema is checked here; the tool list announces a free-form object so that it stays
// readable by all MCP clients (recursive references do not pass well).
const treeColor = z.object({
  r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional(),
}).strict();
const treeNodeBase = z.object({
  type: z.enum(["FRAME", "RECTANGLE", "TEXT", "ELLIPSE", "INSTANCE"]),
  name: z.string().min(1).max(200).optional(),
  x: z.number().optional(), y: z.number().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(),
  fill: treeColor.optional(), stroke: treeColor.optional(), strokeWeight: z.number().min(0).optional(),
  cornerRadius: z.number().min(0).optional(),
  strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
  cornerRadii: z.object({ topLeft: z.number().min(0).optional(), topRight: z.number().min(0).optional(), bottomRight: z.number().min(0).optional(), bottomLeft: z.number().min(0).optional() }).strict().optional(),
  layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
  constraintH: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
  constraintV: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
  noFill: z.boolean().optional(),
  asComponent: z.boolean().optional(),
  props: z.record(z.any()).optional(),
  fieldBindings: z.array(z.object({ field: z.string().min(1), variable: z.string().min(1) }).strict()).max(30).optional(),
  effects: z.array(z.record(z.any())).max(8).optional(),
  componentId: z.string().min(1).optional(),
  properties: z.record(z.union([z.string(), z.boolean()])).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  bindings: z.array(z.object({
    property: z.enum(["FILL", "STROKE", "CORNER_RADIUS", "CORNER_TOP_LEFT", "CORNER_TOP_RIGHT", "CORNER_BOTTOM_LEFT", "CORNER_BOTTOM_RIGHT", "PADDING", "PADDING_TOP", "PADDING_BOTTOM", "PADDING_LEFT", "PADDING_RIGHT", "ITEM_SPACING", "WIDTH", "HEIGHT"]),
    variable: z.string().min(1),
  }).strict()).max(20).optional(),
  explicitModes: z.array(z.object({ collection: z.string().min(1), mode: z.string().min(1) }).strict()).max(10).optional(),
  // cadres
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
  layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
  paddingTop: z.number().min(0).optional(), paddingRight: z.number().min(0).optional(),
  paddingBottom: z.number().min(0).optional(), paddingLeft: z.number().min(0).optional(),
  itemSpacing: z.number().min(0).optional(),
  primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
  // textes
  text: z.string().max(5000).optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.union([z.literal(100), z.literal(200), z.literal(300), z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800), z.literal(900)]).optional(),
  textStyle: z.string().min(1).optional(),
}).strict();
type TreeNodeInput = z.infer<typeof treeNodeBase> & { children?: TreeNodeInput[] };
const treeNode: z.ZodType<TreeNodeInput> = z.lazy(() =>
  treeNodeBase.extend({ children: z.array(treeNode).optional() }).strict()
);

// build_tree Tool
server.tool(
  "build_tree",
  `Build a whole tree of nodes (frames, rectangles, texts) in ONE call, under a given parent. All or nothing: if any step fails, everything created by this call is deleted. Returns the created IDs. Data only, no code.
tree is one node object: { type: "FRAME"|"RECTANGLE"|"TEXT", name?, x?, y?, width?, height?, fill?{r,g,b,a? in 0..1}, stroke?, strokeWeight?, cornerRadius?, layoutSizingHorizontal?/layoutSizingVertical? ("FIXED"|"HUG"|"FILL"), bindings?[{property:"FILL"|"STROKE"|"CORNER_RADIUS"|"PADDING"|"PADDING_TOP"|"PADDING_BOTTOM"|"PADDING_LEFT"|"PADDING_RIGHT"|"ITEM_SPACING"|"WIDTH"|"HEIGHT", variable:<variable ID>}], explicitModes?[{collection, mode}], strokeAlign? ("INSIDE"|"OUTSIDE"|"CENTER"), cornerRadii? {topLeft,topRight,bottomRight,bottomLeft}, noFill? (remove all fills), layoutPositioning? ("ABSOLUTE" inside an auto-layout parent, with x, y, width, height, constraintH/constraintV "MIN"|"MAX"|"CENTER"|"STRETCH"|"SCALE"); binding properties also CORNER_TOP_LEFT, CORNER_TOP_RIGHT, CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT }.
Also on any node: props {same keys as set_node_properties}, fieldBindings [{field, variable}] (same fields as bind_variable_field), effects [same shape as set_effects]. Types ELLIPSE (like RECTANGLE) and INSTANCE (componentId of a local COMPONENT, properties {name: value} as in set_instance_properties).
FRAME also takes asComponent (true: turn the built frame into a COMPONENT once its children exist; the returned id is the component's).
FRAME also takes layoutMode ("NONE"|"HORIZONTAL"|"VERTICAL"), layoutWrap, paddingTop/Right/Bottom/Left, itemSpacing, primaryAxisAlignItems, counterAxisAlignItems and children[] (same node shape, max depth 12, max 500 nodes in total).
TEXT takes text (required), fontSize, fontWeight (100..900), textStyle (text style name or ID). Colors set on an element should be bound to variables with bindings rather than left as raw RGB.
A property you do not give keeps Figma's own default (no invented padding, spacing, alignment, font size or color). A frame with auto layout and an explicit width or height keeps that size fixed.`,
  {
    parentId: z.string().optional().describe("ID of the parent node (frame or section). Defaults to the current page."),
    tree: z.record(z.any()).describe("The root node of the tree to build (see the tool description for the shape)"),
  },
  async ({ parentId, tree }: any) => {
    const parsed = treeNode.safeParse(tree);
    if (!parsed.success) {
      const issues = (parsed as any).error.issues
        .slice(0, 8)
        .map((i: any) => `tree.${i.path.join(".")} : ${i.message}`)
        .join("\n");
      return { content: [{ type: "text", text: `build_tree: description rejected, nothing was created.\n${issues}` }] };
    }
    try {
      const result: any = await sendCommandToFigma("build_tree", { parentId, tree: parsed.data } as any);
      return {
        content: [
          {
            type: "text",
            text: `build_tree: ${result.created} nodes created, root ${result.rootId}.\n${JSON.stringify(result.tree)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error in build_tree : ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);


// ---------------------------------------------------------------------------
// Measures batch: bulk binding, usages of a variable, bulk read of bindings.
// ---------------------------------------------------------------------------
function budgetTool(name: string, description: string, shape: any) {
  server.tool(name, description, shape, async (args: any) => {
    try {
      const result: any = await sendCommandToFigma(name as any, args as any);
      return textWithNotice(result);
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error in ${name}: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}

budgetTool("bind_variable_batch",
  "Bind several fields to variables on ALL nodes selected under rootId, in one call. select (at least one criterion, all must match): type (FRAME, TEXT, COMPONENT, INSTANCE...), nameEquals, nameMatches (regular expression), variantProperties ({\"Size\":\"Compact\"}, on COMPONENT or INSTANCE). bindings: [{field, variableId}] with the fields of bind_variable_field plus fills and strokes (binds the color of every SOLID paint; COLOR variable); variableId null unbinds. Instance children are skipped unless includeInstanceChildren. where (optional) keeps a binding only where a field meets a condition: {field?, rawValue?, unbound?, boundTo?}. field is the field read (default: the binding's own field, so {unbound:true, rawValue:12} on a paddingTop binding binds only raw paddingTop values equal to 12); rawValue is a number, string or boolean (a #rrggbb text for fills and strokes); unbound:true needs no variable on that field; boundTo:<variableId> needs that variable already bound. For fills and strokes the condition is per paint. matched counts the nodes selected, eligible those where at least one binding passes where. dryRun:true lists the eligible nodes (matchedIds, max 500) and fieldsWouldBind, and writes nothing: use it first. Returns matched, nodesBound, nodesFailed, fieldsBound and failures [{nodeId, name, field, error}] (200 at most, failuresTotal gives the real count). Time budget: if reached, the answer is PARTIAL with nextCursor; counts are per call, add them up.",
  {
    rootId: zId.describe("Node under which the nodes are selected (the root itself is a candidate)"),
    select: z.object({
      type: z.string().min(1).optional(),
      nameEquals: z.string().optional(),
      nameMatches: z.string().min(1).max(200).optional(),
      variantProperties: z.record(z.string()).optional(),
    }).strict(),
    bindings: z.array(z.object({ field: z.enum([...BIND_FIELDS, "fills", "strokes"] as [string, ...string[]]), variableId: z.string().nullable() }).strict()).min(1).max(12),
    where: z.object({
      field: z.enum([...BIND_FIELDS, "fills", "strokes"] as [string, ...string[]]).optional(),
      rawValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
      unbound: z.boolean().optional(),
      boundTo: z.string().min(1).optional(),
    }).strict().refine((w) => w.rawValue !== undefined || w.unbound !== undefined || w.boundTo !== undefined, { message: "where needs at least one of rawValue, unbound, boundTo" }).refine((w) => !(w.unbound === true && w.boundTo !== undefined), { message: "unbound:true and boundTo cannot be combined" }).optional(),
    dryRun: z.boolean().optional(),
    includeInstanceChildren: z.boolean().optional(),
    maxNodes: z.number().int().min(1).max(20000).optional().describe("Matched nodes per call (default 5000)"),
    cursor: zCursor,
    timeBudgetMs: zBudget,
  });

budgetTool("find_variable_usages",
  "Find where a variable is bound: [{nodeId, field}] on all pages, or under rootId. Fields look like paddingTop, fills[0], strokes[0], effects[0].color. The first call also lists variableAliases (variables whose value aliases it) and styles (local styles bound to it). Instance children are skipped (their bindings belong to the main component) unless includeInstanceChildren. All pages are loaded as the search goes: PARTIAL with nextCursor when the time budget or maxResults is reached.",
  {
    variableId: zId,
    rootId: z.string().min(1).optional().describe("Limit the search to this node (default: every page)"),
    includeInstanceChildren: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(10000).optional().describe("Usages per call (default 2000)"),
    cursor: zCursor,
    timeBudgetMs: zBudget,
  });

budgetTool("get_nodes_bindings",
  "Read, for every node under rootId down to depth (0 = the root alone), its values, its variable bindings with the variable name ({id, name}), its fills and its strokes (color, bound variable). Instance children are excluded (instanceChildrenExcluded and childrenCount tell). fields limits values and bindings to those fields (default: all of: " + BIND_FIELDS.join(", ") + "). Large volumes come in pieces: maxNodes per call (default 500); PARTIAL with nextCursor when the budget or maxNodes is reached.",
  {
    rootId: zId,
    depth: z.number().int().min(0).max(50),
    fields: z.array(z.enum([...BIND_FIELDS, "cornerRadius", "layoutMode", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutSizingHorizontal", "layoutSizingVertical", "layoutWrap", "strokeAlign", "textAutoResize", "fontName"] as [string, ...string[]])).max(40).default([]),
    maxNodes: z.number().int().min(1).max(2000).optional(),
    cursor: zCursor,
    timeBudgetMs: zBudget,
  });

budgetTool("audit_bindings",
  "Audit the bindings under rootId against the measure rules, computed inside the plugin. DEFAULT RULES (all five apply when rules is omitted): (1) unbound: a spacing, padding, fixed width or height, radius, stroke weight, SOLID fill/stroke color or text without style that has no variable bound (itemSpacing counts only with 2 or more visible in-flow children and not with SPACE_BETWEEN; padding 0 and radius 0 are not flagged here; width and height count only when the sizing is FIXED); (2) primitive: a value bound to a variable of the primitive collection instead of a role variable; (3) not_multiple_of_4: itemSpacing, counterAxisSpacing, padding, fixed width and height, or a line height in px that is not a multiple of 4 (strokes and radii excluded; a width or height from 1 to 3 is treated as a hairline and skipped); (4) zero_padding: an auto layout frame, component or instance with children and a visible fill or stroke whose padding is 0 (one finding per side); (5) height_not_in_set: a height outside the default set 24, 32, 36, 44, 56, 64 (tolerance 0.0005; text, vectors, groups and similar nodes are skipped). Only the findings come back, as rows [nodeId, name, field, value, variable, rule] (see columns), after a totals-per-rule header. rules (default all five): unbound (spacing, padding, fixed width and height, radius, stroke weight, SOLID fill/stroke color or text without style, with no variable: itemSpacing counts when 2 or more children, padding 0 and radius 0 are not flagged here), primitive (bound to a variable of the collection primitiveCollection, default \"Primitives\", instead of a role), not_multiple_of_4 (itemSpacing, counterAxisSpacing, padding, fixed width and height, line height in px; strokes and radii excluded), zero_padding (auto layout frame with children and a visible fill or stroke whose padding is 0; one finding per side), height_not_in_set (height outside heightSet, default 24, 32, 36, 44, 56, 64; heightScope \"components\" (default) checks COMPONENT nodes and nodes whose height is bound, \"all\" checks every node but text, vectors, groups). Instance children are excluded unless excludeInstanceChildren is false. maxResults (default 200, max 5000; 0 = counts only, scans as far as the time budget goes) stops the scan when reached: PARTIAL with nextCursor, totals cover the nodes visited by this call only, add them up across calls. includeZeroRadius:true also flags an unbound radius of 0. Read only.",
  {
    rootId: zId,
    rules: z.array(z.enum(["unbound", "primitive", "not_multiple_of_4", "zero_padding", "height_not_in_set"])).min(1).max(5).optional(),
    maxResults: z.number().int().min(0).max(5000).optional(),
    cursor: zCursor,
    timeBudgetMs: zBudget,
    excludeInstanceChildren: z.boolean().optional(),
    primitiveCollection: z.string().min(1).optional(),
    heightSet: z.array(z.number()).min(1).max(30).optional(),
    heightScope: z.enum(["components", "all"]).optional(),
    includeZeroRadius: z.boolean().optional(),
  });

budgetTool("rebind_variable_usages",
  "Replace one variable binding by another everywhere under rootId (default: every page): every node field bound to fromVariableId is bound to toVariableId (same variable type required). fields (optional) limits to the fields of bind_variable_field, plus fills, strokes (paint colors) and effects; default all. dryRun is required: true counts and writes nothing, false writes. Returns nodesChanged, bindingsChanged, byField, sample [[nodeId, field]] (20), failures [{nodeId, name, field, error}] (200 at most, failuresTotal gives the real count). Instance children are skipped unless includeInstanceChildren. Variable aliases, local styles and text range fills are not touched (find_variable_usages lists them). Time budget: if reached, the answer is PARTIAL with nextCursor; counts are per call, add them up.",
  {
    fromVariableId: zId,
    toVariableId: zId,
    dryRun: z.boolean(),
    fields: z.array(z.enum([...BIND_FIELDS, "fills", "strokes", "effects"] as [string, ...string[]])).min(1).max(40).optional(),
    rootId: z.string().min(1).optional().describe("Limit to this node (default: every page)"),
    includeInstanceChildren: z.boolean().optional(),
    maxNodes: z.number().int().min(1).max(50000).optional().describe("Nodes changed per call (default 20000)"),
    cursor: zCursor,
    timeBudgetMs: zBudget,
  });

// Define design strategy prompt
server.prompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
    };
  }
);

server.prompt(
  "read_design_strategy",
  "Best practices for reading Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_my_design() to understand the current selection
   - If no selection ask user to select single or multiple nodes
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Node Scanning Tool
server.tool(
  "scan_text_nodes",
  "Scan the text nodes of a node (read-only, hidden nodes skipped). Time budget and paging: when the budget or maxNodes is reached the answer says PARTIAL and gives nextCursor. highlight:true restores the old orange flash (a temporary fill change, slow).",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    maxNodes: z.number().int().min(1).max(5000).optional().describe("Text nodes per call (default 1000)"),
    includeInstanceChildren: z.boolean().optional().describe("Scan inside instances (default true)"),
    highlight: z.boolean().optional().describe("Flash each text node (default false)"),
    cursor: zCursor,
    timeBudgetMs: zBudget,
  },
  async (args: any) => {
    try {
      const result = await sendCommandToFigma("scan_text_nodes", args);
      return textWithNotice(result, true);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for child nodes with specific types in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z.array(z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
  },
  async ({ nodeId, types }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(', ')}...`,
      };

      // Use the plugin's scan_nodes_by_types function
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types
      });

      // Format the response
      if (result && typeof result === 'object' && 'matchingNodes' in result) {
        const typedResult = result as {
          success: boolean,
          count: number,
          matchingNodes: Array<{
            id: string,
            name: string,
            type: string,
            bbox: {
              x: number,
              y: number,
              width: number,
              height: number
            }
          }>,
          searchedTypes: Array<string>
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(', ')}`;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.matchingNodes, null, 2)
            }
          ],
        };
      }

      // If the result is in an unexpected format, return it as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Text Replacement Strategy Prompt
server.prompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id", 
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Set Multiple Text Contents Tool
server.tool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        })
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }: any) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = text.length;

      // Use the plugin's set_multiple_text_contents function with chunking
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      // Cast the result to a specific type to work with it safely
      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;

      // Format the results for display
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Annotation Conversion Strategy Prompt
server.prompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
server.prompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Always join the appropriate channel first with \`join_channel()\`
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// Set Layout Mode Tool
server.tool(
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_mode", {
        nodeId,
        layoutMode,
        layoutWrap: layoutWrap || "NO_WRAP"
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Padding Tool
server.tool(
  "set_padding",
  "Set padding values for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    paddingTop: z.number().optional().describe("Top padding value"),
    paddingRight: z.number().optional().describe("Right padding value"),
    paddingBottom: z.number().optional().describe("Bottom padding value"),
    paddingLeft: z.number().optional().describe("Left padding value"),
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }: any) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
      });
      const typedResult = result as { name: string };

      // Create a message about which padding values were set
      const paddingMessages = [];
      if (paddingTop !== undefined) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== undefined) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== undefined) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== undefined) paddingMessages.push(`left: ${paddingLeft}`);

      const paddingText = paddingMessages.length > 0
        ? `padding (${paddingMessages.join(', ')})`
        : "padding";

      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Axis Align Tool
server.tool(
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "BASELINE"])
      .optional()
      .describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }: any) => {
    try {
      const result = await sendCommandToFigma("set_axis_align", {
        nodeId,
        primaryAxisAlignItems,
        counterAxisAlignItems
      });
      const typedResult = result as { name: string };

      // Create a message about which alignments were set
      const alignMessages = [];
      if (primaryAxisAlignItems !== undefined) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== undefined) alignMessages.push(`counter: ${counterAxisAlignItems}`);

      const alignText = alignMessages.length > 0
        ? `axis alignment (${alignMessages.join(', ')})`
        : "axis alignment";

      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Layout Sizing Tool
server.tool(
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_sizing", {
        nodeId,
        layoutSizingHorizontal,
        layoutSizingVertical
      });
      const typedResult = result as { name: string };

      // Create a message about which sizing modes were set
      const sizingMessages = [];
      if (layoutSizingHorizontal !== undefined) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== undefined) sizingMessages.push(`vertical: ${layoutSizingVertical}`);

      const sizingText = sizingMessages.length > 0
        ? `layout sizing (${sizingMessages.join(', ')})`
        : "layout sizing";

      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Item Spacing Tool
server.tool(
  "set_item_spacing",
  "Set distance between children in an auto-layout frame",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    itemSpacing: z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing}: any) => {
    try {
      const params: any = { nodeId };
      if (itemSpacing !== undefined) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== undefined) params.counterAxisSpacing = counterAxisSpacing;
      
      const result = await sendCommandToFigma("set_item_spacing", params);
      const typedResult = result as { name: string, itemSpacing?: number, counterAxisSpacing?: number };

      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== undefined) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== undefined) message += ` counterAxisSpacing=${counterAxisSpacing}`;

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("get_reactions", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          },
          {
            type: "text",
            text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
          }
        ],
        followUp: {
          type: "prompt",
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Connectors Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId
      });

      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided"
            }
          ]
        };
      }

      const result = await sendCommandToFigma("create_connections", {
        connections
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
server.prompt(
  "reaction_to_connector_strategy",
  "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_my_design\` on the relevant node(s) to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_my_design\` or by calling \`get_node_info\` if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);


// Define command types and parameters
type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "join"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_local_variables"
  | "bind_variable_batch"
  | "find_variable_usages"
  | "get_nodes_bindings"
  | "audit_bindings"
  | "rebind_variable_usages"
  | "set_text_style"
  | "set_variable_description"
  | "bind_variable"
  | "rename_variable_collection"
  | "convert_to_component"
  | "combine_as_variants"
  | "add_component_property"
  | "set_component_property_reference"
  | "set_stroke_options"
  | "set_corner_radii"
  | "set_layout_positioning"
  | "create_text_style"
  | "create_page"
  | "set_instance_properties"
  | "get_clips_content"
  | "set_clips_content"
  | "clear_fills"
  | "set_explicit_variable_mode"
  | "build_tree"
  | "set_variable_scopes"
  | "set_variable_value"
  | "create_variable"
  | "create_variable_collection"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  | "set_image_fill"
  | "rename_node"
  | "create_section"
  | "set_parent";

type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string; depth?: number };
  get_nodes_info: { nodeIds: string[] };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  move_node: {
    nodeId: string;
    x: number;
    y: number;
  };
  resize_node: {
    nodeId: string;
    width: number;
    height: number;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
  };
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number;
  };
  execute_code: {
    code: string;
  };
  join: {
    channel: string;
  };
  set_corner_radius: {
    nodeId: string;
    radius: number;
    corners?: boolean[];
  };
  create_variable_collection: Record<string, unknown>;
  create_variable: Record<string, unknown>;
  set_variable_value: Record<string, unknown>;
  set_variable_scopes: Record<string, unknown>;
  set_variable_description: Record<string, unknown>;
  bind_variable: Record<string, unknown>;
  rename_variable_collection: Record<string, unknown>;
  convert_to_component: Record<string, unknown>;
  combine_as_variants: Record<string, unknown>;
  add_component_property: Record<string, unknown>;
  set_component_property_reference: Record<string, unknown>;
  set_stroke_options: Record<string, unknown>;
  set_corner_radii: Record<string, unknown>;
  set_layout_positioning: Record<string, unknown>;
  create_text_style: Record<string, unknown>;
  create_page: Record<string, unknown>;
  set_instance_properties: Record<string, unknown>;
  get_clips_content: Record<string, unknown>;
  set_clips_content: Record<string, unknown>;
  clear_fills: Record<string, unknown>;
  set_explicit_variable_mode: Record<string, unknown>;
  build_tree: Record<string, unknown>;
  set_text_style: Record<string, unknown>;
  get_local_variables: Record<string, unknown>;
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  set_text_content: {
    nodeId: string;
    text: string;
  };
  scan_text_nodes: {
    nodeId: string;
    useChunking: boolean;
    chunkSize: number;
  };
  set_multiple_text_contents: {
    nodeId: string;
    text: Array<{ nodeId: string; text: string }>;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
  scan_nodes_by_types: {
    nodeId: string;
    types: Array<string>;
  };
  get_reactions: { nodeIds: string[] };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };
  set_image_fill: {
    nodeId: string;
    imageBase64: string;
    scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
  };
  rename_node: {
    nodeId: string;
    name: string;
  };
  create_section: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
  };
  set_parent: {
    nodeId: string;
    parentId: string;
    x?: number;
    y?: number;
    index?: number;
  };

};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

// Update the connectToFigma function
// Port: 3055 by default. TALK_TO_FIGMA_PORT is only used for tests on a separate relay.
const DEFAULT_PORT = Number(process.env.TALK_TO_FIGMA_PORT) || 3055;

function connectToFigma(port: number = DEFAULT_PORT) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  const wsUrl = `${WS_URL}:${port}`;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  let token: string;
  try {
    token = readRelayToken();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    setTimeout(() => connectToFigma(port), 2000);
    return;
  }
  // The token is never written to the logs.
  ws = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`);

  ws.on('open', () => {
    logger.info('Connected to Figma socket server');
    // The channel is kept: it is rejoined automatically on the new connection.
    channelReady = false;
    if (currentChannel) {
      const name = currentChannel;
      sendOnce("join", { channel: name }, 10000, uuidv4())
        .then(() => { channelReady = true; logger.info(`Channel rejoined after reconnection: ${name}`); })
        .catch((e) => logger.error(`Impossible de rejoindre ${name} : ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  ws.on("message", (data: any) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any; // Allow any other properties
      }

      const json = JSON.parse(data) as ProgressMessage;

      // Relay events: the channel plugin left or came back
      if (json.type === 'system' && (json as any).event) {
        if ((json as any).event === 'plugin_left') connectionEpoch++;
        logger.info(`Relay event: ${(json as any).event}`);
        return;
      }

      // Relay answer to a request outside any channel (list_channels)
      if (json.type === 'channels' && json.id && pendingRelay.has(json.id)) {
        const r = pendingRelay.get(json.id)!;
        clearTimeout(r.timeout);
        pendingRelay.delete(json.id);
        r.resolve(json);
        return;
      }

      // Handle progress updates
      if (json.type === 'progress_update') {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || '';

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();
          request.acked = true;

          // Pushes the timeout back: as long as the plugin shows signs of life, the call does not expire.
          const isHeartbeat = (progressData as any)?.heartbeat === true;
          let ms = Math.max(60000, request.timeoutMs); // at least 60 s of inactivity (as before)
          if (HEAVY_COMMANDS.has(String((progressData as any)?.commandType))) {
            ms = Math.min(request.timeoutMs, request.startedAt + HEAVY_MAX_MS - Date.now());
          }
          if (ms > 0) rearmTimeout(requestId, request, ms);
          if (isHeartbeat) return; // signal de vie : ni journal ni autre traitement

          // Log progress
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === 'completed' && progressData.progress === 100) {
            // Optionally resolve early with partial data
            // request.resolve(progressData.payload);
            // pendingRequests.delete(requestId);

            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      // Never the content in the logs: an answer can weigh several MB.
      logger.debug(`Received message: id=${myResponse?.id} ${String(data).length} characters`);

      // Large answer (> 1 MB) sent in chunks: we reassemble it, then handle it like an
      // ordinary answer once the last chunk has arrived.
      if (myResponse?.id && myResponse.chunk && pendingRequests.has(myResponse.id)) {
        const request = pendingRequests.get(myResponse.id)!;
        const { index, total, data: part } = myResponse.chunk;
        if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total || typeof part !== "string") {
          pendingRequests.delete(myResponse.id);
          clearTimeout(request.timeout);
          request.reject(new Error("Invalid answer chunk received from the plugin"));
          return;
        }
        if (!request.chunks || request.chunks.total !== total) {
          request.chunks = { total, parts: new Array(total), got: 0 };
        }
        if (request.chunks.parts[index] === undefined) {
          request.chunks.parts[index] = part;
          request.chunks.got++;
        }
        request.lastActivity = Date.now();
        request.acked = true;
        rearmTimeout(myResponse.id, request, Math.max(60000, request.timeoutMs));
        if (request.chunks.got === total) {
          clearTimeout(request.timeout);
          pendingRequests.delete(myResponse.id);
          try {
            request.resolve(JSON.parse(request.chunks.parts.join("")));
          } catch (e) {
            request.reject(new Error("Chunked answer unreadable after reassembly"));
          }
        }
        return;
      }

      // Handle response to a request
      if (
        myResponse.id &&
        pendingRequests.has(myResponse.id) &&
        myResponse.result
      ) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new FigmaCallError(myResponse.error, myResponse.code));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }

        pendingRequests.delete(myResponse.id);
      } else {
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on('close', () => {
    logger.info('Disconnected from Figma socket server');
    ws = null;
    channelReady = false;
    connectionEpoch++;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new FigmaCallError("Connection closed", "connection_closed"));
      pendingRequests.delete(id);
    }

    // Attempt to reconnect
    logger.info('Attempting to reconnect in 2 seconds...');
    setTimeout(() => connectToFigma(port), 2000);
  });
}

// Channel = Figma file name formatted (lowercase, no accents, every sign or space
// replaced by a dash). Same function as in the plugin (ui.html); idempotent.
function slugifyChannel(name: string): string {
  const slug = String(name || "")
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .replace(/ß/g, "ss")
    .replace(/ø/gi, "o")
    .replace(/ł/gi, "l")
    .replace(/đ/gi, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed";
}

// Asks the relay for the list of channels held by a connected plugin.
interface ChannelInfo { channel: string; fileName: string | null; lastSeen: string; secondsSinceLastSeen: number }
function listChannelsFromRelay(): Promise<ChannelInfo[]> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Relay unreachable. Start the relay with: bun run socket, then retry."));
      return;
    }
    const id = uuidv4();
    const timeout = setTimeout(() => {
      pendingRelay.delete(id);
      reject(new Error(
        "The relay did not answer list_channels: it is probably running an old version. " +
        "Ask the user to restart the relay (it does not restart by itself), then retry."
      ));
    }, 4000);
    pendingRelay.set(id, { resolve: (m) => resolve(m.channels as ChannelInfo[]), timeout });
    ws.send(JSON.stringify({ type: "list_channels", id }));
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    channelReady = true;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Function to send commands to Figma
function sendOnce(
  command: FigmaCommand,
  params: unknown,
  timeoutMs: number,
  id: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new FigmaCallError("Not connected to Figma. Attempting to connect...", "connection_closed"));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout: setTimeout(() => {}, 0),
      lastActivity: Date.now(),
      timeoutMs,
      startedAt: Date.now(),
      acked: false,
    });
    rearmTimeout(id, pendingRequests.get(id)!, timeoutMs);

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

const PLUGIN_WAIT_MS = 25000;

// Waits for the plugin to be (back) on the current channel. False if the timeout passes.
async function waitForPlugin(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (ws && ws.readyState === WebSocket.OPEN && currentChannel && channelReady) {
      try {
        const list = await listChannelsFromRelay();
        if (list.some((c) => c.channel === currentChannel)) return true;
      } catch {
        // silent or old relay: we keep waiting until the timeout
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// Clear final message: plugin missing, or present but silent.
async function explainFailure(cause: unknown, waitedMs: number): Promise<Error> {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const channel = currentChannel ?? "(none)";
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return new Error(`Relay unreachable (${raw}). Start the relay with: bun run socket, then retry.`);
  }
  let entry: ChannelInfo | undefined;
  let known = false;
  try {
    const list = await listChannelsFromRelay();
    known = true;
    entry = list.find((c) => c.channel === currentChannel);
  } catch {
    // old relay: unknown
  }
  if (known && !entry) {
    return new Error(
      `Figma plugin missing from channel "${channel}": no plugin connected on this channel` +
      (waitedMs ? ` after ${Math.round(waitedMs / 1000)} s of waiting and one resend` : "") +
      `. The file may be closed or the plugin stopped: ask the user to run the plugin in this file (Cmd+Option+P).`
    );
  }
  if (entry) {
    return new Error(
      `The plugin is connected on channel "${channel}" (last sign of life ${entry.secondsSinceLastSeen} s ago) but did not answer in time: ${raw}.`
    );
  }
  return new Error(`${raw} (plugin state unknown: old relay, the user needs to restart it).`);
}

// Sends a command. If the call fails because the plugin is missing or because a
// reconnection happened during the call, it is resent ONLY ONCE (same identifier,
// the plugin does not replay what it already executed) after the plugin comes back.
async function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = defaultTimeoutFor(command)
): Promise<unknown> {
  if (command === "join") {
    return sendOnce(command, params, timeoutMs, uuidv4());
  }
  // Reconnection in progress: give the channel time to be rejoined (10 s at most)
  for (let i = 0; i < 20 && currentChannel && !channelReady; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const id = uuidv4();
  const epoch = connectionEpoch;
  try {
    return await sendOnce(command, params, timeoutMs, id);
  } catch (err) {
    const code = err instanceof FigmaCallError ? err.code : undefined;
    const crossedReconnect = connectionEpoch !== epoch;
    const recoverable =
      code === "plugin_absent" ||
      code === "connection_closed" ||
      // An expired call is only resent if it went through a disconnection AND the plugin had
      // never received it: a call already in progress in the plugin is never resent.
      (code === "timeout" && crossedReconnect && !(err as FigmaCallError).acked);
    if (!recoverable || !currentChannel) {
      if (code === "timeout" || code === "plugin_absent") throw await explainFailure(err, 0);
      throw err;
    }
    const t0 = Date.now();
    logger.warn(`Call ${command} interrupted (${code}): waiting for the plugin, then a single resend`);
    const back = await waitForPlugin(PLUGIN_WAIT_MS);
    if (!back) throw await explainFailure(err, Date.now() - t0);
    try {
      return await sendOnce(command, params, timeoutMs, id);
    } catch (err2) {
      const c2 = err2 instanceof FigmaCallError ? err2.code : undefined;
      if (c2 === "timeout" || c2 === "plugin_absent" || c2 === "connection_closed") {
        throw await explainFailure(err2, Date.now() - t0);
      }
      throw err2;
    }
  }
}

// Set Image Fill Tool
server.tool(
  "set_image_fill",
  "Fill a node in Figma with an image from a local file path or base64 data (replaces the node's existing fills). Remote URLs are not supported.",
  {
    nodeId: z.string().describe("The ID of the node to fill"),
    imagePath: z
      .string()
      .optional()
      .describe(
        "Absolute path to a local image file, read by the MCP server (preferred: keeps image bytes out of the model context)"
      ),
    imageBase64: z
      .string()
      .optional()
      .describe(
        "Base64-encoded image data, with or without a data: URI prefix (only when the image exists nowhere else)"
      ),
    scaleMode: z
      .enum(["FILL", "FIT", "CROP", "TILE"])
      .optional()
      .describe("How the image fills the node (default: FILL)"),
  },
  async ({ nodeId, imagePath, imageBase64, scaleMode }: any) => {
    try {
      const sources = [imagePath, imageBase64].filter(
        (source) => source !== undefined && source !== ""
      );
      if (sources.length !== 1) {
        throw new Error("Provide exactly one of imagePath or imageBase64 (remote URLs are blocked)");
      }

      let base64Data: string;
      if (imagePath) {
        base64Data = (await readFile(imagePath)).toString("base64");
      } else {
        base64Data = imageBase64.replace(/^data:[^;,]+;base64,/, "");
      }

      // Keep well under the websocket relay's default 16MB frame limit
      if (base64Data.length > 12 * 1024 * 1024) {
        throw new Error(
          "Image is too large to send over the relay (~9MB binary max); downscale it first"
        );
      }

      const result = await sendCommandToFigma("set_image_fill", {
        nodeId,
        imageBase64: base64Data,
        scaleMode: scaleMode || "FILL",
      });
      const typedResult = result as {
        name: string;
        imageHash: string;
        imageWidth?: number;
        imageHeight?: number;
      };
      const sizeInfo = typedResult.imageWidth
        ? ` (${typedResult.imageWidth}x${typedResult.imageHeight})`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Set image fill of node "${typedResult.name}"${sizeInfo} with scale mode ${scaleMode || "FILL"
              }, imageHash: ${typedResult.imageHash}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Rename Node Tool
server.tool(
  "rename_node",
  "Rename a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to rename"),
    name: z.string().describe("The new name for the node"),
  },
  async ({ nodeId, name }: any) => {
    try {
      const result = await sendCommandToFigma("rename_node", { nodeId, name });
      const typedResult = result as { previousName: string; name: string };
      return {
        content: [
          {
            type: "text",
            text: `Renamed node from "${typedResult.previousName}" to "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error renaming node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Section Tool
server.tool(
  "create_section",
  "Create a section in Figma to group related content on the canvas",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the section"),
    height: z.number().describe("Height of the section"),
    name: z.string().optional().describe("Optional name for the section"),
  },
  async ({ x, y, width, height, name }: any) => {
    try {
      const result = await sendCommandToFigma("create_section", {
        x,
        y,
        width,
        height,
        name: name || "Section",
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created section "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating section: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Parent Tool
server.tool(
  "set_parent",
  "Move a node into a new parent node (e.g. a section, frame or group). Preserves the node's absolute position unless x/y are provided",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    parentId: z
      .string()
      .describe("The ID of the new parent node (must support children, e.g. a section, frame or group)"),
    x: z.number().optional().describe("Optional X position relative to the new parent"),
    y: z.number().optional().describe("Optional Y position relative to the new parent"),
    index: z
      .number()
      .optional()
      .describe("Optional child index to insert at (default: appended as last child)"),
  },
  async ({ nodeId, parentId, x, y, index }: any) => {
    try {
      const result = await sendCommandToFigma("set_parent", {
        nodeId,
        parentId,
        x,
        y,
        index,
      });
      const typedResult = result as {
        name: string;
        parentName: string;
        x?: number;
        y?: number;
      };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" into "${typedResult.parentName}" at (${typedResult.x}, ${typedResult.y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting parent: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// List channels tool (lecture seule)
server.tool(
  "list_channels",
  "List the channels currently held by a connected Figma plugin, with the Figma file name and the time of the plugin's last sign of life. Read-only. Use it to find the channel of your file, then join_channel.",
  {},
  async () => {
    try {
      const list = await listChannelsFromRelay();
      const text = list.length === 0
        ? "No plugin connected. Ask the user to run the plugin in the target Figma file (Cmd+Option+P)."
        : JSON.stringify(list.map((c) => ({
            channel: c.channel,
            fileName: c.fileName,
            lastSeen: c.lastSeen,
            secondsSinceLastSeen: c.secondsSinceLastSeen,
          })), null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `list_channels error: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Update the join_channel tool
server.tool(
  "join_channel",
  "Join a channel to communicate with Figma. Accepts a channel name or a Figma file name (e.g. \"My App / Design system\" becomes \"my-app-design-system\"), turned into a channel the same way the plugin does.",
  {
    channel: z.string().describe("The channel name, or the Figma file name").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // If no channel provided, ask the user for input
        return {
          content: [
            {
              type: "text",
              text: "Please provide a channel name to join:",
            },
          ],
          followUp: {
            tool: "join_channel",
            description: "Join the specified channel",
          },
        };
      }

      const name = slugifyChannel(channel);
      await joinChannel(name);
      let note = "";
      try {
        const list = await listChannelsFromRelay();
        if (!list.some((c) => c.channel === name)) {
          note = list.length
            ? ` Warning: no plugin connected on this channel yet. Channels with a plugin: ${list.map((c) => c.channel).join(", ")}.`
            : " Warning: no plugin connected yet. Ask the user to run the plugin in this file (Cmd+Option+P).";
        }
      } catch {
        // old or silent relay: the join succeeded, we do not block
      }
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${name}` + (name !== channel ? ` (from "${channel}")` : "") + note,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});



