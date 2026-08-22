#!/usr/bin/env node
// MCP server for the intranet Confluence. Zero runtime dependencies.
//
//   CONFLUENCE_BASE_URL   required, e.g. https://confluence.internal.example.com
//   CONFLUENCE_TOKEN      required, personal access token
//   CONFLUENCE_EMAIL      set only for Confluence Cloud (switches auth to Basic)
//   CONFLUENCE_READONLY   set to 1 to refuse every write
//
// See README.md for the optional tuning variables.

import { serve, log } from "./rpc.mjs";
import { ConfluenceClient } from "./confluence-client.mjs";
import { TOOL_DESCRIPTORS, makeDispatcher } from "./tools.mjs";

let client;
try {
  client = new ConfluenceClient();
} catch (err) {
  log(`[confluence-connector] startup failed: ${err.message}`);
  process.exit(1);
}

log(`[confluence-connector] host allowlist: ${client.allowedHost}${client.readOnly ? " (read-only)" : ""}`);

serve({
  name: "confluence-connector",
  version: "1.0.0",
  tools: TOOL_DESCRIPTORS,
  callTool: makeDispatcher(client),
});
