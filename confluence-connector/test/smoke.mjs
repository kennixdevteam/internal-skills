#!/usr/bin/env node
// End-to-end smoke test: stands up a fake Confluence on localhost, drives the
// real MCP server over stdio, and asserts on the responses.
//
//   node confluence-connector/test/smoke.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");

const BODY_A = `<h2>Deploy runbook</h2>
<p>Owner is <ac:link><ri:user ri:userkey="u123"/></ac:link>.</p>
<p>Steps live in <ac:link><ri:page ri:content-title="Deploy Guide" ri:space-key="OPS"/><ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>.</p>
<p>Vendor doc: <a href="https://vendor.example.com/manual">vendor manual</a></p>
<ul><li>check disk</li><li>drain traffic<ul><li>wait 30s</li></ul></li></ul>
<table><tbody><tr><th>Env</th><th>Host</th></tr><tr><td>prod</td><td>app.internal</td></tr></tbody></table>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[systemctl restart app]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>`;

const pages = {
  1001: {
    id: "1001",
    type: "page",
    title: "Release Runbook",
    space: { key: "OPS", name: "Operations" },
    version: { number: 5, by: { displayName: "Bob Chan" }, when: "2026-08-02T09:00:00Z" },
    history: { createdBy: { displayName: "Alice Wong" }, createdDate: "2026-07-01T00:00:00Z" },
    metadata: { labels: { results: [{ name: "runbook" }, { name: "ops" }] } },
    ancestors: [{ id: "1000", title: "Operations Home", _links: { webui: "/display/OPS/Operations+Home" } }],
    body: { storage: { value: BODY_A, representation: "storage" } },
    children: {
      attachment: {
        results: [
          { id: "att1", title: "topology.png", metadata: { mediaType: "image/png" }, extensions: { fileSize: 4096 }, version: { number: 1, by: { displayName: "Bob Chan" }, when: "2026-08-01T00:00:00Z" } },
        ],
      },
    },
    _links: { webui: "/display/OPS/Release+Runbook" },
  },
  1002: {
    id: "1002",
    type: "page",
    title: "Deploy Guide",
    space: { key: "OPS", name: "Operations" },
    version: { number: 2, by: { displayName: "Carol Ng" }, when: "2026-08-03T00:00:00Z" },
    history: { createdBy: { displayName: "Carol Ng" }, createdDate: "2026-07-05T00:00:00Z" },
    metadata: { labels: { results: [] } },
    ancestors: [],
    body: { storage: { value: `<p>Run <a href="${"http://127.0.0.1:PORT/pages/viewpage.action?pageId=1003"}">the checklist</a>.</p>` } },
    _links: { webui: "/display/OPS/Deploy+Guide" },
  },
  1004: {
    id: "1004",
    type: "page",
    title: "Incident Handbook",
    space: { key: "OPS", name: "Operations" },
    version: { number: 3 },
    history: {},
    metadata: { labels: { results: [] } },
    ancestors: [],
    body: { storage: { value: "<p>" + "Long standing operational guidance that people rely on. ".repeat(12) + "</p>" } },
    _links: { webui: "/display/OPS/Incident+Handbook" },
  },
  1003: {
    id: "1003",
    type: "page",
    title: "Checklist",
    space: { key: "OPS", name: "Operations" },
    version: { number: 1 },
    history: {},
    metadata: { labels: { results: [] } },
    ancestors: [],
    body: { storage: { value: "<p>tick everything</p>" } },
    _links: { webui: "/display/OPS/Checklist" },
  },
};

const COMMENTS = {
  1001: [
    {
      id: "c1",
      version: { by: { displayName: "Carol Ng" }, when: "2026-08-02T10:00:00Z" },
      body: { storage: { value: '<p><ac:link><ri:user ri:userkey="u123"/></ac:link> please review</p>' } },
    },
  ],
};

const calls = [];

