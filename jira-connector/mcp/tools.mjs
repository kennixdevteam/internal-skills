// Tool definitions and handlers.
//
// Read tools are unrestricted. Writes are limited to three verbs — create,
// comment, update — and update is deliberately split into preview + apply so
// the user always sees the exact diff before anything is written. There is no
// delete tool, and none should ever be added; see README.md.

import { createHash } from "node:crypto";
import { bodyToText, textToBody } from "./adf.mjs";
import { getFieldMap } from "./fields.mjs";
import { normaliseIssue, summarise, ISSUE_FIELDS, ISSUE_EXPAND } from "./issue.mjs";

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const pendingUpdates = new Map(); // token -> {key, payload, transition, diff, expires}

const jqlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function prunePreviews() {
  const now = Date.now();
  for (const [t, p] of pendingUpdates) if (p.expires < now) pendingUpdates.delete(t);
}

async function fetchIssue(client, key, { comments = true } = {}) {
  const raw = await client.api("GET", `/issue/${encodeURIComponent(key)}`, {
    query: { fields: ISSUE_FIELDS, expand: ISSUE_EXPAND },
  });
  return normaliseIssue(client, raw, { includeComments: comments });
}

const SEARCH_FIELDS = ["summary", "status", "issuetype", "assignee"];

// Ask Jira how many issues a JQL matches without pulling them. Cloud's
// /search/jql dropped `total`, so this is the only way to know the real size
// there; on builds that lack the endpoint we just report null.
async function approximateCount(client, jql) {
  try {
    const res = await client.api("POST", "/search/approximate-count", { body: { jql } });
    return Number.isFinite(res?.count) ? res.count : null;
  } catch {
    return null;
  }
}

// Returns { issues, total, next_cursor, truncated }.
//
// `truncated` is the important one: a caller that gets 200 issues back must be
// able to tell "that is all of them" from "that is the first page of 3000",
// otherwise it will summarise a slice and present it as the whole picture.
// The cursor is opaque to callers — a nextPageToken on v3, a startAt on v2.
async function searchIssues(client, jql, limit = 50, cursor = null) {
  const v = await client.apiVersion();
  const capped = Math.min(Number(limit) || 50, 200);

  // v3 moved search to POST /search/jql with a nextPageToken; v2 uses /search.
  if (v === "3") {
    try {
      const res = await client.api("POST", "/search/jql", {
        body: {
          jql,
          maxResults: capped,
          fields: SEARCH_FIELDS,
          ...(cursor ? { nextPageToken: String(cursor) } : {}),
        },
      });
      const issues = res.issues || [];
      const nextCursor = res.nextPageToken || null;
      let total = Number.isFinite(res.total) ? res.total : null;
      if (total === null && nextCursor) total = await approximateCount(client, jql);
      return {
        issues,
        total,
        next_cursor: nextCursor,
        truncated: Boolean(nextCursor) || res.isLast === false,
      };
    } catch {
      // Older Cloud/DC builds still serve the legacy endpoint.
    }
  }

  const startAt = Number(cursor) || 0;
  const res = await client.api("POST", "/search", {
    body: { jql, startAt, maxResults: capped, fields: SEARCH_FIELDS },
  });
  const issues = res.issues || [];
  const total = Number.isFinite(res.total) ? res.total : null;
  const seen = startAt + issues.length;
  const more = total === null ? issues.length === capped : seen < total;
  return {
    issues,
    total,
    next_cursor: more ? seen : null,
    truncated: more,
  };
}

async function epicChildren(client, epicKey, limit = 200) {
  // The Agile API knows about epics on both Cloud and Data Center.
  try {
    const res = await client.agile("GET", `/epic/${encodeURIComponent(epicKey)}/issue`, {
      query: { maxResults: Math.min(limit, 200), fields: "summary,status,issuetype,assignee" },
    });
    if (res?.issues?.length) return res.issues;
  } catch {
    // Fall through to JQL.
  }
  const map = await getFieldMap(client);
  const clauses = [`parent = ${jqlStr(epicKey)}`];
  if (map.epicLink) clauses.unshift(`${jqlStr("Epic Link")} = ${jqlStr(epicKey)}`);
  for (const jql of clauses) {
    try {
      const { issues } = await searchIssues(client, jql, limit);
      if (issues.length) return issues;
    } catch {
      // Try the next form.
    }
  }
  return [];
}

