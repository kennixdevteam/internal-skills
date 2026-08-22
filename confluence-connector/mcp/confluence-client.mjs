// HTTP layer for the intranet Confluence.
//
// Four hard guarantees, enforced here rather than in prompts:
//   1. Every request must land on the host configured in CONFLUENCE_BASE_URL.
//      Redirects are never followed, so a 302 cannot walk us off-host.
//   2. DELETE is not a permitted method. There is no code path that emits one.
//   3. Confluence does not need DELETE to destroy a page — PUT-ing
//      status:"trashed" or "archived" is enough. Any request body carrying such
//      a status, at any depth, is refused.
//   4. Paths that trash, purge, change restrictions, or download attachment
//      bytes are refused regardless of method.

import { log } from "./rpc.mjs";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT"]);
const TIMEOUT_MS = Number(process.env.CONFLUENCE_TIMEOUT_MS || 30000);

// Statuses that take content out of circulation. Setting any of them is a
// deletion by another name.
const FORBIDDEN_STATUS = new Set(["trashed", "archived", "historical", "deleted"]);

const FORBIDDEN_PATHS = [
  /\/trash(\b|\/)/i,
  /\/restriction/i,
  /\/child\/attachment\/[^/]+\/data/i, // attachment bytes
  /\/download\/(attachments|thumbnails)\//i,
  /\/rest\/api\/content\/blueprint\/instance\/[^/]+\/purge/i,
];

/** Recursively refuse a payload that would trash or archive content. */
function assertNoDestructiveStatus(node, path = "body") {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoDestructiveStatus(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.toLowerCase() === "status" && typeof v === "string" && FORBIDDEN_STATUS.has(v.toLowerCase())) {
      throw new Error(
        `Refusing to send ${path}.${k}="${v}" — this connector never trashes, archives or deletes Confluence content.`
      );
    }
    assertNoDestructiveStatus(v, `${path}.${k}`);
  }
}

export class ConfluenceError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class ConfluenceClient {
  constructor(env = process.env) {
    const raw = env.CONFLUENCE_BASE_URL;
    if (!raw) throw new Error("CONFLUENCE_BASE_URL is not set");

    let base;
    try {
      base = new URL(raw.replace(/\/+$/, "") + "/");
    } catch {
      throw new Error(`CONFLUENCE_BASE_URL is not a valid URL: ${raw}`);
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new Error(`CONFLUENCE_BASE_URL must be http(s), got ${base.protocol}`);
    }

    this.base = base;
    this.allowedHost = base.host; // host includes the port
    this.readOnly = env.CONFLUENCE_READONLY === "1";

    const token = env.CONFLUENCE_TOKEN;
    if (!token) throw new Error("CONFLUENCE_TOKEN is not set");
    this.auth = env.CONFLUENCE_EMAIL
      ? "Basic " + Buffer.from(`${env.CONFLUENCE_EMAIL}:${token}`).toString("base64")
      : `Bearer ${token}`;

    this._prefix = null; // "/rest/api" (Server/DC) or "/wiki/rest/api" (Cloud)
  }

  /**
   * Resolve which REST prefix this deployment serves. Data Center and Server
   * mount Confluence at /rest/api; Cloud mounts it under /wiki. Cached.
   */
  async prefix() {
    if (this._prefix) return this._prefix;
    let lastErr;
    for (const p of ["/rest/api", "/wiki/rest/api"]) {
      for (const probe of ["/user/current", "/space?limit=1"]) {
        try {
          await this.request("GET", p + probe);
          this._prefix = p;
          log(`[confluence] using ${p} at ${this.allowedHost}`);
          return p;
        } catch (err) {
          lastErr = err;
          if (err instanceof ConfluenceError && (err.status === 401 || err.status === 403)) {
            throw new Error(
              `Authentication failed (HTTP ${err.status}). Check CONFLUENCE_TOKEN` +
                (process.env.CONFLUENCE_EMAIL ? " and CONFLUENCE_EMAIL." : " — for Confluence Cloud you must also set CONFLUENCE_EMAIL.")
            );
          }
          // 404 / 405 means this prefix is not served here; try the next.
        }
      }
    }
    throw new Error(
      `Neither /rest/api nor /wiki/rest/api responded at ${this.allowedHost}` +
        (lastErr ? ` (last error: ${lastErr.message})` : "")
    );
  }

  /** Path against the versioned REST API, e.g. api("GET", "/content/123"). */
  async api(method, path, opts = {}) {
    const p = await this.prefix();
    return this.request(method, `${p}${path}`, opts);
  }

