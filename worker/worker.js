// Task Hub API — Cloudflare Worker
// Runs on the route  task.<your-domain>/api/*  and talks to Notion for the page.
// Everything private lives in the Worker's settings, never in this file:
//   NOTION_TOKEN   (secret)  Notion internal integration token
//   TASKS_DS       (text)    Tasks data source id
//   PROJECTS_DS    (text)    Projects data source id
//   JOURNAL_DS     (text)    Journal data source id
//   TEAM_DOMAIN    (text)    e.g. yourteam.cloudflareaccess.com
//   ACCESS_AUD     (text)    Cloudflare Access application audience (AUD) tag
// Requests without a valid Cloudflare Access login are refused (fails closed).

const NOTION_VERSION = "2025-09-03";
const PRIORITIES = ["High", "Med", "Low"];
const MOODS = ["😄 Great", "🙂 Good", "😐 Okay", "😕 Low", "😞 Rough"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f]{32}$/;

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
      return json({ error: "server_error", message: "Unexpected error in the Worker." }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function handle(req, env) {
  for (const k of ["NOTION_TOKEN", "TASKS_DS", "PROJECTS_DS", "JOURNAL_DS", "TEAM_DOMAIN", "ACCESS_AUD"]) {
    if (!env[k]) throw new HttpError(500, "not_configured", `Worker setting ${k} is missing.`);
  }
  if (!(await verifyAccess(req, env))) throw new HttpError(401, "signed_out", "Sign-in required.");

  const url = new URL(req.url);
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "bad_origin", "Cross-site request refused.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  let m;

  if (req.method === "GET" && path === "/api/state") return json(await getState(env, url.searchParams.get("today")));
  if (req.method === "POST" && path === "/api/tasks") return json(await createTask(env, await body(req)));
  if (req.method === "PATCH" && (m = path.match(/^\/api\/tasks\/([0-9a-f]{32})$/))) return json(await setDone(env, m[1], await body(req)));
  if (req.method === "POST" && path === "/api/journal") return json(await createEntry(env, await body(req)));
  if (req.method === "POST" && (m = path.match(/^\/api\/journal\/([0-9a-f]{32})\/log$/))) return json(await appendLog(env, m[1], await body(req)));
  throw new HttpError(404, "not_found", "No such endpoint.");
}

async function body(req) {
  const text = await req.text();
  if (text.length > 8000) throw new HttpError(413, "too_large", "Request too large.");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "bad_json", "Request body is not JSON."); }
}

// ---------- Cloudflare Access JWT check ----------
let certCache = { at: 0, keys: [] };
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function verifyAccess(req, env) {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { return false; }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return false;
  if (payload.iss !== `https://${env.TEAM_DOMAIN}`) return false;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return false;
  if (Date.now() - certCache.at > 3600_000 || !certCache.keys.some((k) => k.kid === header.kid)) {
    const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!r.ok) return false;
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
}

// ---------- Notion ----------
async function notion(env, method, path, payload, retried = false) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (r.status === 429 && !retried) {
    const wait = Math.min(Number(r.headers.get("retry-after") || 1), 5) * 1000;
    await new Promise((res) => setTimeout(res, wait));
    return notion(env, method, path, payload, true);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw new HttpError(502, "notion_token", "Notion rejected the integration token.");
    if (r.status === 404) throw new HttpError(502, "notion_not_shared", "Notion can't find that item. Is the Productivity Hub shared with the integration?");
    if (r.status === 429) throw new HttpError(503, "notion_busy", "Notion is rate limiting. Try again in a moment.");
    throw new HttpError(502, "notion_error", data.message || `Notion error ${r.status}.`);
  }
  return data;
}

async function queryAll(env, ds, filter, maxPages = 10) {
  let out = [], cursor;
  for (let i = 0; i < maxPages; i++) {
    const q = { page_size: 100 };
    if (filter) q.filter = filter;
    if (cursor) q.start_cursor = cursor;
    const d = await notion(env, "POST", `/data_sources/${ds}/query`, q);
    out = out.concat(d.results || []);
    if (!d.has_more) break;
    cursor = d.next_cursor;
  }
  return out;
}

const plain = (p) => ((p && (p.title || p.rich_text)) || []).map((t) => t.plain_text).join("");
const sel = (p) => (p && p.select ? p.select.name : "");
const date = (p) => (p && p.date && p.date.start ? p.date.start.slice(0, 10) : "");
const rel = (p) => (p && p.relation ? p.relation.map((x) => x.id.replace(/-/g, "")) : []);
const pid = (page) => page.id.replace(/-/g, "");