async function issueTree(client, key, { maxDepth = 4, maxIssues = 200 } = {}) {
  const root = await fetchIssue(client, key);

  // Walk upward through parents so the full context of the ticket is visible.
  const ancestors = [];
  const seen = new Set([root.key]);
  let cursor = root.parent?.key;
  while (cursor && ancestors.length < maxDepth && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = await fetchIssue(client, cursor, { comments: false });
    ancestors.push({
      key: parent.key,
      summary: parent.summary,
      type: parent.issue_type,
      status: parent.status,
      url: parent.url,
      description: parent.description,
      sprints: parent.sprints,
      customer_tags: parent.customer_tags,
    });
    cursor = parent.parent?.key;
  }

  // Walk downward. An epic expands to every ticket it contains.
  let children = [];
  let childSource = null;
  if ((root.issue_type || "").toLowerCase() === "epic") {
    children = (await epicChildren(client, root.key, maxIssues)).map((r) => summarise(client, r));
    childSource = "epic";
  } else if (root.subtasks.length) {
    children = root.subtasks.map((s) => ({ ...s, url: client.browseUrl(s.key) }));
    childSource = "subtasks";
  } else {
    try {
      const found = await searchIssues(client, `parent = ${jqlStr(root.key)}`, maxIssues);
      children = found.issues.map((r) => summarise(client, r));
      childSource = children.length ? "parent-query" : null;
    } catch {
      children = [];
    }
  }

  return {
    issue: root,
    ancestors,
    ancestor_count: ancestors.length,
    children,
    child_count: children.length,
    child_source: childSource,
    truncated: children.length >= maxIssues,
  };
}

// ---------------------------------------------------------------- writes

const FIELD_ALIASES = {
  summary: "summary",
  description: "description",
  labels: "labels",
  assignee: "assignee",
  priority: "priority",
  due_date: "duedate",
  duedate: "duedate",
  components: "components",
  fix_versions: "fixVersions",
  fixversions: "fixVersions",
  story_points: "__storyPoints",
  environment: "environment",
};

async function resolveFieldId(client, name) {
  const key = String(name).toLowerCase();
  if (key.startsWith("customfield_")) return name;
  const alias = FIELD_ALIASES[key];
  if (alias === "__storyPoints") {
    const map = await getFieldMap(client);
    if (!map.storyPoints) throw new Error("This Jira has no Story Points field");
    return map.storyPoints;
  }
  if (alias) return alias;
  // Fall back to matching a custom field by its display name.
  const map = await getFieldMap(client);
  const hit = map.all.find((f) => (f.name || "").toLowerCase() === key);
  if (hit) return hit.id;
  throw new Error(`Unknown field "${name}". Call jira_list_fields to see what this instance offers.`);
}

async function coerceValue(client, fieldId, value) {
  const v = await client.apiVersion();
  switch (fieldId) {
    case "description":
    case "environment":
      return textToBody(value, v);
    case "labels":
      return Array.isArray(value) ? value : String(value).split(/[,\s]+/).filter(Boolean);
    case "assignee":
      if (value === null) return null;
      return v === "3" ? { accountId: String(value) } : { name: String(value) };
    case "priority":
      return { name: String(value) };
    case "components":
    case "fixVersions":
      return (Array.isArray(value) ? value : [value]).map((n) => (typeof n === "string" ? { name: n } : n));
    default:
      return value;
  }
}

function displayCurrent(raw, fieldId) {
  const cur = raw.fields?.[fieldId];
  if (cur == null) return null;
  if (fieldId === "description" || fieldId === "environment") return bodyToText(cur);
  if (Array.isArray(cur)) return cur.map((x) => (typeof x === "object" ? x.name ?? x.value ?? x.key ?? x : x));
  if (typeof cur === "object") return cur.name ?? cur.value ?? cur.displayName ?? cur.key ?? cur;
  return cur;
}

