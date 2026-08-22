// Custom field ids (sprint, epic link, customer tag, ...) differ per Jira
// instance, so they are discovered at runtime from /rest/api/{v}/field
// rather than hard-coded. Override any of them with env vars if the
// heuristics pick the wrong field.

let cache = null;

const CUSTOM = {
  sprint: "com.pyxis.greenhopper.jira:gh-sprint",
  epicLink: "com.pyxis.greenhopper.jira:gh-epic-link",
  epicName: "com.pyxis.greenhopper.jira:gh-epic-label",
};

export async function getFieldMap(client) {
  if (cache) return cache;

  const fields = await client.api("GET", "/field");
  const byId = new Map();
  for (const f of fields) byId.set(f.id, f);

  const find = (pred) => fields.find(pred)?.id || null;
  const custom = (key) => find((f) => f.schema?.custom === key);
  const named = (re) => find((f) => f.custom && re.test(f.name || ""));

  // Customer tag has no standard schema key, so match by name and allow
  // several fields to qualify (e.g. "Customer", "Customer Tag", "Client").
  const customerIds = process.env.JIRA_CUSTOMER_TAG_FIELD
    ? process.env.JIRA_CUSTOMER_TAG_FIELD.split(",").map((s) => s.trim()).filter(Boolean)
    : fields.filter((f) => f.custom && /customer|client|tenant/i.test(f.name || "")).map((f) => f.id);

  cache = {
    sprint: process.env.JIRA_SPRINT_FIELD || custom(CUSTOM.sprint) || named(/^sprints?$/i),
    epicLink: process.env.JIRA_EPIC_LINK_FIELD || custom(CUSTOM.epicLink) || named(/^epic\s*link$/i),
    epicName: custom(CUSTOM.epicName) || named(/^epic\s*name$/i),
    storyPoints: named(/story\s*points?/i),
    customer: customerIds,
    byId,
    names: Object.fromEntries(fields.map((f) => [f.id, f.name])),
    all: fields.map((f) => ({ id: f.id, name: f.name, custom: !!f.custom, schema: f.schema?.type })),
  };
  return cache;
}

/**
 * Sprint values come back either as objects (modern) or as toString'd Java
 * beans like `...Sprint@1a2b[id=12,state=ACTIVE,name=Sprint 5,...]` (older
 * Data Center). Normalise both.
 */
export function parseSprints(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((s) => {
      if (s && typeof s === "object") {
        return {
          id: s.id ?? null,
          name: s.name ?? null,
          state: s.state ?? null,
          startDate: s.startDate ?? null,
          endDate: s.endDate ?? null,
          boardId: s.boardId ?? s.originBoardId ?? null,
        };
      }
      if (typeof s !== "string") return null;
      const inner = s.slice(s.indexOf("[") + 1, s.lastIndexOf("]"));
      const attrs = {};
      for (const part of inner.split(",")) {
        const eq = part.indexOf("=");
        if (eq > 0) attrs[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
      const nn = (v) => (v && v !== "<null>" && v !== "null" ? v : null);
      return {
        id: nn(attrs.id),
        name: nn(attrs.name),
        state: nn(attrs.state),
        startDate: nn(attrs.startDate),
        endDate: nn(attrs.endDate),
        boardId: nn(attrs.rapidViewId),
      };
    })
    .filter(Boolean);
}

/** Custom field values are options, arrays, users or scalars — flatten to text. */
export function flattenValue(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(flattenValue).filter((x) => x != null);
  if (typeof v === "object") {
    return v.value ?? v.name ?? v.displayName ?? v.key ?? v.id ?? null;
  }
  return v;
}
