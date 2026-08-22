// Tool definitions and handlers.
//
// Reads are unrestricted. Writes are limited to three verbs — create page,
// add comment, update page — and update is split into THREE steps so the user
// sees the exact diff and confirms it twice before anything is written.
//
// There is no delete tool, no trash tool, no archive tool, and none should
// ever be added; see README.md.

import { randomBytes } from "node:crypto";
import { textToStorage, parseStorage, SAFE_MACROS } from "./storage.mjs";
import { normalisePage, summarisePage, lineDiff, PAGE_EXPAND } from "./page.mjs";

const PREVIEW_TTL_MS = 15 * 60 * 1000;

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 3;
const DEFAULT_MAX_PAGES = 25;
const HARD_MAX_PAGES = 100;

// A rewrite that keeps less than this share of the original text is treated as
// a deletion in disguise and needs a separate acknowledgement.
const MIN_RETAINED_RATIO = 0.2;
const SHRINK_GUARD_MIN_CHARS = 200;

const pending = new Map(); // token -> {stage, pageId, ...}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v ?? dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

const newToken = () => randomBytes(10).toString("hex");

function prunePending() {
  const now = Date.now();
  for (const [t, p] of pending) if (p.expires < now) pending.delete(t);
}

const cql = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---------------------------------------------------------------- reading

async function findByTitle(client, space, title) {
  if (space) {
    const res = await client.api("GET", "/content", {
      query: { spaceKey: space, title, expand: "version", limit: 5 },
    });
    const hit = res?.results?.[0];
    if (hit) return hit.id;
  }
  const res = await client.api("GET", "/content/search", {
    query: { cql: `title = ${cql(title)}${space ? ` and space = ${cql(space)}` : ""}`, limit: 5 },
  });
  const hit = res?.results?.[0];
  if (!hit) throw new Error(`No page titled "${title}"${space ? ` in space ${space}` : ""}`);
  return hit.id;
}

/** Turn a parsed target into a page id, or explain why we cannot. */
async function resolveId(client, parsed) {
  switch (parsed.kind) {
    case "id":
      return parsed.id;
    case "title":
      return findByTitle(client, parsed.space, parsed.title);
    case "space":
      throw new Error(`That is a space URL (${parsed.space}), not a page. Use confluence_search to find pages in it.`);
    case "external":
      throw new Error(`Refusing to read ${parsed.host}: only ${client.allowedHost} is allowed.`);
    default:
      throw new Error(`Cannot work out what page "${parsed.raw ?? parsed.url}" refers to. Pass a page id, a page URL on ${client.allowedHost}, or "SPACE:Title".`);
  }
}

/**
 * Resolve whatever the caller gave us — page_id, url, or space + title.
 */
async function targetToId(client, { page_id, url, space, title }) {
  if (page_id != null && String(page_id).trim()) return resolveId(client, client.parseTarget(String(page_id)));
  if (url) return resolveId(client, client.parseTarget(url));
  if (title) return findByTitle(client, space, title);
  throw new Error("Pass page_id, url, or space + title.");
}

const getRaw = (client, id, expand = PAGE_EXPAND) =>
  client.api("GET", `/content/${encodeURIComponent(id)}`, { query: { expand } });

async function getComments(client, id, limit = 50) {
  try {
    const res = await client.api("GET", `/content/${encodeURIComponent(id)}/child/comment`, {
      query: { expand: "body.storage,version,history.createdBy", depth: "all", limit },
    });
    return res?.results || [];
  } catch {
    return []; // comments disabled or not permitted — not a reason to fail the read
  }
}

async function getChildPages(client, id, limit = 200) {
  const out = [];
  let start = 0;
  while (out.length < limit) {
    const res = await client.api("GET", `/content/${encodeURIComponent(id)}/child/page`, {
      query: { limit: Math.min(100, limit - out.length), start, expand: "version,space" },
    });
    const batch = res?.results || [];
    out.push(...batch);
    if (batch.length < 1 || !res?._links?.next) break;
    start += batch.length;
  }
  return out;
}

async function fetchPage(client, id, { comments = true, children = true } = {}) {
  const raw = await getRaw(client, id);
  const [cmts, kids] = await Promise.all([
    comments ? getComments(client, id) : Promise.resolve([]),
    children ? getChildPages(client, id, 200).catch(() => null) : Promise.resolve(null),
  ]);
  return normalisePage(client, raw, { comments: cmts, children: kids });
}