function startFakeConfluence() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      const raw = await new Promise((r) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => r(b));
      });
      const body = req.method === "GET" ? null : JSON.parse(raw || "null");
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });

      const json = (code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const p = url.pathname;

      if (!req.headers.authorization) return json(401, { message: "no auth" });

      if (p === "/rest/api/user/current") return json(200, { displayName: "Service Bot", userKey: "bot" });
      if (p === "/rest/api/user") {
        const key = url.searchParams.get("key") || url.searchParams.get("username") || url.searchParams.get("accountId");
        return key === "u123" ? json(200, { displayName: "Alice Wong", userKey: "u123" }) : json(404, { message: "no user" });
      }
      if (p === "/rest/api/space") return json(200, { results: [{ key: "OPS", name: "Operations", type: "global", _links: { webui: "/display/OPS" } }] });

      let m = /^\/rest\/api\/content\/(\d+)$/.exec(p);
      if (m && req.method === "GET") {
        const page = pages[m[1]];
        return page ? json(200, page) : json(404, { message: `no content ${m[1]}` });
      }
      if (m && req.method === "PUT") {
        const page = pages[m[1]];
        if (!page) return json(404, { message: "no content" });
        page.title = body.title;
        page.body = { storage: { value: body.body.storage.value, representation: "storage" } };
        page.version = { number: body.version.number, by: { displayName: "Service Bot" }, when: "2026-08-22T00:00:00Z" };
        return json(200, page);
      }
      m = /^\/rest\/api\/content\/(\d+)\/child\/comment$/.exec(p);
      if (m) return json(200, { results: COMMENTS[m[1]] || [] });
      m = /^\/rest\/api\/content\/(\d+)\/child\/page$/.exec(p);
      if (m) return json(200, { results: m[1] === "1001" ? [{ id: "1002", title: "Deploy Guide", type: "page", version: { number: 2 }, _links: { webui: "/display/OPS/Deploy+Guide" } }] : [] });
      m = /^\/rest\/api\/content\/(\d+)\/label$/.exec(p);
      if (m && req.method === "POST") return json(200, { results: body });

      if (p === "/rest/api/content" && req.method === "GET") {
        const title = url.searchParams.get("title");
        const hit = Object.values(pages).find((x) => x.title === title);
        return json(200, { results: hit ? [hit] : [] });
      }
      if (p === "/rest/api/content" && req.method === "POST") {
        if (body.type === "comment") return json(200, { id: "c99", type: "comment", _links: { webui: "/display/OPS/Release+Runbook?focusedCommentId=c99" } });
        const id = "2001";
        pages[id] = { ...body, id, version: { number: 1 }, history: {}, metadata: { labels: { results: [] } }, ancestors: [], _links: { webui: "/display/OPS/New+Page" } };
        return json(200, pages[id]);
      }
      if (p === "/rest/api/content/search") {
        const hit = Object.values(pages).find((x) => (url.searchParams.get("cql") || "").includes(x.title));
        return json(200, { results: hit ? [hit] : [] });
      }
      return json(404, { message: `no route ${p}` });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function startMcp(port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CONFLUENCE_BASE_URL: `http://127.0.0.1:${port}`, CONFLUENCE_TOKEN: "test-token", CONFLUENCE_EMAIL: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result.content[0].text;
    return { isError: !!r.result.isError, text, data: r.result.isError ? null : JSON.parse(text) };
  };
  return { child, rpc, call };
}

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push(`  PASS  ${label}`);
  } catch (e) {
    results.push(`  FAIL  ${label}\n        ${e.message}`);
    process.exitCode = 1;
  }
};

const { srv, port } = await startFakeConfluence();
pages[1002].body.storage.value = pages[1002].body.storage.value.replace("PORT", String(port));
const { child, rpc, call } = startMcp(port);

