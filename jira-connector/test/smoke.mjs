#!/usr/bin/env node
// End-to-end smoke test: stands up a fake Jira on localhost, drives the real
// MCP server over stdio, and asserts on the responses.
//
//   node jira-connector/test/smoke.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");

const adf = (t) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });

const ISSUE = {
  id: "10001",
  key: "PROJ-1",
  names: { customfield_10020: "Sprint", customfield_10050: "Customer Tag", customfield_10099: "Risk Level" },
  fields: {
    summary: "Login page throws 500",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Repro: hit " }, { type: "text", text: "the login form", marks: [{ type: "link", attrs: { href: "https://jira.internal/x" } }] }] },
        { type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-9", text: "@Alice Wong" } }, { type: "text", text: " please look" }] },
      ],
    },
    issuetype: { name: "Bug", subtask: false },
    status: { name: "In Progress", statusCategory: { name: "In Progress" } },
    priority: { name: "High" },
    project: { key: "PROJ", name: "Platform" },
    assignee: { displayName: "Bob Chan", accountId: "acc-1" },
    reporter: { displayName: "Alice Wong", accountId: "acc-9" },
    labels: ["regression", "auth"],
    components: [{ name: "Web" }],
    fixVersions: [{ name: "2.4.0" }],
    parent: { key: "PROJ-9", fields: { summary: "Auth revamp", issuetype: { name: "Epic" }, status: { name: "In Progress" } } },
    subtasks: [{ key: "PROJ-2", fields: { summary: "Add regression test", status: { name: "To Do" }, issuetype: { name: "Sub-task" } } }],
    issuelinks: [
      { type: { outward: "blocks", inward: "is blocked by" }, outwardIssue: { key: "PROJ-7", fields: { summary: "Ship 2.4", status: { name: "To Do" }, issuetype: { name: "Task" } } } },
      { type: { outward: "relates to", inward: "relates to" }, inwardIssue: { key: "PROJ-3", fields: { summary: "Session bug", status: { name: "Done" }, issuetype: { name: "Bug" } } } },
    ],
    attachment: [{ filename: "trace.log", size: 2048, mimeType: "text/plain", author: { displayName: "Bob Chan" }, created: "2026-08-01T10:00:00Z" }],
    comment: {
      total: 1,
      comments: [{ id: "c1", author: { displayName: "Carol Ng" }, created: "2026-08-02T09:00:00Z", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-1", text: "@Bob Chan" } }, { type: "text", text: " fixed in staging" }] }] } }],
    },
    customfield_10020: ["com.atlassian.greenhopper.service.sprint.Sprint@1a[id=42,rapidViewId=7,state=ACTIVE,name=Sprint 12,startDate=2026-08-01T00:00:00.000Z,endDate=<null>]"],
    customfield_10050: [{ value: "ACME Bank" }, { value: "Globex" }],
    customfield_10099: { value: "Medium" },
    watches: { watchCount: 3 },
    votes: { votes: 1 },
    created: "2026-07-30T08:00:00Z",
    updated: "2026-08-02T09:00:00Z",
    duedate: "2026-09-01",
  },
};

const EPIC = {
  id: "10009",
  key: "PROJ-9",
  fields: { summary: "Auth revamp", issuetype: { name: "Epic", subtask: false }, status: { name: "In Progress" }, project: { key: "PROJ" }, labels: [], created: "2026-07-01T00:00:00Z", updated: "2026-08-02T00:00:00Z" },
};

const FIELDS = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
  { id: "customfield_10020", name: "Sprint", custom: true, schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
  { id: "customfield_10014", name: "Epic Link", custom: true, schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
  { id: "customfield_10011", name: "Epic Name", custom: true, schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" } },
  { id: "customfield_10016", name: "Story Points", custom: true, schema: { type: "number" } },
  { id: "customfield_10050", name: "Customer Tag", custom: true, schema: { type: "array" } },
  { id: "customfield_10099", name: "Risk Level", custom: true, schema: { type: "option" } },
];

const calls = [];

function startFakeJira() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      const body = req.method === "GET" ? null : JSON.parse((await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); })) || "null");
      calls.push({ method: req.method, path: url.pathname, body });

      const json = (code, payload) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); };
      const p = url.pathname;

      if (!req.headers.authorization) return json(401, { errorMessages: ["no auth"] });
      if (p === "/rest/api/3/myself") return json(200, { displayName: "Service Bot", accountId: "acc-bot" });
      if (p === "/rest/api/3/field") return json(200, FIELDS);
      if (p === "/rest/api/3/issue/PROJ-1" && req.method === "GET") return json(200, ISSUE);
      if (p === "/rest/api/3/issue/PROJ-9" && req.method === "GET") return json(200, EPIC);
      if (p === "/rest/api/3/issue/PROJ-1" && req.method === "PUT") return json(204, null);
      if (p === "/rest/api/3/issue/PROJ-1/transitions" && req.method === "GET")
        return json(200, { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
      if (p === "/rest/api/3/issue/PROJ-1/transitions" && req.method === "POST") return json(204, null);
      if (p === "/rest/api/3/issue" && req.method === "POST") return json(201, { id: "10100", key: "PROJ-100" });
      if (p === "/rest/agile/1.0/epic/PROJ-9/issue")
        return json(200, { issues: [{ key: "PROJ-1", fields: { summary: "Login page throws 500", status: { name: "In Progress" }, issuetype: { name: "Bug" } } }, { key: "PROJ-4", fields: { summary: "Rotate keys", status: { name: "To Do" }, issuetype: { name: "Task" } } }] });
      if (p === "/rest/api/3/search/jql") return json(200, { issues: [] });
      return json(404, { errorMessages: [`no route ${p}`] });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function startMcp(port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, JIRA_BASE_URL: `http://127.0.0.1:${port}`, JIRA_TOKEN: "test-token", JIRA_EMAIL: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result.content[0].text;
    return { isError: !!r.result.isError, text, data: r.result.isError ? null : JSON.parse(text) };
  };
  return { child, rpc, call };
}

const results = [];
const check = (label, fn) => { try { fn(); results.push(`  PASS  ${label}`); } catch (e) { results.push(`  FAIL  ${label}\n        ${e.message}`); process.exitCode = 1; } };

const { srv, port } = await startFakeJira();
const { child, rpc, call } = startMcp(port);

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
check("initialize handshake", () => {
  assert.equal(init.result.serverInfo.name, "jira-connector");
  assert.equal(init.result.protocolVersion, "2025-06-18");
});

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
check("tools/list exposes the read + write tools", () => {
  for (const n of ["jira_get_issue", "jira_get_issue_tree", "jira_get_epic_children", "jira_search", "jira_create_issue", "jira_preview_update", "jira_apply_update"]) assert.ok(names.includes(n), `missing ${n}`);
});
check("NO delete tool is exposed", () => {
  const bad = names.filter((n) => /delete|remove|destroy|archive/i.test(n));
  assert.deepEqual(bad, [], `unexpected destructive tools: ${bad}`);
});

const issue = await call("jira_get_issue", { key: "PROJ-1" });
check("reads core fields", () => {
  assert.equal(issue.data.key, "PROJ-1");
  assert.equal(issue.data.status, "In Progress");
  assert.equal(issue.data.priority, "High");
  assert.equal(issue.data.assignee.name, "Bob Chan");
  assert.deepEqual(issue.data.labels, ["regression", "auth"]);
});
check("flattens ADF description and keeps links", () => {
  assert.match(issue.data.description, /Repro: hit \[the login form\]\(https:\/\/jira\.internal\/x\)/);
});
check("captures @mentions from description and comments", () => {
  assert.deepEqual(issue.data.mentions.sort(), ["Alice Wong", "Bob Chan"]);
});
check("parses sprint from the legacy Java-bean string", () => {
  assert.equal(issue.data.sprints.length, 1);
  assert.equal(issue.data.sprints[0].name, "Sprint 12");
  assert.equal(issue.data.sprints[0].state, "ACTIVE");
  assert.equal(issue.data.sprints[0].id, "42");
  assert.equal(issue.data.sprints[0].endDate, null, "<null> should normalise to null");
});
check("discovers the customer tag field by name", () => {
  assert.deepEqual(issue.data.customer_tags, ["ACME Bank", "Globex"]);
});
check("resolves parent", () => {
  assert.equal(issue.data.parent.key, "PROJ-9");
  assert.equal(issue.data.parent.via, "parent");
});
check("flattens issue links with direction", () => {
  assert.deepEqual(issue.data.links, [
    { relation: "blocks", direction: "outward", key: "PROJ-7", summary: "Ship 2.4", status: "To Do", type: "Task" },
    { relation: "relates to", direction: "inward", key: "PROJ-3", summary: "Session bug", status: "Done", type: "Bug" },
  ]);
});
check("carries unrecognised custom fields through under their display name", () => {
  assert.equal(issue.data.custom_fields["Risk Level"], "Medium");
});
check("lists attachment metadata only", () => {
  assert.equal(issue.data.attachments[0].filename, "trace.log");
  assert.ok(!("content" in issue.data.attachments[0]));
});

const tree = await call("jira_get_issue_tree", { key: "PROJ-1" });
check("tree walks up to the parent", () => {
  assert.equal(tree.data.ancestors.length, 1);
  assert.equal(tree.data.ancestors[0].key, "PROJ-9");
});
check("tree returns subtasks as children", () => {
  assert.equal(tree.data.child_source, "subtasks");
  assert.equal(tree.data.children[0].key, "PROJ-2");
});

const epicTree = await call("jira_get_issue_tree", { key: "PROJ-9" });
check("tree on an epic expands every ticket in the epic", () => {
  assert.equal(epicTree.data.child_source, "epic");
  assert.deepEqual(epicTree.data.children.map((c) => c.key).sort(), ["PROJ-1", "PROJ-4"]);
});

// --- write path -----------------------------------------------------------

const writesBefore = calls.filter((c) => c.method !== "GET").length;
const preview = await call("jira_preview_update", { key: "PROJ-1", fields: { summary: "Login page throws 500 on SSO", labels: ["regression", "auth", "sso"] }, transition_to: "Done" });
check("preview writes nothing", () => {
  assert.equal(preview.data.written, false);
  assert.equal(calls.filter((c) => c.method !== "GET").length, writesBefore, "preview must not issue a write");
});
check("preview shows current vs proposed for each field", () => {
  const byField = Object.fromEntries(preview.data.changes.map((c) => [c.field, c]));
  assert.equal(byField.summary.current, "Login page throws 500");
  assert.equal(byField.summary.proposed, "Login page throws 500 on SSO");
  assert.deepEqual(byField.labels.current, ["regression", "auth"]);
  assert.equal(byField.status.current, "In Progress");
  assert.equal(byField.status.proposed, "Done");
});

const noConfirm = await call("jira_apply_update", { key: "PROJ-1", change_token: preview.data.change_token, confirm: false });
check("apply refuses without confirm=true", () => {
  assert.ok(noConfirm.isError && /confirm must be true/.test(noConfirm.text));
});

const badToken = await call("jira_apply_update", { key: "PROJ-1", change_token: "deadbeef", confirm: true });
check("apply refuses an unknown token", () => {
  assert.ok(badToken.isError && /Unknown or expired/.test(badToken.text));
});

const wrongKey = await call("jira_apply_update", { key: "PROJ-2", change_token: preview.data.change_token, confirm: true });
check("apply refuses a token issued for a different issue", () => {
  assert.ok(wrongKey.isError && /belongs to PROJ-1/.test(wrongKey.text));
});
check("no write happened during any of the refusals", () => {
  assert.equal(calls.filter((c) => c.method !== "GET").length, writesBefore);
});

const applied = await call("jira_apply_update", { key: "PROJ-1", change_token: preview.data.change_token, confirm: true });
check("apply writes once the token and confirm are both right", () => {
  assert.equal(applied.data.written, true);
  const put = calls.find((c) => c.method === "PUT" && c.path === "/rest/api/3/issue/PROJ-1");
  assert.ok(put, "expected a PUT");
  assert.equal(put.body.fields.summary, "Login page throws 500 on SSO");
  assert.ok(calls.some((c) => c.method === "POST" && c.path.endsWith("/transitions")));
});

const replay = await call("jira_apply_update", { key: "PROJ-1", change_token: preview.data.change_token, confirm: true });
check("a token cannot be replayed after use", () => {
  assert.ok(replay.isError && /Unknown or expired/.test(replay.text));
});

const created = await call("jira_create_issue", { project_key: "PROJ", issue_type: "Task", summary: "Follow-up", description: "line one\n\nline two" });
check("creates an issue with an ADF description", () => {
  assert.equal(created.data.key, "PROJ-100");
  const post = calls.find((c) => c.method === "POST" && c.path === "/rest/api/3/issue");
  assert.equal(post.body.fields.description.content.length, 2);
});

// --- guard rails ----------------------------------------------------------

check("all traffic stayed on the configured host", () => {
  assert.ok(calls.length > 0);
  assert.deepEqual([...new Set(calls.map((c) => c.method))].sort(), ["GET", "POST", "PUT"]);
});

const { JiraClient } = await import("../mcp/jira-client.mjs");
const c = new JiraClient({ JIRA_BASE_URL: `http://127.0.0.1:${port}`, JIRA_TOKEN: "t" });
await c.request("DELETE", "/rest/api/3/issue/PROJ-1").then(
  () => { results.push("  FAIL  client blocks DELETE\n        DELETE was allowed"); process.exitCode = 1; },
  (e) => { assert.match(e.message, /blocked by this server/); results.push("  PASS  client blocks DELETE"); }
);
await c.request("GET", "https://evil.example.com/steal").then(
  () => { results.push("  FAIL  client blocks off-host requests\n        off-host request was allowed"); process.exitCode = 1; },
  (e) => { assert.match(e.message, /only 127\.0\.0\.1:\d+ is allowed/); results.push("  PASS  client blocks off-host requests"); }
);
const ro = new JiraClient({ JIRA_BASE_URL: `http://127.0.0.1:${port}`, JIRA_TOKEN: "t", JIRA_READONLY: "1" });
await ro.request("POST", "/rest/api/3/issue", { body: {} }).then(
  () => { results.push("  FAIL  JIRA_READONLY blocks writes"); process.exitCode = 1; },
  (e) => { assert.match(e.message, /JIRA_READONLY/); results.push("  PASS  JIRA_READONLY blocks writes"); }
);

console.log("\n" + results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("  PASS")).length} passed, ${results.filter((r) => r.startsWith("  FAIL")).length} failed\n`);

child.kill();
srv.close();