/**
 * Read a list of pages, optionally following the Confluence links inside them.
 * Links to any other host are recorded and never fetched.
 */
async function readMany(client, args) {
  const targets = Array.isArray(args.targets) ? args.targets : [args.targets].filter(Boolean);
  if (!targets.length) throw new Error("Pass at least one target: a page id, a page URL, or \"SPACE:Title\".");

  const maxDepth = clamp(args.max_depth, 0, MAX_DEPTH, DEFAULT_DEPTH);
  const budget = clamp(args.max_pages, 1, HARD_MAX_PAGES, DEFAULT_MAX_PAGES);
  const follow = args.follow_links !== false;
  const withComments = args.include_comments !== false;

  const queue = targets.map((t) => ({ target: t, depth: 0, from: null }));
  const seenIds = new Set();
  const seenKeys = new Set();
  const pages = [];
  const skipped = [];
  const external = new Map();
  let deepest = 0;

  while (queue.length) {
    if (pages.length >= budget) {
      for (const q of queue) skipped.push({ target: describeTarget(q.target), reason: "page budget reached", from: q.from });
      break;
    }
    const { target, depth, from } = queue.shift();
    const parsed = typeof target === "string" ? client.parseTarget(target) : target;

    if (parsed.kind === "external") {
      const key = parsed.url;
      if (!external.has(key)) external.set(key, { url: parsed.url, host: parsed.host, linked_from: from });
      continue;
    }
    const dedupeKey = parsed.kind === "id" ? `id:${parsed.id}` : parsed.kind === "title" ? `t:${(parsed.space || "").toLowerCase()}:${parsed.title.toLowerCase()}` : null;
    if (dedupeKey && seenKeys.has(dedupeKey)) continue;
    if (dedupeKey) seenKeys.add(dedupeKey);

    let id;
    try {
      id = await resolveId(client, parsed);
    } catch (err) {
      skipped.push({ target: describeTarget(target), reason: err.message, from });
      continue;
    }
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    let page;
    try {
      page = await fetchPage(client, id, { comments: withComments, children: false });
    } catch (err) {
      skipped.push({ target: describeTarget(target), reason: err.message, from });
      continue;
    }

    deepest = Math.max(deepest, depth);
    pages.push({ ...page, depth, linked_from: from });

    if (!follow || depth >= maxDepth) continue;

    for (const ref of page.linked_pages) {
      queue.push({ target: { kind: "title", space: ref.space, title: ref.title }, depth: depth + 1, from: page.title });
    }
    for (const href of page.linked_urls) {
      const p = client.parseTarget(href);
      if (p.kind === "external") {
        if (!external.has(href)) external.set(href, { url: href, host: p.host, linked_from: page.title });
        continue;
      }
      if (p.kind === "id" || p.kind === "title") queue.push({ target: p, depth: depth + 1, from: page.title });
    }
  }

  return {
    pages,
    page_count: pages.length,
    requested: targets.length,
    max_depth: maxDepth,
    deepest_reached: deepest,
    max_pages: budget,
    truncated: pages.length >= budget,
    followed_links: follow,
    external_links_not_fetched: [...external.values()],
    skipped,
  };
}

const describeTarget = (t) =>
  typeof t === "string" ? t : t.kind === "title" ? `${t.space ? t.space + ":" : ""}${t.title}` : t.id || t.url || JSON.stringify(t);

async function pageTree(client, args) {
  const rootId = await targetToId(client, args);
  const maxDepth = clamp(args.max_depth, 1, 5, 3);
  const budget = clamp(args.max_pages, 1, HARD_MAX_PAGES, 50);

  const root = await fetchPage(client, rootId, { comments: args.include_comments === true, children: false });
  const flat = [];
  let truncated = false;

  async function walk(id, depth, path) {
    if (depth > maxDepth) return [];
    const kids = await getChildPages(client, id, budget);
    const out = [];
    for (const k of kids) {
      if (flat.length >= budget) {
        truncated = true;
        break;
      }
      const node = { ...summarisePage(client, k), depth, path: [...path, k.title] };
      flat.push(node);
      node.children = await walk(k.id, depth + 1, node.path);
      out.push(node);
    }
    return out;
  }

  const tree = await walk(rootId, 1, [root.title]);
  return { root, tree, descendant_count: flat.length, max_depth: maxDepth, truncated };
}

