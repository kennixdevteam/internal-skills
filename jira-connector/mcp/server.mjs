#!/usr/bin/env node
// MCP server for the intranet Jira. Zero runtime dependencies.
//
//   JIRA_BASE_URL   required, e.g. https://jira.internal.example.com
//   JIRA_TOKEN      required, personal access token
//   JIRA_EMAIL      set only for Jira Cloud (switches auth to Basic)
//   JIRA_READONLY   set to 1 to refuse every write
//
// See README.md for the optional field-override variables.

import { serve, log } from "./rpc.mjs";
import { JiraClient } from "./jira-client.mjs";
import { TOOL_DESCRIPTORS, makeDispatcher } from "./tools.mjs";

let client;
try {
  client = new JiraClient();
} catch (err) {
  log(`[jira-connector] startup failed: ${err.message}`);
  process.exit(1);
}

log(`[jira-connector] host allowlist: ${client.allowedHost}${client.readOnly ? " (read-only)" : ""}`);

serve({
  name: "jira-connector",
  version: "1.0.0",
  tools: TOOL_DESCRIPTORS,
  callTool: makeDispatcher(client),
});
