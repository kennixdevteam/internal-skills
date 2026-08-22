// Description and comment bodies arrive either as Atlassian Document Format
// (JSON, REST API v3) or as wiki markup (plain string, REST API v2).
// These helpers flatten both to readable text and pull out @mentions.

/** Flatten an ADF document, or pass a wiki-markup string through unchanged. */
export function bodyToText(body) {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (typeof body !== "object") return String(body);
  return adfToText(body).replace(/\n{3,}/g, "\n\n").trim();
}

function adfToText(node, depth = 0) {
  if (!node) return "";
  if (Array.isArray(node)) return node.map((n) => adfToText(n, depth)).join("");

  const kids = () => (node.content || []).map((n) => adfToText(n, depth)).join("");

  switch (node.type) {
    case "doc":
      return (node.content || []).map((n) => adfToText(n, depth)).join("\n\n");
    case "text": {
      let t = node.text || "";
      const link = (node.marks || []).find((m) => m.type === "link");
      if (link?.attrs?.href) t = `[${t}](${link.attrs.href})`;
      if ((node.marks || []).some((m) => m.type === "code")) t = `\`${t}\``;
      return t;
    }
    case "mention":
      return `@${node.attrs?.text?.replace(/^@/, "") || node.attrs?.id || "unknown"}`;
    case "emoji":
      return node.attrs?.text || node.attrs?.shortName || "";
    case "date":
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "hardBreak":
      return "\n";
    case "paragraph":
      return kids();
    case "heading":
      return `${"#".repeat(node.attrs?.level || 1)} ${kids()}`;
    case "blockquote":
      return kids()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "codeBlock":
      return "```" + (node.attrs?.language || "") + "\n" + kids() + "\n```";
    case "rule":
      return "---";
    case "bulletList":
    case "orderedList":
      return (node.content || [])
        .map((item, i) => {
          const marker = node.type === "orderedList" ? `${i + 1}.` : "-";
          const text = adfToText(item, depth + 1).trim();
          const pad = "  ".repeat(depth);
          return `${pad}${marker} ${text}`;
        })
        .join("\n");
    case "listItem":
      return (node.content || []).map((n) => adfToText(n, depth)).join("\n");
    case "taskList":
    case "taskItem":
      return (node.type === "taskItem" ? `- [${node.attrs?.state === "DONE" ? "x" : " "}] ` : "") + kids();
    case "table":
      return (node.content || []).map((r) => adfToText(r, depth)).join("\n");
    case "tableRow":
      return "| " + (node.content || []).map((c) => adfToText(c, depth).trim()).join(" | ") + " |";
    case "tableHeader":
    case "tableCell":
      return kids();
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return node.attrs?.url || "";
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return node.attrs?.alt ? `[attachment: ${node.attrs.alt}]` : "[attachment]";
    case "status":
      return `[${node.attrs?.text || ""}]`;
    case "panel":
      return kids();
    default:
      return kids();
  }
}

/**
 * Collect @mentions from either format.
 * ADF uses mention nodes; wiki markup uses [~accountid:xxx] or [~username].
 */
export function extractMentions(body) {
  const out = new Set();
  if (body == null) return [];

  if (typeof body === "string") {
    for (const m of body.matchAll(/\[~(?:accountid:)?([^\]]+)\]/g)) out.add(m[1].trim());
    for (const m of body.matchAll(/(?:^|\s)@([A-Za-z0-9._-]{2,})/g)) out.add(m[1]);
    return [...out];
  }

  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "mention") {
      out.add(n.attrs?.text?.replace(/^@/, "") || n.attrs?.id || "unknown");
    }
    if (n.content) walk(n.content);
  };
  walk(body);
  return [...out];
}

/** Build a body for a write call, matching whichever API version is in play. */
export function textToBody(text, apiVersion) {
  if (text == null) return null;
  if (apiVersion === "2") return text;
  return {
    type: "doc",
    version: 1,
    content: String(text)
      .split(/\n{2,}/)
      .map((para) => ({
        type: "paragraph",
        content: para.split("\n").flatMap((line, i) =>
          i === 0 ? [{ type: "text", text: line }] : [{ type: "hardBreak" }, { type: "text", text: line }]
        ).filter((n) => n.type !== "text" || n.text !== ""),
      }))
      .filter((p) => p.content.length > 0),
  };
}