  /** Absolute browser URL for a page, always on the allowed host. */
  pageUrl(raw) {
    const webui = raw?._links?.webui;
    if (webui) {
      try {
        return new URL(String(webui).replace(/^\//, ""), this.base).toString();
      } catch {
        /* fall through */
      }
    }
    if (raw?.id) return new URL(`pages/viewpage.action?pageId=${encodeURIComponent(raw.id)}`, this.base).toString();
    return this.base.toString();
  }

  /**
   * Turn a user-supplied target into something we can fetch.
   * Accepts a numeric page id, a URL on the allowed host, or "SPACE:Title".
   */
  parseTarget(input) {
    const s = String(input ?? "").trim();
    if (!s) return { kind: "invalid", raw: input };
    if (/^\d+$/.test(s)) return { kind: "id", id: s };

    if (/^https?:\/\//i.test(s)) {
      let u;
      try {
        u = new URL(s);
      } catch {
        return { kind: "invalid", raw: s };
      }
      if (u.host !== this.allowedHost) return { kind: "external", url: s, host: u.host };
      return this.parsePath(u);
    }

    if (s.startsWith("/")) {
      try {
        return this.parsePath(new URL(s.replace(/^\//, ""), this.base));
      } catch {
        return { kind: "invalid", raw: s };
      }
    }

    const m = /^([A-Za-z0-9~._-]+):(.+)$/.exec(s);
    if (m) return { kind: "title", space: m[1], title: m[2].trim() };
    return { kind: "invalid", raw: s };
  }

  parsePath(u) {
    const q = u.searchParams.get("pageId");
    if (q && /^\d+$/.test(q)) return { kind: "id", id: q };

    let m = /\/pages\/(\d+)(?:\/|$)/.exec(u.pathname);
    if (m) return { kind: "id", id: m[1] };

    m = /\/(?:display|spaces)\/([^/?#]+)\/([^/?#]+)/.exec(u.pathname);
    if (m && m[2] !== "pages") {
      return {
        kind: "title",
        space: decodeURIComponent(m[1]),
        title: decodeURIComponent(m[2].replace(/\+/g, " ")),
      };
    }

    m = /\/(?:display|spaces)\/([^/?#]+)\/?$/.exec(u.pathname);
    if (m) return { kind: "space", space: decodeURIComponent(m[1]) };

    return { kind: "unknown", url: u.toString() };
  }

  async request(method, path, { query, body } = {}) {
    const upper = method.toUpperCase();
    if (!ALLOWED_METHODS.has(upper)) {
      // This is the structural block on deletion.
      throw new Error(`HTTP method ${upper} is blocked by this server (allowed: GET, POST, PUT)`);
    }
    if (this.readOnly && upper !== "GET") {
      throw new Error(`CONFLUENCE_READONLY=1 — refusing ${upper} ${path}`);
    }

    const url = new URL(path.replace(/^\//, ""), this.base);
    if (url.host !== this.allowedHost) {
      throw new Error(`Refusing request to ${url.host}: only ${this.allowedHost} is allowed`);
    }
    for (const [k, val] of Object.entries(query || {})) {
      if (val !== undefined && val !== null) url.searchParams.set(k, String(val));
    }

    const full = url.pathname + url.search;
    for (const re of FORBIDDEN_PATHS) {
      if (re.test(full)) throw new Error(`Refusing ${upper} ${url.pathname}: this endpoint is blocked by this server`);
    }
    if ((url.searchParams.get("status") || "") && FORBIDDEN_STATUS.has(url.searchParams.get("status").toLowerCase())) {
      throw new Error(`Refusing a request with status=${url.searchParams.get("status")}`);
    }
    if (body !== undefined) assertNoDestructiveStatus(body);

    let res;
    try {
      res = await fetch(url, {
        method: upper,
        redirect: "manual", // a redirect could point off-host; treat it as an error
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: this.auth,
          Accept: "application/json",
          "X-Atlassian-Token": "no-check",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (err.name === "TimeoutError") throw new Error(`Timed out after ${TIMEOUT_MS}ms: ${upper} ${path}`);
      throw new Error(`Cannot reach ${this.allowedHost}: ${err.message}`);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `Refusing to follow redirect (HTTP ${res.status} -> ${res.headers.get("location")}). ` +
          `Check that CONFLUENCE_BASE_URL is exact.`
      );
    }

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object"
          ? parsed.message || (parsed.errors || []).map((e) => e.message?.translation || e.title).join("; ")
          : String(parsed || "").slice(0, 400);
      throw new ConfluenceError(`HTTP ${res.status} ${upper} ${path}${detail ? ` — ${detail}` : ""}`, res.status, parsed);
    }
    return parsed;
  }
}

export const __test = { assertNoDestructiveStatus, FORBIDDEN_PATHS, FORBIDDEN_STATUS };
