// Confluence storage format (XHTML + ac:/ri: macros) <-> readable text.
//
// Reading is lossy on purpose: we render what a human would read and record
// which macros we saw, rather than pretending to understand every macro.
//
// Writing deliberately emits only a small, safe subset — paragraphs, headings,
// lists, tables, links, inline marks and the code macro. Round-tripping an
// unknown macro would risk corrupting a page, so we never try.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

/** Macros whose output we render faithfully enough to edit around safely. */
export const SAFE_MACROS = new Set([
  "code", "noformat", "info", "note", "warning", "tip", "panel",
  "toc", "status", "expand", "anchor", "children",
]);

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === "#") {
      const n = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

export function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, "");
const attr = (chunk, name) => {
  const m = new RegExp(`(?:ac|ri):${name}\\s*=\\s*"([^"]*)"`, "i").exec(chunk) || new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(chunk);
  return m ? decodeEntities(m[1]) : null;
};

/**
 * Render storage XHTML to text, and report what was in it.
 * @returns {{text:string, macros:string[], hrefs:string[], pageRefs:Array, mentionIds:string[], attachments:string[]}}
 */
export function parseStorage(xhtml) {
  let s = String(xhtml ?? "");
  const macros = new Set();
  const hrefs = [];
  const pageRefs = [];
  const mentionIds = new Set();
  const attachments = new Set();

  // --- code / noformat macros first: their CDATA must survive untouched -----
  s = s.replace(
    /<ac:structured-macro[^>]*ac:name="(code|noformat)"[\s\S]*?<\/ac:structured-macro>/gi,
    (m, name) => {
      macros.add(name.toLowerCase());
      const lang = /<ac:parameter[^>]*ac:name="language"[^>]*>([\s\S]*?)<\/ac:parameter>/i.exec(m)?.[1] || "";
      const cdata = /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/i.exec(m);
      const plain = cdata ? cdata[1] : decodeEntities(stripTags(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/i.exec(m)?.[1] || ""));
      return `\n\n\`\`\`${lang.trim()}\n${plain}\n\`\`\`\n\n`;
    }
  );

  // --- ac:link (page links, user mentions, attachment links) ---------------
  s = s.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi, (m, inner) => {
    const user = /<ri:user([^>]*)\/?>/i.exec(inner);
    if (user) {
      const id = attr(user[1], "account-id") || attr(user[1], "userkey") || attr(user[1], "username");
      if (id) mentionIds.add(id);
      return ` @[user:${id || "unknown"}] `;
    }
    const labelRaw =
      /<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(inner)?.[1] ??
      /<ac:link-body>([\s\S]*?)<\/ac:link-body>/i.exec(inner)?.[1] ??
      null;
    const label = labelRaw ? decodeEntities(stripTags(labelRaw)).trim() : null;

    const page = /<ri:page([^>]*)\/?>/i.exec(inner);
    if (page) {
      const title = attr(page[1], "content-title");
      const space = attr(page[1], "space-key");
      if (title) pageRefs.push({ title, space: space || null });
      return `[${label || title || "page"}](confluence-page:${space ? space + ":" : ""}${title || ""})`;
    }
    const att = /<ri:attachment([^>]*)\/?>/i.exec(inner);
    if (att) {
      const fn = attr(att[1], "filename");
      if (fn) attachments.add(fn);
      return `[attachment: ${fn || "file"}]`;
    }
    return label || decodeEntities(stripTags(inner));
  });

  // Mentions can also appear bare, outside an ac:link.
  s = s.replace(/<ri:user([^>]*)\/>/gi, (m, a) => {
    const id = attr(a, "account-id") || attr(a, "userkey") || attr(a, "username");
    if (id) mentionIds.add(id);
    return ` @[user:${id || "unknown"}] `;
  });

  // --- images and embedded attachments -------------------------------------
  s = s.replace(/<ac:image[^>]*>([\s\S]*?)<\/ac:image>/gi, (m, inner) => {
    const fn = attr(/<ri:attachment([^>]*)\/?>/i.exec(inner)?.[1] || "", "filename");
    if (fn) attachments.add(fn);
    const url = attr(/<ri:url([^>]*)\/?>/i.exec(inner)?.[1] || "", "value");
    return `[image: ${fn || url || "embedded"}]`;
  });

  // --- plain anchors --------------------------------------------------------
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
    const h = decodeEntities(href);
    hrefs.push(h);
    const label = decodeEntities(stripTags(t)).trim();
    return `[${label || h}](${h})`;
  });

  // --- remaining macros: self-closing, then bodied --------------------------
  s = s.replace(/<ac:structured-macro([^>]*)\/>/gi, (m, a) => {
    const name = attr(a, "name") || "macro";
    macros.add(name.toLowerCase());
    return `\n[macro: ${name}]\n`;
  });
  s = s.replace(/<ac:structured-macro[^>]*ac:name="([^"]+)"[\s\S]*?<\/ac:structured-macro>/gi, (m, name) => {
    macros.add(name.toLowerCase());
    const rich = /<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i.exec(m)?.[1];
    if (rich) return `\n\n[${name}] ${rich}\n\n`;
    const params = [...m.matchAll(/<ac:parameter[^>]*ac:name="([^"]+)"[^>]*>([\s\S]*?)<\/ac:parameter>/gi)]
      .map((p) => `${p[1]}=${decodeEntities(stripTags(p[2])).trim()}`)
      .join(", ");
    return `\n[macro: ${name}${params ? ` (${params})` : ""}]\n`;
  });
  s = s.replace(/<\/?ac:(?:rich-text-body|plain-text-body|parameter|layout[a-z-]*|adf[a-z-]*)[^>]*>/gi, "\n");

  // --- tables ---------------------------------------------------------------
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (m, body) => {
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) =>
        decodeEntities(stripTags(c[2])).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
      )
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill("")];
    const out = ["| " + pad(rows[0]).join(" | ") + " |", "|" + Array(width).fill(" --- ").join("|") + "|"];
    for (const r of rows.slice(1)) out.push("| " + pad(r).join(" | ") + " |");
    return "\n\n" + out.join("\n") + "\n\n";
  });

  // --- lists: innermost first, so nesting turns into indentation ------------
  for (let guard = 0; guard < 30 && /<(ul|ol)[^>]*>/i.test(s); guard++) {
    const before = s;
    s = s.replace(/<(ul|ol)[^>]*>((?:(?!<(?:ul|ol)[^>]*>)[\s\S])*?)<\/\1>/i, (m, tag, inner) => {
      let n = 0;
      const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => {
        const marker = tag.toLowerCase() === "ol" ? `${++n}.` : "-";
        const lines = x[1].trim().split("\n");
        return `${marker} ${lines[0].trim()}` + lines.slice(1).map((l) => `\n  ${l.trim()}`).join("");
      });
      return "\n" + items.join("\n") + "\n";
    });
    if (s === before) break; // malformed markup: stop rather than spin
  }

  // --- headings and block breaks -------------------------------------------
  for (let i = 6; i >= 1; i--) {
    s = s.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)</h${i}>`, "gi"), (m, t) => `\n\n${"#".repeat(i)} ${stripTags(t).trim()}\n\n`);
  }
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<(p|div|blockquote)[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|blockquote|table)>/gi, "\n\n")
    .replace(/<\/(tr|ul|ol|li)>/gi, "\n")
    .replace(/<p[^>]*\/>/gi, "\n\n");

  s = decodeEntities(stripTags(s));
  // Collapse runs of spaces inside a line, but keep leading indentation —
  // that indentation is what carries list nesting through to the reader.
  s = s
    .split("\n")
    .map((l) => l.replace(/(\S)[ \t]+/g, "$1 ").replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: s,
    macros: [...macros],
    hrefs,
    pageRefs,
    mentionIds: [...mentionIds],
    attachments: [...attachments],
  };
}

/** Convenience wrapper when only the text matters. */
export const storageToText = (xhtml) => parseStorage(xhtml).text;

/** Substitute resolved display names back into @[user:id] placeholders. */
export function applyMentionNames(text, names) {
  return String(text).replace(/@\[user:([^\]]+)\]/g, (m, id) => `@${names[id] || id}`);
}

// ---------------------------------------------------------------- writing

function inline(text) {
  let out = escapeXml(text);
  out = out.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  // Internal page links read back as confluence-page:[SPACE:]Title — restore
  // them as real ac:link elements so cross-page links survive a rewrite.
  out = out.replace(/\[([^\]]+)\]\(confluence-page:([^)]*)\)/g, (m, label, ref) => {
    const parts = String(ref).split(":");
    const space = parts.length > 1 ? parts.shift() : null;
    const title = decodeEntities(parts.join(":")).trim();
    if (!title) return label;
    const plain = decodeEntities(label).replace(/\]\]>/g, "]]]]><![CDATA[>");
    return (
      `<ac:link>${space ? `<ri:page ri:space-key="${escapeXml(space)}" ri:content-title="${escapeXml(title)}"/>` : `<ri:page ri:content-title="${escapeXml(title)}"/>`}` +
      `<ac:plain-text-link-body><![CDATA[${plain}]]></ac:plain-text-link-body></ac:link>`
    );
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => `<a href="${href}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)]|$)/g, "$1<em>$2</em>");
  return out;
}

