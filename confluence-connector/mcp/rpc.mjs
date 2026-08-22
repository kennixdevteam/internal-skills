// Minimal MCP stdio server. Zero dependencies — JSON-RPC 2.0 over
// newline-delimited JSON on stdin/stdout.
//
// stdout is reserved for protocol messages. All logging goes to stderr.

import { createInterface } from "node:readline";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.version
 * @param {Array}  opts.tools     tool descriptors: {name, description, inputSchema}
 * @param {Function} opts.callTool async (name, args) => any (serialised as JSON text)
 */
export function serve({ name, version, tools, callTool }) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      replyError(null, -32700, "Parse error");
      return;
    }

    // Notifications carry no id and expect no response.
    const isNotification = msg.id === undefined || msg.id === null;

    try {
      switch (msg.method) {
        case "initialize": {
          const asked = msg.params?.protocolVersion;
          const version_ = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
          reply(msg.id, {
            protocolVersion: version_,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          });
          return;
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return;

        case "ping":
          if (!isNotification) reply(msg.id, {});
          return;

        case "tools/list":
          reply(msg.id, { tools });
          return;

        case "tools/call": {
          const toolName = msg.params?.name;
          const args = msg.params?.arguments ?? {};
          try {
            const result = await callTool(toolName, args);
            reply(msg.id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            // Tool-level failures are reported inside the result so the model
            // can read and react to them, per the MCP spec.
            reply(msg.id, {
              content: [{ type: "text", text: `ERROR: ${err.message}` }],
              isError: true,
            });
          }
          return;
        }

        // Declared-but-unused capabilities: answer empty rather than error.
        case "resources/list":
          reply(msg.id, { resources: [] });
          return;
        case "prompts/list":
          reply(msg.id, { prompts: [] });
          return;

        default:
          if (!isNotification) replyError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      log("internal error:", err.stack || err.message);
      if (!isNotification) replyError(msg.id, -32603, `Internal error: ${err.message}`);
    }
  });

  rl.on("close", () => process.exit(0));
}