async function previewUpdate(client, { key, fields = {}, transition_to }) {
  if (!Object.keys(fields).length && !transition_to) {
    throw new Error("Nothing to preview: pass fields, transition_to, or both.");
  }
  const raw = await client.api("GET", `/issue/${encodeURIComponent(key)}`, { query: { fields: ISSUE_FIELDS } });

  const payload = {};
  const diff = [];
  for (const [name, newValue] of Object.entries(fields)) {
    const id = await resolveFieldId(client, name);
    payload[id] = await coerceValue(client, id, newValue);
    diff.push({ field: name, field_id: id, current: displayCurrent(raw, id), proposed: newValue });
  }

  let transition = null;
  if (transition_to) {
    const { transitions = [] } = await client.api("GET", `/issue/${encodeURIComponent(key)}/transitions`);
    const hit = transitions.find(
      (t) =>
        t.name.toLowerCase() === String(transition_to).toLowerCase() ||
        t.to?.name?.toLowerCase() === String(transition_to).toLowerCase()
    );
    if (!hit) {
      throw new Error(
        `No transition to "${transition_to}" from status "${raw.fields?.status?.name}". ` +
          `Available: ${transitions.map((t) => t.to?.name || t.name).join(", ") || "none"}`
      );
    }
    transition = { id: hit.id, name: hit.to?.name || hit.name };
    diff.push({ field: "status", field_id: "status", current: raw.fields?.status?.name || null, proposed: transition.name });
  }

  prunePreviews();
  const token = createHash("sha256")
    .update(JSON.stringify({ key, payload, transition, at: raw.fields?.updated }))
    .digest("hex")
    .slice(0, 20);
  pendingUpdates.set(token, { key, payload, transition, diff, expires: Date.now() + PREVIEW_TTL_MS });

  return {
    key,
    url: client.browseUrl(key),
    summary: raw.fields?.summary || null,
    changes: diff,
    change_token: token,
    written: false,
    next_step:
      "Nothing has been written. Show these changes to the user verbatim and get their explicit approval, " +
      "then call jira_apply_update with this change_token and confirm=true. If the user wants anything " +
      "different, call jira_preview_update again — never edit the token.",
    expires_in_minutes: PREVIEW_TTL_MS / 60000,
  };
}

async function applyUpdate(client, { key, change_token, confirm }) {
  prunePreviews();
  if (confirm !== true) {
    throw new Error("Refusing to write: confirm must be true, and only after the user has approved the previewed diff.");
  }
  const pending = pendingUpdates.get(change_token);
  if (!pending) {
    throw new Error("Unknown or expired change_token. Call jira_preview_update again and re-confirm with the user.");
  }
  if (pending.key !== key) {
    throw new Error(`change_token belongs to ${pending.key}, not ${key}.`);
  }

  const applied = [];
  if (Object.keys(pending.payload).length) {
    await client.api("PUT", `/issue/${encodeURIComponent(key)}`, { body: { fields: pending.payload } });
    applied.push(...Object.keys(pending.payload));
  }
  if (pending.transition) {
    await client.api("POST", `/issue/${encodeURIComponent(key)}/transitions`, {
      body: { transition: { id: pending.transition.id } },
    });
    applied.push(`status -> ${pending.transition.name}`);
  }
  pendingUpdates.delete(change_token);

  return { key, url: client.browseUrl(key), written: true, applied, changes: pending.diff };
}

async function createIssue(client, args) {
  const v = await client.apiVersion();
  const map = await getFieldMap(client);
  const fields = {
    project: { key: args.project_key },
    issuetype: { name: args.issue_type },
    summary: args.summary,
  };
  if (args.description != null) fields.description = textToBody(args.description, v);
  if (args.labels?.length) fields.labels = args.labels;
  if (args.priority) fields.priority = { name: args.priority };
  if (args.components?.length) fields.components = args.components.map((n) => ({ name: n }));
  if (args.assignee) fields.assignee = v === "3" ? { accountId: args.assignee } : { name: args.assignee };
  for (const [id, value] of Object.entries(args.custom_fields || {})) fields[id] = value;

  const post = (body) => client.api("POST", "/issue", { body });
  let created;
  if (args.parent_key) {
    try {
      created = await post({ fields: { ...fields, parent: { key: args.parent_key } } });
    } catch (err) {
      // Company-managed projects reject `parent` for epics; they want Epic Link.
      if (!map.epicLink) throw err;
      created = await post({ fields: { ...fields, [map.epicLink]: args.parent_key } });
    }
  } else {
    created = await post({ fields });
  }
  return { key: created.key, url: client.browseUrl(created.key), written: true, parent: args.parent_key || null };
}