async function search(client, { cql: query, limit }) {
  if (!query) throw new Error("Pass a CQL query, e.g. 'space = OPS and text ~ \"deploy\"'.");
  const capped = clamp(limit, 1, 100, 25);
  let res;
  try {
    res = await client.api("GET", "/content/search", { query: { cql: query, limit: capped, expand: "version,space" } });
  } catch {
    res = await client.api("GET", "/search", { query: { cql: query, limit: capped } });
  }
  const results = (res?.results || []).map((r) => summarisePage(client, r.content || r));
  return { cql: query, count: results.length, results };
}

// ---------------------------------------------------------------- writing

async function createPage(client, args) {
  const space = args.space || args.space_key;
  if (!space) throw new Error("space is required — ask the user which space the page belongs in, do not guess.");
  if (!args.title) throw new Error("title is required.");

  const body = {
    type: "page",
    title: args.title,
    space: { key: space },
    body: { storage: { value: textToStorage(args.body ?? ""), representation: "storage" } },
  };
  if (args.parent_id) body.ancestors = [{ id: String(args.parent_id) }];

  const created = await client.api("POST", "/content", { body });

  const labels = (args.labels || []).filter(Boolean);
  if (labels.length) {
    await client.api("POST", `/content/${encodeURIComponent(created.id)}/label`, {
      body: labels.map((name) => ({ prefix: "global", name: String(name) })),
    });
  }

  return {
    written: true,
    id: created.id,
    title: created.title,
    space,
    parent_id: args.parent_id || null,
    labels,
    version: created.version?.number ?? 1,
    url: client.pageUrl(created),
  };
}

async function addComment(client, args) {
  if (!args.body) throw new Error("body is required.");
  const id = await targetToId(client, args);
  const created = await client.api("POST", "/content", {
    body: {
      type: "comment",
      container: { id: String(id), type: "page" },
      body: { storage: { value: textToStorage(args.body), representation: "storage" } },
    },
  });
  return { written: true, comment_id: created.id, page_id: id, url: client.pageUrl(created) };
}

async function previewUpdate(client, args) {
  if (args.remove_labels?.length) {
    throw new Error(
      "This connector cannot remove labels: removing one needs an HTTP DELETE, which is blocked at the transport layer. " +
        "Ask the user to remove it in the Confluence UI."
    );
  }
  const hasChange = args.title != null || args.body != null || (args.add_labels?.length ?? 0) > 0;
  if (!hasChange) throw new Error("Nothing to preview: pass title, body, add_labels, or a combination.");

  const id = await targetToId(client, args);
  const raw = await getRaw(client, id, "body.storage,version,space,metadata.labels,ancestors");

  const currentStorage = raw.body?.storage?.value ?? "";
  const current = parseStorage(currentStorage);
  const currentLabels = (raw.metadata?.labels?.results || []).map((l) => l.name);

  const newTitle = args.title != null ? String(args.title) : raw.title;
  // Only reserialise the body when the body is actually changing — a title-only
  // edit must not rewrite (and risk mangling) the stored markup.
  const bodyChanging = args.body != null;
  const newStorage = bodyChanging ? textToStorage(args.body) : currentStorage;
  const newText = bodyChanging ? parseStorage(newStorage).text : current.text;

  const addLabels = (args.add_labels || []).map(String).filter((l) => !currentLabels.includes(l));

  const changes = [];
  if (newTitle !== raw.title) changes.push({ field: "title", current: raw.title, proposed: newTitle });
  if (bodyChanging) {
    changes.push({
      field: "body",
      chars_before: current.text.length,
      chars_after: newText.length,
      diff: lineDiff(current.text, newText),
    });
  }
  if (addLabels.length) changes.push({ field: "labels", current: currentLabels, adding: addLabels });

  if (!changes.length) {
    return { page_id: id, url: client.pageUrl(raw), written: false, changes: [], note: "The page already matches what you proposed. Nothing to do." };
  }

  const warnings = [];
  let requiresAck = false;

  if (bodyChanging) {
    const kept = current.text.length ? newText.length / current.text.length : 1;
    if (current.text.length >= SHRINK_GUARD_MIN_CHARS && kept < MIN_RETAINED_RATIO) {
      requiresAck = true;
      warnings.push(
        `CONTENT LOSS: this rewrite keeps only ${Math.round(kept * 100)}% of the page text ` +
          `(${current.text.length} -> ${newText.length} characters). Confirming it needs acknowledge_content_loss=true.`
      );
    }
    if (!newText.trim()) {
      requiresAck = true;
      warnings.push("CONTENT LOSS: the proposed body is empty. This connector will not blank a page without an explicit acknowledgement.");
    }
    const unsafe = current.macros.filter((m) => !SAFE_MACROS.has(m));
    if (unsafe.length) {
      warnings.push(
        `The current page uses macros this connector does not round-trip: ${unsafe.join(", ")}. ` +
          `Replacing the body will drop them. Prefer editing this page in the Confluence UI.`
      );
    }
    if (current.mentionIds.length) {
      warnings.push(`The current page has ${current.mentionIds.length} @mention(s); a body rewrite turns them into plain text.`);
    }
    if (current.attachments.length) {
      warnings.push(`The current page embeds ${current.attachments.length} attachment/image reference(s); a body rewrite drops the embeds (the files themselves stay).`);
    }
  }

  prunePending();
  const token = newToken();
  pending.set(token, {
    stage: "previewed",
    pageId: String(id),
    title: newTitle,
    storage: newStorage,
    bodyChanging,
    addLabels,
    baseVersion: raw.version?.number ?? null,
    spaceKey: raw.space?.key ?? null,
    changes,
    requiresAck,
    expires: Date.now() + PREVIEW_TTL_MS,
  });

  return {
    page_id: id,
    url: client.pageUrl(raw),
    page_title: raw.title,
    current_version: raw.version?.number ?? null,
    written: false,
    changes,
    warnings,
    requires_extra_acknowledgement: requiresAck,
    change_token: token,
    expires_in_minutes: PREVIEW_TTL_MS / 60000,
    next_step:
      "STEP 1 OF 3 DONE. Nothing has been written. Show these changes to the user verbatim — including every warning — " +
      "and get their explicit approval. Then call confluence_confirm_update with this change_token and user_approved=true" +
      (requiresAck ? " and acknowledge_content_loss=true" : "") +
      ". If the user wants anything different, call confluence_preview_update again — never edit the token.",
  };
}

