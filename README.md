# Task Hub

A small phone-friendly page for a Notion productivity system: add tasks, tick them off, start or add to today's journal entry, and see how active projects are going.

- **Page:** `index.html`, served by GitHub Pages at the custom domain in `CNAME`.
- **API:** `worker/worker.js`, a Cloudflare Worker on the route `<domain>/api/*`. It holds the Notion token and only allows the handful of actions the page needs.
- **Login:** Cloudflare Access protects the whole hostname (page and API). The Worker also checks the Access token itself and refuses anything without it.

This repo holds no secrets and no Notion IDs. Those live in the Worker's settings.

## Setup

Do the steps in this order. Each one ends with a check.

### 1. GitHub Pages

1. Upload `index.html`, `CNAME`, `README.md` and the `worker` folder to this repo's `main` branch.
2. **Settings → Pages:** Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`. Save.
3. Custom domain should already show `task.aetherliteav.com` (from `CNAME`). If not, type it and save.

### 2. Cloudflare DNS

1. **aetherliteav.com → DNS → Add record:** Type `CNAME`, Name `task`, Target `bippity-athr.github.io`, Proxy status **DNS only** (grey cloud) for now.
2. Back in GitHub **Settings → Pages**, wait for the DNS check to pass and the certificate to be issued (can take up to an hour). Then tick **Enforce HTTPS**.
3. Switch the `task` record to **Proxied** (orange cloud). Cloudflare Access and the Worker route only work on proxied records.
4. **SSL/TLS mode** must be *Full* or *Full (strict)* for this hostname. If the zone is set to *Flexible*, don't change the whole zone: add a **Configuration Rule** for hostname `task.aetherliteav.com` with SSL = Full.

Check: `https://task.aetherliteav.com` shows the page with a "server didn't answer" message. That's expected until step 5.

### 3. Notion integration

1. Go to <https://www.notion.so/profile/integrations> → **New integration** → type *Internal*, pick the workspace.
2. Capabilities: **Read content**, **Update content**, **Insert content**. No user information needed.
3. Copy the **Internal Integration Secret**. Paste it only into the Worker's secret in step 4, never into this repo or a chat.
4. In Notion, open **Productivity Hub → ••• → Connections → Add connection** and pick the integration. The three databases inherit access.

### 4. Cloudflare Access (login)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Name `Task Hub`, domain `task.aetherliteav.com` (leave path empty so it covers `/api` too). Session duration: 1 month is comfortable on a phone.
3. Policy: **Allow**, Include → **Emails** → your email address. Login method: **One-time PIN** is enough.
4. Save, then copy the application's **Audience (AUD) Tag**.
5. Note your team domain (**Zero Trust → Settings → Custom pages**, shown as `<team>.cloudflareaccess.com`).

Check: opening `https://task.aetherliteav.com` now asks for your email and a code first.

### 5. Worker (API)

1. **Workers & Pages → Create → Worker**, name it `task-hub-api`, Deploy, then **Edit code**. Replace everything with `worker/worker.js` and Deploy.
2. **Settings → Variables and Secrets**, add:

   | Name | Type | Value |
   |---|---|---|
   | `NOTION_TOKEN` | Secret | the integration secret from step 3 |
   | `TASKS_DS` | Text | Tasks data source id |
   | `PROJECTS_DS` | Text | Projects data source id |
   | `JOURNAL_DS` | Text | Journal data source id |
   | `TEAM_DOMAIN` | Text | `<team>.cloudflareaccess.com` |
   | `ACCESS_AUD` | Text | the AUD tag from step 4 |

   The three data source ids are in the setup-values file kept outside this repo.
3. **Settings → Domains & Routes → Add → Route:** `task.aetherliteav.com/api/*`, zone `aetherliteav.com`.

Check: sign in at `https://task.aetherliteav.com`. The header should say "Synced" with the time, and your tasks should appear.

## Using it

- **Android:** open the site in Chrome → ⋮ → **Add to Home screen**.
- **Reminders** can't be set through Notion's API. Open the task in the Notion app, tap **Due → Remind**.

## Troubleshooting

| Message on the page | Fix |
|---|---|
| Your sign-in has expired | Reload the page and sign in again. |
| The server isn't set up yet: … | A Worker setting from step 5 is missing. |
| Notion rejected the server's integration token | Re-copy the secret into `NOTION_TOKEN`. |
| Notion can't see the Productivity Hub | Add the integration under the Hub's **Connections** (step 3.4). |
| You're offline or the server didn't answer | Check the Worker route in step 5.3 and that the DNS record is Proxied. |