// ---------------------------------------------------------------- registry

export const TOOLS = [
  {
    name: "jira_whoami",
    description:
      "Check the Jira connection and report the authenticated user, base URL and detected REST API version. Use this first if anything looks misconfigured.",
    inputSchema: { type: "object", properties: {} },
    handler: async (client) => {
      const me = await client.api("GET", "/myself");
      return {
        base_url: client.base.toString(),
        api_version: await client.apiVersion(),
        account: me.displayName || me.name,
        account_id: me.accountId || me.key || me.name,
        email: me.emailAddress || null,
        read_only_mode: client.readOnly,
      };
    },
  },
  {
    name: "jira_get_issue",
    description:
      "Read one Jira issue in full: description, status, assignee, reporter, priority, labels, components, fix versions, sprints, customer tags, story points, parent, subtasks, issue links, comments, @mentions, attachment metadata, and every populated custom field.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key, e.g. PROJ-123" },
        include_comments: { type: "boolean", description: "Include the comment thread (default true)" },
      },
      required: ["key"],
    },
    handler: (client, a) => fetchIssue(client, a.key, { comments: a.include_comments !== false }),
  },
  {
    name: "jira_get_issue_tree",
    description:
      "Read an issue together with its surrounding context in one call: the full parent chain upward, and children downward. If the key is an Epic, every ticket in the epic is listed. This is the default way to read a ticket when parents or child tickets matter.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key, e.g. PROJ-123" },
        max_depth: { type: "number", description: "How far up the parent chain to walk (default 4)" },
        max_issues: { type: "number", description: "Cap on children returned (default 200)" },
      },
      required: ["key"],
    },
    handler: (client, a) => issueTree(client, a.key, { maxDepth: a.max_depth ?? 4, maxIssues: a.max_issues ?? 200 }),
  },
  {
    name: "jira_get_epic_children",
    description: "List every ticket belonging to an epic.",
    inputSchema: {
      type: "object",
      properties: {
        epic_key: { type: "string", description: "Epic issue key" },
        limit: { type: "number", description: "Max issues to return (default 200)" },
      },
      required: ["epic_key"],
    },
    handler: async (client, a) => {
      const issues = await epicChildren(client, a.epic_key, a.limit ?? 200);
      return { epic_key: a.epic_key, count: issues.length, issues: issues.map((r) => summarise(client, r)) };
    },
  },
  {
    name: "jira_search",
    description:
      "Run a JQL query and return matching issues in summary form (no description or comments). " +
      "Always check `total` and `truncated` in the result: one page is capped at 200 issues, so a " +
      "broad query returns a slice, not the whole answer. When `truncated` is true, narrow the JQL " +
      "rather than paging, unless you genuinely need the full key list; to page, pass `next_cursor` " +
      "back in as `cursor`.",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string", description: 'JQL, e.g. project in ("ABC","DEF") AND text ~ "timeout"' },
        limit: { type: "number", description: "Max results per page (default 50, cap 200)" },
        cursor: {
          type: ["string", "number"],
          description: "Opaque page cursor: pass the `next_cursor` from the previous result. Omit for the first page.",
        },
      },
      required: ["jql"],
    },
    handler: async (client, a) => {
      const res = await searchIssues(client, a.jql, a.limit ?? 50, a.cursor ?? null);
      return {
        jql: a.jql,
        count: res.issues.length,
        total: res.total,
        truncated: res.truncated,
        next_cursor: res.next_cursor,
        ...(res.truncated
          ? {
              note:
                `Only ${res.issues.length} issue(s) returned` +
                (res.total === null ? "" : ` out of ${res.total} matching`) +
                ". Narrow the JQL (resolution IS NOT EMPTY, updated >= -12M, component, a tighter " +
                "phrase) instead of summarising this page as if it were the whole result. " +
                "Pass next_cursor as `cursor` only if you need the full key list.",
            }
          : {}),
        issues: res.issues.map((r) => summarise(client, r)),
      };
    },
  },
  {
    name: "jira_get_transitions",
    description: "List the status transitions currently available on an issue.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    handler: async (client, a) => {
      const { transitions = [] } = await client.api("GET", `/issue/${encodeURIComponent(a.key)}/transitions`);
      return { key: a.key, transitions: transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name })) };
    },
  },
  {
    name: "jira_list_fields",
    description:
      "List this instance's fields and their ids. Use it to find the real custom field id for sprint, customer tag, or anything else before reading or writing it.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string", description: "Case-insensitive substring match on field name" } },
    },
    handler: async (client, a) => {
      const map = await getFieldMap(client);
      const all = a.filter
        ? map.all.filter((f) => (f.name || "").toLowerCase().includes(a.filter.toLowerCase()))
        : map.all;
      return {
        detected: {
          sprint: map.sprint,
          epic_link: map.epicLink,
          epic_name: map.epicName,
          story_points: map.storyPoints,
          customer_tag: map.customer,
        },
        count: all.length,
        fields: all,
      };
    },
  },
  {
    name: "jira_create_issue",
    description:
      "Create a new Jira issue. Only call this when the user has explicitly asked for a ticket to be created. Never invent field values — ask the user for anything you do not have.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        issue_type: { type: "string", description: 'e.g. "Task", "Story", "Bug", "Sub-task"' },
        summary: { type: "string" },
        description: { type: "string" },
        parent_key: { type: "string", description: "Parent issue or epic key" },
        labels: { type: "array", items: { type: "string" } },
        priority: { type: "string" },
        components: { type: "array", items: { type: "string" } },
        assignee: { type: "string", description: "accountId on Cloud, username on Data Center" },
        custom_fields: { type: "object", description: 'Raw custom field values keyed by id, e.g. {"customfield_10010": "..."}' },
      },
      required: ["project_key", "issue_type", "summary"],
    },
    handler: (client, a) => createIssue(client, a),
  },
  {
    name: "jira_add_comment",
    description: "Add a comment to an issue. Only call this when the user has explicitly asked you to comment.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, body: { type: "string" } },
      required: ["key", "body"],
    },
    handler: async (client, a) => {
      const v = await client.apiVersion();
      const res = await client.api("POST", `/issue/${encodeURIComponent(a.key)}/comment`, {
        body: { body: textToBody(a.body, v) },
      });
      return { key: a.key, url: client.browseUrl(a.key), comment_id: res.id, written: true };
    },
  },
  {
    name: "jira_preview_update",
    description:
      "STEP 1 OF 2 — writes nothing. Computes the exact before/after diff for a proposed change and returns a change_token. You MUST show the diff to the user and get their explicit approval before calling jira_apply_update. Always start here; jira_apply_update cannot run without a token from this tool.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        fields: {
          type: "object",
          description:
            'Fields to change, by friendly name or custom field id, e.g. {"summary": "...", "labels": ["a"], "customfield_10010": 5}',
        },
        transition_to: { type: "string", description: 'Target status name, e.g. "In Progress"' },
      },
      required: ["key"],
    },
    handler: (client, a) => previewUpdate(client, a),
  },
  {
    name: "jira_apply_update",
    description:
      "STEP 2 OF 2 — writes to Jira. Only call this after jira_preview_update returned a diff AND the user has explicitly approved that exact diff. Requires the change_token from the preview and confirm=true. Do not call it on your own initiative.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        change_token: { type: "string", description: "Token returned by jira_preview_update" },
        confirm: { type: "boolean", description: "Must be true, and only after the user approved the diff" },
      },
      required: ["key", "change_token", "confirm"],
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