async function confirmUpdate(client, { page_id, change_token, user_approved, acknowledge_content_loss }) {
  prunePending();
  if (user_approved !== true) {
    throw new Error("Refusing to proceed: user_approved must be true, and only after the user has seen and approved the previewed diff.");
  }
  const p = pending.get(change_token);
  if (!p || p.stage !== "previewed") {
    throw new Error("Unknown or expired change_token. Call confluence_preview_update again and re-confirm with the user.");
  }
  if (String(page_id) !== p.pageId) throw new Error(`change_token belongs to page ${p.pageId}, not ${page_id}.`);
  if (p.requiresAck && acknowledge_content_loss !== true) {
    throw new Error(
      "This change removes most or all of the page content. Show the user the content-loss warning again and, only if they " +
        "still want it, call this tool with acknowledge_content_loss=true."
    );
  }

  pending.delete(change_token);
  const applyToken = newToken();
  pending.set(applyToken, { ...p, stage: "confirmed", expires: Date.now() + PREVIEW_TTL_MS });

  return {
    page_id: p.pageId,
    written: false,
    apply_token: applyToken,
    changes: p.changes,
    expires_in_minutes: PREVIEW_TTL_MS / 60000,
    next_step:
      "STEP 2 OF 3 DONE. Still nothing written. Ask the user ONE final time — name the page and summarise what will change — " +
      "and only after they confirm again, call confluence_apply_update with this apply_token and confirm=true.",
  };
}

