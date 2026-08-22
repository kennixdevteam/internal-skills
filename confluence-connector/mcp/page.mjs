// Normalising Confluence content into one flat, readable shape, plus the
// line diff used by the update preview.

import { parseStorage, applyMentionNames, SAFE_MACROS } from "./storage.mjs";

export const PAGE_EXPAND =
  "body.storage,version,space,ancestors,metadata.labels,history.createdBy,history.lastUpdated,children.page,children.attachment";

const userCache = new Map(); // id -> display name (or the id, if unresolvable)
const MAX_USER_LOOKUPS = 25;

async function resolveUser(client, id) {
  if (userCache.has(id)) return userCache.get(id);
  const params = /^[0-9a-f]{24}$|:/i.test(id) ? ["accountId", "key", "username"] : ["key", "username", "accountId"];
  let name = id;
  for (const p of params) {
    try {
      const u = await client.api("GET", "/user", { query: { [p]: id } });
      if (u?.displayName) {
        name = u.displayName;
        break;
      }
    } catch {
      // Wrong parameter for this deployment, or the user is gone. Try the next.
    }
  }
  userCache.set(id, name);
  return name;
}

async function resolveMentions(client, ids) {
  const names = {};
  for (const id of ids.slice(0, MAX_USER_LOOKUPS)) names[id] = await resolveUser(client, id);
  return names;
}

const person = (p) => (p ? { name: p.displayName || p.username || p.publicName || null, id: p.accountId || p.userKey || p.username || null } : null);

/** Attachment metadata only — this connector never touches attachment bytes. */
const attachmentMeta = (client, a) => ({
  id: a.id,
  filename: a.title,
  media_type: a.metadata?.mediaType || a.extensions?.mediaType || null,
  size: a.extensions?.fileSize ?? null,
  version: a.version?.number ?? null,
  by: person(a.version?.by || a.history?.createdBy)?.name ?? null,
  when: a.version?.when || a.history?.createdDate || null,
});

export function summarisePage(client, raw) {
  return {
    id: raw.id,
    type: raw.type,
    title: raw.title,
    space: raw.space?.key || raw._expandable?.space?.split("/").pop() || null,
    url: client.pageUrl(raw),
    version: raw.version?.number ?? null,
    last_updated: raw.version?.when || raw.history?.lastUpdated?.when || null,
  };
}

/**
 * One page, everything a reader would want, in one object.
 * Comments and children are fetched separately by the caller and passed in.
 */
export async function normalisePage(client, raw, { comments = [], children = null, attachments = null } = {}) {
  const storage = raw.body?.storage?.value ?? "";
  const parsed = parseStorage(storage);
  const commentParsed = comments.map((c) => parseStorage(c.body?.storage?.value ?? ""));

  const mentionIds = [...new Set([...parsed.mentionIds, ...commentParsed.flatMap((p) => p.mentionIds)])];
  const names = mentionIds.length ? await resolveMentions(client, mentionIds) : {};

  const rawChildren = children ?? raw.children?.page?.results ?? [];
  const rawAttachments = attachments ?? raw.children?.attachment?.results ?? [];

  const unsafeMacros = parsed.macros.filter((m) => !SAFE_MACROS.has(m));

  return {
    id: raw.id,
    type: raw.type,
    title: raw.title,
    url: client.pageUrl(raw),
    space: raw.space ? { key: raw.space.key, name: raw.space.name || null } : null,
    version: {
      number: raw.version?.number ?? null,
      by: person(raw.version?.by)?.name ?? null,
      when: raw.version?.when ?? null,
      message: raw.version?.message || null,
    },
    created: {
      by: person(raw.history?.createdBy)?.name ?? null,
      when: raw.history?.createdDate ?? null,
    },
    labels: (raw.metadata?.labels?.results || []).map((l) => l.name),
    body: applyMentionNames(parsed.text, names),
    body_chars: parsed.text.length,
    ancestors: (raw.ancestors || []).map((a) => ({ id: a.id, title: a.title, url: client.pageUrl(a) })),
    children: rawChildren.map((c) => ({ id: c.id, title: c.title, url: client.pageUrl(c) })),
    child_count: rawChildren.length,
    attachments: rawAttachments.map((a) => attachmentMeta(client, a)),
    comments: comments.map((c, i) => ({
      id: c.id,
      by: person(c.version?.by || c.history?.createdBy)?.name ?? null,
      when: c.version?.when || c.history?.createdDate || null,
      text: applyMentionNames(commentParsed[i].text, names),
    })),
    mentions: mentionIds.map((id) => names[id] || id),
    macros: parsed.macros,
    unsupported_macros: unsafeMacros,
    linked_pages: parsed.pageRefs,
    linked_urls: parsed.hrefs,
    referenced_attachments: parsed.attachments,
  };
}

// ---------------------------------------------------------------- diffing

const MAX_DIFF_LINES = 800;

/**
 * Line-level diff for the update preview. Falls back to counts-only on very
 * large pages so a preview never blows up the response.
 */
export function lineDiff(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return {
      truncated: true,
      lines_before: a.length,
      lines_after: b.length,
      hunks: [],
      note: `Page too large for a line diff (${a.length} -> ${b.length} lines). Compare body_before and body_after directly.`,
    };
  }

  // Longest common subsequence over lines.
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "-", line: a[i++] });
    } else {
      ops.push({ op: "+", line: b[j++] });
    }
  }
  while (i < m) ops.push({ op: "-", line: a[i++] });
  while (j < n) ops.push({ op: "+", line: b[j++] });

  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;

  // Group changes into hunks with two lines of context either side.
  const CTX = 2;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.op === " ") return;
    for (let k = Math.max(0, idx - CTX); k <= Math.min(ops.length - 1, idx + CTX); k++) keep[k] = true;
  });

  const hunks = [];
  let cur = null;
  ops.forEach((o, idx) => {
    if (keep[idx]) {
      if (!cur) cur = [];
      cur.push(`${o.op}${o.line}`);
    } else if (cur) {
      hunks.push(cur);
      cur = null;
    }
  });
  if (cur) hunks.push(cur);

  return {
    truncated: false,
    lines_before: m,
    lines_after: n,
    lines_added: added,
    lines_removed: removed,
    hunks: hunks.map((h) => h.join("\n")),
  };
}