async function getState(env, today) {
  if (!DATE_RE.test(today || "")) throw new HttpError(400, "bad_date", "Missing or invalid today=YYYY-MM-DD.");
  const [tasks, projects, journal] = await Promise.all([
    queryAll(env, env.TASKS_DS),
    queryAll(env, env.PROJECTS_DS),
    queryAll(env, env.JOURNAL_DS, { property: "Date", date: { equals: today } }, 1),
  ]);
  return {
    tasks: tasks.map((t) => ({
      id: pid(t), url: t.url, name: plain(t.properties.Name) || "Untitled",
      done: !!(t.properties.Done && t.properties.Done.checkbox), status: sel(t.properties.Status),
      prio: sel(t.properties.Priority), due: date(t.properties.Due),
      projects: rel(t.properties.Project), parent: rel(t.properties["Parent task"]),
    })),
    projects: projects.map((p) => ({
      id: pid(p), url: p.url, name: plain(p.properties.Name) || "Untitled",
      status: sel(p.properties.Status), area: sel(p.properties.Area), target: date(p.properties["Target date"]),
    })),
    journal: journal[0] ? { id: pid(journal[0]), url: journal[0].url, name: plain(journal[0].properties.Name), mood: sel(journal[0].properties.Mood) } : null,
    links: {
      tasks: dbLink(env.TASKS_DS, tasks), projects: dbLink(env.PROJECTS_DS, projects), journal: dbLink(env.JOURNAL_DS, journal),
    },
  };
}
// Link to the database the rows live in (Notion page URL of the parent database), when known.
function dbLink(_ds, rows) {
  const r = rows[0];
  const dbId = r && r.parent && (r.parent.database_id || "");
  return dbId ? "https://www.notion.so/" + dbId.replace(/-/g, "") : "";
}

async function createTask(env, b) {
  const name = String(b.name || "").trim();
  if (!name || name.length > 500) throw new HttpError(400, "bad_name", "Task name must be 1–500 characters.");
  const prio = PRIORITIES.includes(b.priority) ? b.priority : "Med";
  const props = {
    Name: { title: [{ text: { content: name } }] },
    Done: { checkbox: false },
    Status: { select: { name: "To do" } },
    Priority: { select: { name: prio } },
  };
  if (b.due) { if (!DATE_RE.test(b.due)) throw new HttpError(400, "bad_date", "Due must be YYYY-MM-DD."); props.Due = { date: { start: b.due } }; }
  if (b.project) { if (!ID_RE.test(b.project)) throw new HttpError(400, "bad_project", "Invalid project id."); props.Project = { relation: [{ id: b.project }] }; }
  const page = await notion(env, "POST", "/pages", { parent: { type: "data_source_id", data_source_id: env.TASKS_DS }, properties: props });
  return { id: pid(page), url: page.url };
}

async function setDone(env, id, b) {
  const done = !!b.done;
  await notion(env, "PATCH", `/pages/${id}`, { properties: { Done: { checkbox: done }, Status: { select: { name: done ? "Done" : "To do" } } } });
  return { ok: true };
}

const bullet = (text, bold, children) => ({
  object: "block", type: "bulleted_list_item",
  bulleted_list_item: { rich_text: text ? [{ type: "text", text: { content: text }, annotations: { bold: !!bold } }] : [], ...(children ? { children } : {}) },
});

async function createEntry(env, b) {
  if (!DATE_RE.test(b.date || "")) throw new HttpError(400, "bad_date", "Date must be YYYY-MM-DD.");
  const name = String(b.name || b.date).slice(0, 40);
  const props = { Name: { title: [{ text: { content: name } }] }, Date: { date: { start: b.date } } };
  if (b.mood) { if (!MOODS.includes(b.mood)) throw new HttpError(400, "bad_mood", "Unknown mood."); props.Mood = { select: { name: b.mood } }; }
  const children = ["Top 3 today", "Notes / log", "Wins", "Tomorrow"].map((h) => bullet(h, true, [bullet("", false)]));
  const page = await notion(env, "POST", "/pages", {
    parent: { type: "data_source_id", data_source_id: env.JOURNAL_DS },
    icon: { type: "emoji", emoji: "📓" }, properties: props, children,
  });
  return { id: pid(page), url: page.url, name, mood: b.mood || "" };
}

async function appendLog(env, id, b) {
  const line = String(b.line || "").replace(/\s+/g, " ").trim();
  if (!line || line.length > 1900) throw new HttpError(400, "bad_line", "Log line must be 1–1900 characters.");
  // Only allow appending to pages in the Journal data source.
  const page = await notion(env, "GET", `/pages/${id}`);
  const parentDs = page.parent && (page.parent.data_source_id || "").replace(/-/g, "");
  if (parentDs !== env.JOURNAL_DS.replace(/-/g, "")) throw new HttpError(403, "not_journal", "That page isn't a journal entry.");
  await notion(env, "PATCH", `/blocks/${id}/children`, { children: [bullet(line, false)] });
  return { ok: true };
}