async function applyUpdate(client, { page_id, apply_token, confirm }) {
  prunePending();
  if (confirm !== true) {
    throw new Error("Refusing to write: confirm must be true, and only after the user's second confirmation.");
  }
  const p = pending.get(apply_token);
  if (!p || p.stage !== "confirmed") {
    throw new Error(
      "Unknown or expired apply_token. The three-step flow is preview -> confirm -> apply; start again at confluence_preview_update."
    );
  }
  if (String(page_id) !== p.pageId) throw new Error(`apply_token belongs to page ${p.pageId}, not ${page_id}.`);

  // Optimistic lock: someone may have edited the page since the preview.
  const fresh = await client.api("GET", `/content/${encodeURIComponent(p.pageId)}`, { query: { expand: "version" } });
  const liveVersion = fresh?.version?.number ?? null;
  if (p.baseVersion != null && liveVersion !== p.baseVersion) {
    pending.delete(apply_token);
    throw new Error(
      `The page changed while you were confirming (version ${p.baseVersion} -> ${liveVersion}). ` +
        `Nothing was written. Call confluence_preview_update again so the user reviews a fresh diff.`
    );
  }

  const applied = [];
  const updated = await client.api("PUT", `/content/${encodeURIComponent(p.pageId)}`, {
    body: {
      id: p.pageId,
      type: "page",
      title: p.title,
      ...(p.spaceKey ? { space: { key: p.spaceKey } } : {}),
      version: { number: (liveVersion ?? 0) + 1, message: "Edited via confluence-connector after two user confirmations" },
      body: { storage: { value: p.storage, representation: "storage" } },
    },
  });
  applied.push(p.bodyChanging ? "body" : "title/metadata");

  if (p.addLabels.length) {
    await client.api("POST", `/content/${encodeURIComponent(p.pageId)}/label`, {
      body: p.addLabels.map((name) => ({ prefix: "global", name })),
    });
    applied.push(`labels +${p.addLabels.join(", +")}`);
  }

  pending.delete(apply_token);

  return {
    written: true,
    page_id: p.pageId,
    title: updated?.title ?? p.title,
    version: updated?.version?.number ?? (liveVersion ?? 0) + 1,
    url: client.pageUrl(updated || { id: p.pageId }),
    applied,
    changes: p.changes,
  };
}

// ---------------------------------------------------------------- registry

const TARGET_PROPS = {
  page_id: { type: "string", description: "Numeric Confluence page id" },
  url: { type: "string", description: "Page URL on the configured intranet host" },
  space: { type: "string", description: "Space key, used with title" },
  title: { type: "string", description: "Exact page title, used with space" },
};