// --- protocol -------------------------------------------------------------

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
check("initialize handshake", () => {
  assert.equal(init.result.serverInfo.name, "confluence-connector");
  assert.equal(init.result.protocolVersion, "2025-06-18");
});

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
check("tools/list exposes the read + write tools", () => {
  for (const n of [
    "confluence_read", "confluence_get_page", "confluence_get_page_tree", "confluence_search",
    "confluence_create_page", "confluence_add_comment",
    "confluence_preview_update", "confluence_confirm_update", "confluence_apply_update",
  ]) assert.ok(names.includes(n), `missing ${n}`);
});
check("NO delete / trash / archive tool is exposed", () => {
  const bad = names.filter((n) => /delete|remove|destroy|archive|trash|purge/i.test(n));
  assert.deepEqual(bad, [], `unexpected destructive tools: ${bad}`);
});

// --- reading --------------------------------------------------------------

const page = await call("confluence_get_page", { page_id: "1001" });
check("reads title, space, version, labels", () => {
  assert.equal(page.data.title, "Release Runbook");
  assert.equal(page.data.space.key, "OPS");
  assert.equal(page.data.version.number, 5);
  assert.deepEqual(page.data.labels, ["runbook", "ops"]);
});
check("renders storage format to readable text", () => {
  assert.match(page.data.body, /## Deploy runbook/);
  assert.match(page.data.body, /- check disk/);
  assert.match(page.data.body, /^ {2}- wait 30s$/m, "nested list should indent");
  assert.match(page.data.body, /\| Env \| Host \|/);
  assert.match(page.data.body, /```bash\nsystemctl restart app\n```/);
});
check("resolves @mentions to display names", () => {
  assert.match(page.data.body, /Owner is @Alice Wong/);
  assert.deepEqual(page.data.mentions, ["Alice Wong"]);
});
check("reads comments", () => {
  assert.equal(page.data.comments.length, 1);
  assert.equal(page.data.comments[0].by, "Carol Ng");
  assert.match(page.data.comments[0].text, /@Alice Wong please review/);
});
check("reports ancestors and children", () => {
  assert.equal(page.data.ancestors[0].title, "Operations Home");
  assert.equal(page.data.children[0].title, "Deploy Guide");
});
check("lists attachment metadata only", () => {
  assert.equal(page.data.attachments[0].filename, "topology.png");
  assert.equal(page.data.attachments[0].size, 4096);
  assert.ok(!("content" in page.data.attachments[0]) && !("data" in page.data.attachments[0]));
});
check("flags macros it cannot round-trip", () => {
  assert.deepEqual(page.data.unsupported_macros, ["jira"]);
});

const read1 = await call("confluence_read", { targets: ["1001"] });
check("read follows an internal page link at depth 1", () => {
  const titles = read1.data.pages.map((p) => p.title);
  assert.ok(titles.includes("Release Runbook") && titles.includes("Deploy Guide"), `got ${titles}`);
  assert.equal(read1.data.pages.find((p) => p.title === "Deploy Guide").depth, 1);
});
check("read stops at the configured depth", () => {
  assert.ok(!read1.data.pages.some((p) => p.title === "Checklist"), "Checklist is 2 hops away and must not be read at depth 1");
});
check("read records off-host links without fetching them", () => {
  const ext = read1.data.external_links_not_fetched;
  assert.equal(ext.length, 1);
  assert.equal(ext[0].host, "vendor.example.com");
  assert.equal(calls.filter((c) => /vendor/.test(c.path)).length, 0);
});

const read2 = await call("confluence_read", { targets: ["1001"], max_depth: 2 });
check("depth 2 reaches the link-of-a-link", () => {
  assert.ok(read2.data.pages.some((p) => p.title === "Checklist"));
});

const read0 = await call("confluence_read", { targets: ["1001"], max_depth: 0 });
check("max_depth 0 reads only the listed targets", () => {
  assert.equal(read0.data.page_count, 1);
});

const readList = await call("confluence_read", { targets: ["1001", "OPS:Deploy Guide", `http://127.0.0.1:${port}/pages/viewpage.action?pageId=1003`], follow_links: false });
check("read accepts a mixed list of ids, SPACE:Title and URLs", () => {
  assert.deepEqual(readList.data.pages.map((p) => p.id).sort(), ["1001", "1002", "1003"]);
});

const readBudget = await call("confluence_read", { targets: ["1001"], max_depth: 3, max_pages: 2 });
check("read honours the page budget and says so", () => {
  assert.equal(readBudget.data.page_count, 2);
  assert.equal(readBudget.data.truncated, true);
  assert.ok(readBudget.data.skipped.some((s) => /budget/.test(s.reason)));
});

const readExt = await call("confluence_read", { targets: ["https://vendor.example.com/manual"] });
check("read refuses an off-host target outright", () => {
  assert.equal(readExt.data.page_count, 0);
  assert.equal(readExt.data.external_links_not_fetched[0].host, "vendor.example.com");
});

const tree = await call("confluence_get_page_tree", { page_id: "1001" });
check("page tree walks child pages", () => {
  assert.equal(tree.data.root.title, "Release Runbook");
  assert.equal(tree.data.tree[0].title, "Deploy Guide");
});

// --- the write path -------------------------------------------------------

const writesBefore = () => calls.filter((c) => c.method !== "GET").length;
const before = writesBefore();

const preview = await call("confluence_preview_update", {
  page_id: "1001",
  title: "Release Runbook (v2)",
  body: "## Deploy runbook\n\nOwner is @Alice Wong.\n\n- check disk\n- drain traffic\n- verify metrics\n",
  add_labels: ["reviewed"],
});
check("preview writes nothing", () => {
  assert.equal(preview.data.written, false);
  assert.equal(writesBefore(), before, "preview must not issue a write");
});
check("preview shows a title change and a line diff", () => {
  const byField = Object.fromEntries(preview.data.changes.map((c) => [c.field, c]));
  assert.equal(byField.title.current, "Release Runbook");
  assert.equal(byField.title.proposed, "Release Runbook (v2)");
  assert.ok(byField.body.diff.hunks.join("\n").includes("+- verify metrics"));
  assert.deepEqual(byField.labels.adding, ["reviewed"]);
});
check("preview warns about macros and mentions it will drop", () => {
  assert.ok(preview.data.warnings.some((w) => /jira/.test(w)), "should warn about the jira macro");
  assert.ok(preview.data.warnings.some((w) => /mention/i.test(w)));
});

const skipStep2 = await call("confluence_apply_update", { page_id: "1001", apply_token: preview.data.change_token, confirm: true });
check("apply rejects a change_token — step 2 cannot be skipped", () => {
  assert.ok(skipStep2.isError && /Unknown or expired apply_token/.test(skipStep2.text));
});

const noApproval = await call("confluence_confirm_update", { page_id: "1001", change_token: preview.data.change_token, user_approved: false });
check("confirm refuses without user_approved=true", () => {
  assert.ok(noApproval.isError && /user_approved must be true/.test(noApproval.text));
});

const wrongPage = await call("confluence_confirm_update", { page_id: "1002", change_token: preview.data.change_token, user_approved: true });
check("confirm refuses a token issued for another page", () => {
  assert.ok(wrongPage.isError && /belongs to page 1001/.test(wrongPage.text));
});

const confirmed = await call("confluence_confirm_update", { page_id: "1001", change_token: preview.data.change_token, user_approved: true });
check("confirm returns an apply_token and still writes nothing", () => {
  assert.equal(confirmed.data.written, false);
  assert.ok(confirmed.data.apply_token);
  assert.notEqual(confirmed.data.apply_token, preview.data.change_token);
  assert.equal(writesBefore(), before);
});

const noConfirmFlag = await call("confluence_apply_update", { page_id: "1001", apply_token: confirmed.data.apply_token, confirm: false });
check("apply refuses without confirm=true", () => {
  assert.ok(noConfirmFlag.isError && /confirm must be true/.test(noConfirmFlag.text));
});
check("no write happened during any refusal", () => {
  assert.equal(writesBefore(), before);
});

const applied = await call("confluence_apply_update", { page_id: "1001", apply_token: confirmed.data.apply_token, confirm: true });
check("apply writes once all three steps are satisfied", () => {
  assert.equal(applied.data.written, true);
  const put = calls.find((c) => c.method === "PUT" && c.path === "/rest/api/content/1001");
  assert.ok(put, "expected a PUT");
  assert.equal(put.body.title, "Release Runbook (v2)");
  assert.equal(put.body.version.number, 6, "version must be bumped from 5");
  assert.match(put.body.body.storage.value, /<li>verify metrics<\/li>/);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/rest/api/content/1001/label"));
});

const replay = await call("confluence_apply_update", { page_id: "1001", apply_token: confirmed.data.apply_token, confirm: true });
check("an apply_token cannot be replayed", () => {
  assert.ok(replay.isError && /Unknown or expired apply_token/.test(replay.text));
});

// --- concurrent edit ------------------------------------------------------

const p2 = await call("confluence_preview_update", { page_id: "1002", body: "rewritten guide with plenty of words to keep the ratio healthy" });
const c2 = await call("confluence_confirm_update", { page_id: "1002", change_token: p2.data.change_token, user_approved: true });
pages[1002].version.number = 99; // somebody else edits the page mid-confirmation
const conflict = await call("confluence_apply_update", { page_id: "1002", apply_token: c2.data.apply_token, confirm: true });
check("apply refuses when the page changed since the preview", () => {
  assert.ok(conflict.isError && /changed while you were confirming/.test(conflict.text), conflict.text);
  assert.ok(!calls.some((c) => c.method === "PUT" && c.path === "/rest/api/content/1002"), "nothing may be written on a conflict");
});

// --- content-loss guard ---------------------------------------------------

const wipe = await call("confluence_preview_update", { page_id: "1004", body: "gone" });
check("preview flags a rewrite that destroys the page content", () => {
  assert.equal(wipe.data.requires_extra_acknowledgement, true);
  assert.ok(wipe.data.warnings.some((w) => /CONTENT LOSS/.test(w)));
});
const wipeNoAck = await call("confluence_confirm_update", { page_id: "1004", change_token: wipe.data.change_token, user_approved: true });
check("confirm refuses a destructive rewrite without acknowledge_content_loss", () => {
  assert.ok(wipeNoAck.isError && /acknowledge_content_loss=true/.test(wipeNoAck.text));
});
const wipeAck = await call("confluence_confirm_update", { page_id: "1004", change_token: wipe.data.change_token, user_approved: true, acknowledge_content_loss: true });
check("confirm allows it once the loss is acknowledged explicitly", () => {
  assert.ok(wipeAck.data.apply_token);
});

const emptyBody = await call("confluence_preview_update", { page_id: "1003", body: "   " });
check("an empty body is always flagged", () => {
  assert.equal(emptyBody.data.requires_extra_acknowledgement, true);
});

// --- label removal, title-only edits --------------------------------------

const rmLabel = await call("confluence_preview_update", { page_id: "1001", remove_labels: ["ops"] });
check("removing a label is refused and explained", () => {
  assert.ok(rmLabel.isError && /cannot remove labels/.test(rmLabel.text));
});

const titleOnly = await call("confluence_preview_update", { page_id: "1003", title: "Checklist v2" });
const titleOk = await call("confluence_confirm_update", { page_id: "1003", change_token: titleOnly.data.change_token, user_approved: true });
await call("confluence_apply_update", { page_id: "1003", apply_token: titleOk.data.apply_token, confirm: true });
check("a title-only edit leaves the stored markup byte-identical", () => {
  const put = calls.find((c) => c.method === "PUT" && c.path === "/rest/api/content/1003");
  assert.equal(put.body.body.storage.value, "<p>tick everything</p>");
  assert.equal(put.body.title, "Checklist v2");
});

// --- create + comment -----------------------------------------------------

const created = await call("confluence_create_page", { space: "OPS", title: "Postmortem 2026-08", body: "# Summary\n\n- one\n- two\n", labels: ["postmortem"] });
check("creates a page with converted storage markup", () => {
  assert.equal(created.data.written, true);
  const post = calls.find((c) => c.method === "POST" && c.path === "/rest/api/content" && c.body?.type === "page");
  assert.equal(post.body.space.key, "OPS");
  assert.equal(post.body.body.storage.representation, "storage");
  assert.match(post.body.body.storage.value, /<h1>Summary<\/h1>/);
  assert.match(post.body.body.storage.value, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

const commented = await call("confluence_add_comment", { page_id: "1001", body: "Checked on prod." });
check("adds a comment", () => {
  assert.equal(commented.data.written, true);
  assert.ok(calls.some((c) => c.method === "POST" && c.body?.type === "comment"));
});

// --- guard rails ----------------------------------------------------------

check("only GET, POST and PUT ever reached the server", () => {
  assert.ok(calls.length > 0);
  assert.deepEqual([...new Set(calls.map((c) => c.method))].sort(), ["GET", "POST", "PUT"]);
});
check("every request stayed on the configured host", () => {
  assert.ok(calls.every((c) => c.path.startsWith("/rest/api")));
});

const { ConfluenceClient } = await import("../mcp/confluence-client.mjs");
const c = new ConfluenceClient({ CONFLUENCE_BASE_URL: `http://127.0.0.1:${port}`, CONFLUENCE_TOKEN: "t" });

const mustReject = async (label, fn, pattern) => {
  try {
    await fn();
    results.push(`  FAIL  ${label}\n        the call was allowed`);
    process.exitCode = 1;
  } catch (e) {
    try {
      assert.match(e.message, pattern);
      results.push(`  PASS  ${label}`);
    } catch (inner) {
      results.push(`  FAIL  ${label}\n        wrong error: ${e.message}`);
      process.exitCode = 1;
    }
  }
};

await mustReject("client blocks DELETE", () => c.request("DELETE", "/rest/api/content/1001"), /blocked by this server/);
await mustReject("client blocks off-host requests", () => c.request("GET", "https://evil.example.com/steal"), /only 127\.0\.0\.1:\d+ is allowed/);
await mustReject(
  "client blocks a PUT that trashes a page",
  () => c.request("PUT", "/rest/api/content/1001", { body: { id: "1001", type: "page", status: "trashed" } }),
  /never trashes, archives or deletes/
);
await mustReject(
  "client blocks status:archived nested deep in a payload",
  () => c.request("PUT", "/rest/api/content/1001", { body: { page: { meta: [{ status: "ARCHIVED" }] } } }),
  /never trashes, archives or deletes/
);
await mustReject("client blocks the trash endpoint", () => c.request("POST", "/rest/api/content/1001/trash"), /blocked by this server/);
await mustReject("client blocks attachment downloads", () => c.request("GET", "/rest/api/content/1001/child/attachment/att1/data"), /blocked by this server/);
await mustReject("client blocks restriction changes", () => c.request("PUT", "/rest/api/content/1001/restriction"), /blocked by this server/);
await mustReject("client blocks ?status=trashed", () => c.request("GET", "/rest/api/content/1001", { query: { status: "trashed" } }), /Refusing a request with status=trashed/);

const ro = new ConfluenceClient({ CONFLUENCE_BASE_URL: `http://127.0.0.1:${port}`, CONFLUENCE_TOKEN: "t", CONFLUENCE_READONLY: "1" });
await mustReject("CONFLUENCE_READONLY blocks writes", () => ro.request("POST", "/rest/api/content", { body: {} }), /CONFLUENCE_READONLY/);

console.log("\n" + results.join("\n"));
const passed = results.filter((r) => r.startsWith("  PASS")).length;
const failed = results.filter((r) => r.startsWith("  FAIL")).length;
console.log(`\n${passed} passed, ${failed} failed\n`);

child.kill();
srv.close();
