// Turns a raw Jira issue payload into a flat, complete record. "Complete" is
// the point: every non-empty custom field is carried through under its human
// name, so nothing on the ticket is silently dropped.

import { bodyToText, extractMentions } from "./adf.mjs";
import { getFieldMap, parseSprints, flattenValue } from "./fields.mjs";

const user = (u) =>
  u ? { name: u.displayName || u.name, id: u.accountId || u.key || u.name, email: u.emailAddress || null, active: u.active } : null;

const named = (o) => (o ? o.name ?? o.value ?? null : null);

/** Fields to request. `*all` keeps custom fields; comments come via expand. */
export const ISSUE_FIELDS = "*all";
export const ISSUE_EXPAND = "names,renderedFields,changelog";

export async function normaliseIssue(client, raw, { includeComments = true } = {}) {
  const map = await getFieldMap(client);
  const f = raw.fields || {};

  const comments = includeComments
    ? (f.comment?.comments || []).map((c) => ({
        id: c.id,
        author: user(c.author)?.name,
        created: c.created,
        updated: c.updated !== c.created ? c.updated : undefined,
        visibility: c.visibility?.value || null,
        body: bodyToText(c.body),
        mentions: extractMentions(c.body),
      }))
    : [];

  const descriptionMentions = extractMentions(f.description);
  const allMentions = [...new Set([...descriptionMentions, ...comments.flatMap((c) => c.mentions)])];

  // Parent is either a real parent link (subtask / team-managed child) or the
  // classic Epic Link custom field.
  let parent = null;
  if (f.parent) {
    parent = {
      key: f.parent.key,
      summary: f.parent.fields?.summary || null,
      type: f.parent.fields?.issuetype?.name || null,
      status: f.parent.fields?.status?.name || null,
      via: "parent",
    };
  } else if (map.epicLink && f[map.epicLink]) {
    parent = { key: f[map.epicLink], summary: null, type: "Epic", status: null, via: "epic-link" };
  }

  const customerTags = map.customer
    .map((id) => flattenValue(f[id]))
    .filter((v) => v != null && (!Array.isArray(v) || v.length))
    .flat();

  // Anything custom and non-empty that we have not already surfaced.
  const surfaced = new Set([map.sprint, map.epicLink, map.epicName, map.storyPoints, ...map.customer]);
  const otherCustomFields = {};
  for (const [id, value] of Object.entries(f)) {
    if (!id.startsWith("customfield_") || surfaced.has(id)) continue;
    const flat = flattenValue(value);
    if (flat == null || (Array.isArray(flat) && !flat.length)) continue;
    otherCustomFields[raw.names?.[id] || map.names[id] || id] = flat;
  }

  return {
    key: raw.key,
    id: raw.id,
    url: client.browseUrl(raw.key),
    summary: f.summary || null,
    description: bodyToText(f.description),
    issue_type: f.issuetype?.name || null,
    is_subtask: !!f.issuetype?.subtask,
    status: f.status?.name || null,
    status_category: f.status?.statusCategory?.name || null,
    resolution: named(f.resolution),
    resolved_at: f.resolutiondate || null,
    priority: named(f.priority),
    project: f.project ? { key: f.project.key, name: f.project.name } : null,

    assignee: user(f.assignee),
    reporter: user(f.reporter),
    creator: user(f.creator),

    labels: f.labels || [],
    components: (f.components || []).map(named),
    fix_versions: (f.fixVersions || []).map(named),
    affects_versions: (f.versions || []).map(named),

    sprints: map.sprint ? parseSprints(f[map.sprint]) : [],
    epic_name: map.epicName ? f[map.epicName] || null : null,
    story_points: map.storyPoints ? f[map.storyPoints] ?? null : null,
    customer_tags: customerTags,

    parent,
    subtasks: (f.subtasks || []).map((s) => ({
      key: s.key,
      summary: s.fields?.summary || null,
      status: s.fields?.status?.name || null,
      type: s.fields?.issuetype?.name || null,
    })),

    // Issue links, flattened so direction is explicit rather than nested.
    links: (f.issuelinks || []).map((l) => {
      const outward = !!l.outwardIssue;
      const other = l.outwardIssue || l.inwardIssue;
      return {
        relation: outward ? l.type?.outward : l.type?.inward,
        direction: outward ? "outward" : "inward",
        key: other?.key,
        summary: other?.fields?.summary || null,
        status: other?.fields?.status?.name || null,
        type: other?.fields?.issuetype?.name || null,
      };
    }),

    // Metadata only — this server never downloads or re-uploads attachments.
    attachments: (f.attachment || []).map((a) => ({
      filename: a.filename,
      size_bytes: a.size,
      mime_type: a.mimeType,
      author: user(a.author)?.name,
      created: a.created,
    })),

    comments,
    comment_count: f.comment?.total ?? comments.length,
    mentions: allMentions,

    watchers: f.watches?.watchCount ?? null,
    votes: f.votes?.votes ?? null,
    due_date: f.duedate || null,
    created: f.created || null,
    updated: f.updated || null,
    time_tracking: f.timetracking?.originalEstimate
      ? {
          original_estimate: f.timetracking.originalEstimate,
          remaining_estimate: f.timetracking.remainingEstimate,
          time_spent: f.timetracking.timeSpent,
        }
      : null,

    custom_fields: otherCustomFields,
  };
}

/** Compact form used for tree nodes and search hits. */
export function summarise(client, raw) {
  const f = raw.fields || {};
  return {
    key: raw.key,
    summary: f.summary || null,
    type: f.issuetype?.name || null,
    status: f.status?.name || null,
    assignee: f.assignee?.displayName || null,
    url: client.browseUrl(raw.key),
  };
}