export const TOOLS = [
  {
    name: "confluence_whoami",
    description:
      "Check the Confluence connection and report the authenticated user, base URL, detected REST prefix and whether the server is read-only. Use this first if anything looks misconfigured.",
    inputSchema: { type: "object", properties: {} },
    handler: async (client) => {
      const prefix = await client.prefix();
      let me = null;
      try {
        me = await client.api("GET", "/user/current");
      } catch {
        /* some deployments hide this endpoint */
      }
      return {
        base_url: client.base.toString(),
        allowed_host: client.allowedHost,
        api_prefix: prefix,
        read_only: client.readOnly,
        user: me ? { name: me.displayName || me.username, id: me.accountId || me.userKey || me.username } : null,
        policy: "Reads are free. Creating a page or comment needs an explicit user instruction. Editing a page needs preview -> confirm -> apply. Deleting, trashing and archiving are not possible with this server.",
      };
    },
  },
  {
    name: "confluence_list_spaces",
    description: "List the Confluence spaces this account can see. Useful before creating a page, to pick the right space key.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max spaces to return (default 50)" } },
    },
    handler: async (client, a) => {
      const res = await client.api("GET", "/space", { query: { limit: clamp(a.limit, 1, 200, 50) } });
      return {
        count: res?.results?.length || 0,
        spaces: (res?.results || []).map((s) => ({ key: s.key, name: s.name, type: s.type, url: client.pageUrl(s) })),
      };
    },
  },
  {
    name: "confluence_read",
    description:
      "PREFERRED READ TOOL. Read one or many Confluence pages in a single call and, by default, also read the Confluence pages they link to (depth 1, up to 25 pages). Each target may be a page id, a page URL on the intranet host, or \"SPACE:Title\". Returns full page text, labels, version, ancestors, comments, @mentions and attachment metadata for every page visited, plus a list of links that were deliberately NOT fetched (anything off-host).",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description: 'Pages to read: page ids, page URLs, or "SPACE:Title" entries. Mix freely.',
        },
        max_depth: { type: "number", description: `How many link hops to follow (0 = do not follow, default ${DEFAULT_DEPTH}, max ${MAX_DEPTH})` },
        max_pages: { type: "number", description: `Total page budget (default ${DEFAULT_MAX_PAGES}, max ${HARD_MAX_PAGES})` },
        follow_links: { type: "boolean", description: "Set false to read only the listed targets (default true)" },
        include_comments: { type: "boolean", description: "Include page comments (default true)" },
      },
      required: ["targets"],
    },
    handler: (client, a) => readMany(client, a),
  },
  {
    name: "confluence_get_page",
    description:
      "Read exactly one page and nothing else — body, labels, version history, ancestors, child page list, comments, @mentions and attachment metadata. Use confluence_read instead when the surrounding pages matter.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        include_comments: { type: "boolean", description: "Default true" },
      },
    },
    handler: async (client, a) => {
      const id = await targetToId(client, a);
      return fetchPage(client, id, { comments: a.include_comments !== false, children: true });
    },
  },
  {
    name: "confluence_get_page_tree",
    description: "Read a page and walk every child page beneath it. Use when the user asks about a whole section or handbook rather than one page.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        max_depth: { type: "number", description: "How deep to walk (default 3, max 5)" },
        max_pages: { type: "number", description: "Descendant budget (default 50)" },
        include_comments: { type: "boolean", description: "Include comments on the root page (default false)" },
      },
    },
    handler: (client, a) => pageTree(client, a),
  },
  {
    name: "confluence_search",
    description: 'Find pages with CQL, e.g. \'space = OPS and text ~ "deploy runbook"\' or \'title ~ "onboarding"\'. Returns summaries; follow up with confluence_read for full content.',
    inputSchema: {
      type: "object",
      properties: {
        cql: { type: "string", description: "CQL query" },
        limit: { type: "number", description: "Max results (default 25)" },
      },
      required: ["cql"],
    },
    handler: (client, a) => search(client, a),
  },
  {
    name: "confluence_create_page",
    description:
      "Create a NEW Confluence page. Only call this when the user has explicitly asked for a page to be created. Never invent the space or title — ask if they are not given. Body is markdown-ish text (headings, lists, tables, fenced code, links) and is converted to Confluence storage format.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space key the page goes in" },
        title: { type: "string", description: "Page title" },
        body: { type: "string", description: "Page content as markdown-ish text" },
        parent_id: { type: "string", description: "Optional parent page id — the new page becomes its child" },
        labels: { type: "array", items: { type: "string" }, description: "Optional labels to add after creation" },
      },
      required: ["space", "title", "body"],
    },
    handler: (client, a) => createPage(client, a),
  },
  {
    name: "confluence_add_comment",
    description: "Add a comment to a page. Only call this when the user has explicitly asked for a comment to be posted.",
    inputSchema: {
      type: "object",
      properties: { ...TARGET_PROPS, body: { type: "string", description: "Comment text (markdown-ish)" } },
      required: ["body"],
    },
    handler: (client, a) => addComment(client, a),
  },
  {
    name: "confluence_preview_update",
    description:
      "STEP 1 OF 3 — writes nothing. Computes the exact before/after diff for a proposed edit to an existing page and returns a change_token. You MUST show the diff and every warning to the user and get their explicit approval before going on. Always start here; the later steps cannot run without this token. Never call it on your own initiative: an edit must be something the user asked for.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        body: { type: "string", description: "Proposed new page content (markdown-ish). Omit to leave the body untouched." },
        add_labels: { type: "array", items: { type: "string" }, description: "Labels to add. Labels cannot be removed by this server." },
      },
    },
    handler: (client, a) => previewUpdate(client, a),
  },
  {
    name: "confluence_confirm_update",
    description:
      "STEP 2 OF 3 — still writes nothing. Records that the user approved the previewed diff and returns an apply_token. Only call this after you showed the user the diff from confluence_preview_update and they explicitly approved it.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page the change_token was issued for" },
        change_token: { type: "string", description: "Token returned by confluence_preview_update" },
        user_approved: { type: "boolean", description: "Must be true, and only after the user approved the diff" },
        acknowledge_content_loss: { type: "boolean", description: "Required when the preview flagged requires_extra_acknowledgement" },
      },
      required: ["page_id", "change_token", "user_approved"],
    },
    handler: (client, a) => confirmUpdate(client, a),
  },
  {
    name: "confluence_apply_update",
    description:
      "STEP 3 OF 3 — writes to Confluence. Only call this after confluence_confirm_update returned an apply_token AND you asked the user one final time and they confirmed again. Rejects the write if anyone edited the page since the preview.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "The page the apply_token was issued for" },
        apply_token: { type: "string", description: "Token returned by confluence_confirm_update" },
        confirm: { type: "boolean", description: "Must be true, after the user's second confirmation" },
      },
      required: ["page_id", "apply_token", "confirm"],
    },
    handler: (client, a) => applyUpdate(client, a),
  },
];

export const TOOL_DESCRIPTORS = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

export function makeDispatcher(client) {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return async (name, args) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(client, args || {});
  };
}
