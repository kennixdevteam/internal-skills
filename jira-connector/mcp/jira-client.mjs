// HTTP layer for the intranet Jira.
//
// Two hard guarantees, enforced here rather than in prompts:
//   1. Every request must land on the host configured in JIRA_BASE_URL.
//      Redirects are never followed, so a 302 cannot walk us off-host.
//   2. DELETE is not a permitted method. There is no code path that emits one.

import { log } from "./rpc.mjs";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT"]);
const TIMEOUT_MS = Number(process.env.JIRA_TIMEOUT_MS || 30000);

export class JiraError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class JiraClient {
  constructor(env = process.env) {
    const raw = env.JIRA_BASE_URL;
    if (!raw) throw new Error("JIRA_BASE_URL is not set");

    let base;
    try {
      base = new URL(raw.replace(/\/+$/, "") + "/");
    } catch {
      throw new Error(`JIRA_BASE_URL is not a valid URL: ${raw}`);
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new Error(`JIRA_BASE_URL must be http(s), got ${base.protocol}`);
    }

    this.base = base;
    this.allowedHost = base.host; // host includes the port
    this.readOnly = env.JIRA_READONLY === "1";

    const token = env.JIRA_TOKEN;
    if (!token) throw new Error("JIRA_TOKEN is not set");
    this.auth = env.JIRA_EMAIL
      ? "Basic " + Buffer.from(`${env.JIRA_EMAIL}:${token}`).toString("base64")
      : `Bearer ${token}`;

    this._apiVersion = null; // "3" | "2", resolved on first use
  }

  browseUrl(key) {
    return new URL(`browse/${encodeURIComponent(key)}`, this.base).toString();
  }

  /** Resolve whether this instance speaks REST API v3 or v2. Cached. */
  async apiVersion() {
    if (this._apiVersion) return this._apiVersion;
    for (const v of ["3", "2"]) {
      try {
        await this.request("GET", `/rest/api/${v}/myself`);
        this._apiVersion = v;
        log(`[jira] using REST API v${v} at ${this.allowedHost}`);
        return v;
      } catch (err) {
        if (err instanceof JiraError && (err.status === 401 || err.status === 403)) {
          throw new Error(
            `Authentication failed (HTTP ${err.status}). Check JIRA_TOKEN` +
              (process.env.JIRA_EMAIL ? " and JIRA_EMAIL." : " — for Jira Cloud you must also set JIRA_EMAIL.")
          );
        }
        // 404 / 405 means this version is not served here; try the next.
      }
    }
    throw new Error(`Neither /rest/api/3 nor /rest/api/2 responded at ${this.allowedHost}`);
  }

  /** Path against the versioned REST API, e.g. api("/issue/ABC-1"). */
  async api(method, path, opts = {}) {
    const v = await this.apiVersion();
    return this.request(method, `/rest/api/${v}${path}`, opts);
  }

  /** Path against the Agile API, which serves sprint and epic data. */
  async agile(method, path, opts = {}) {
    return this.request(method, `/rest/agile/1.0${path}`, opts);
  }

  async request(method, path, { query, body } = {}) {
    const upper = method.toUpperCase();
    if (!ALLOWED_METHODS.has(upper)) {
      // This is the structural block on deletion.
      throw new Error(`HTTP method ${upper} is blocked by this server (allowed: GET, POST, PUT)`);
    }
    if (this.readOnly && upper !== "GET") {
      throw new Error(`JIRA_READONLY=1 — refusing ${upper} ${path}`);
    }

    const url = new URL(path.replace(/^\//, ""), this.base);
    if (url.host !== this.allowedHost) {
      throw new Error(`Refusing request to ${url.host}: only ${this.allowedHost} is allowed`);
    }
    for (const [k, val] of Object.entries(query || {})) {
      if (val !== undefined && val !== null) url.searchParams.set(k, String(val));
    }

    let res;
    try {
      res = await fetch(url, {
        method: upper,
        redirect: "manual", // a redirect could point off-host; treat it as an error
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: this.auth,
          Accept: "application/json",
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
          `Check that JIRA_BASE_URL is exact.`
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
          ? [...(parsed.errorMessages || []), ...Object.values(parsed.errors || {})].join("; ")
          : String(parsed || "").slice(0, 400);
      throw new JiraError(`HTTP ${res.status} ${upper} ${path}${detail ? ` — ${detail}` : ""}`, res.status, parsed);
    }
    return parsed;
  }
}