function codeMacro(body, lang) {
  const safe = String(body).replace(/\]\]>/g, "]]]]><![CDATA[>");
  const param = lang ? `<ac:parameter ac:name="language">${escapeXml(lang)}</ac:parameter>` : "";
  return `<ac:structured-macro ac:name="code">${param}<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>`;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const BLOCK_START = /^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s|\s*\|)/;

function renderList(items) {
  // items: [{depth, ordered, text}] -> nested ul/ol
  let out = "";
  const stack = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].depth > it.depth) out += `</li></${stack.pop().tag}>`;
    if (!stack.length || stack[stack.length - 1].depth < it.depth) {
      const tag = it.ordered ? "ol" : "ul";
      stack.push({ depth: it.depth, tag });
      out += `<${tag}><li>`;
    } else {
      out += `</li><li>`;
    }
    out += inline(it.text);
  }
  while (stack.length) out += `</li></${stack.pop().tag}>`;
  return out;
}

/**
 * Markdown-ish text -> storage format. Supports paragraphs, ATX headings,
 * bullet/numbered lists (nested by indentation), pipe tables, fenced code,
 * links, bold, italic and inline code. Anything else is emitted as text.
 */
export function textToStorage(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(codeMacro(buf.join("\n"), lang));
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    if (TABLE_RE.test(line)) {
      const rows = [];
      while (i < lines.length && TABLE_RE.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const cell = (tag, v) => `<${tag}>${inline(v ?? "")}</${tag}>`;
        const body = rows
          .map((r, idx) => `<tr>${Array.from({ length: width }, (_, c) => cell(idx === 0 ? "th" : "td", r[c])).join("")}</tr>`)
          .join("");
        out.push(`<table><tbody>${body}</tbody></table>`);
      }
      continue;
    }

    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const [, indent, marker, rest] = LIST_RE.exec(lines[i]);
        items.push({
          depth: Math.floor(indent.replace(/\t/g, "  ").length / 2),
          ordered: /\d/.test(marker),
          text: rest.trim(),
        });
        i++;
      }
      // Normalise depths so the first item always opens at level 0.
      const base = Math.min(...items.map((it) => it.depth));
      out.push(renderList(items.map((it) => ({ ...it, depth: it.depth - base }))));
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  return out.join("\n") || "<p></p>";
}
