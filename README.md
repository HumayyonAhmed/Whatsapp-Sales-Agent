# WhatsApp Sales Agent (Meta Cloud API + Groq)

A WhatsApp sales agent that answers visitor questions from a knowledge base,
qualifies them (BANT-lite: budget, use case, timeline, contact info), and
hands off **hot leads** and **escalations** to a human — with production
hardening (signature verification, dedup, rate limiting, crash safety,
graceful shutdown).

Everything about *how the agent behaves* — its goal, tone, qualifying
questions, special-case scenarios, and knowledge base — is configured in
`config/agent.json` and `config/knowledge/*.md`. You generally shouldn't
need to touch `src/` at all to customize it for a new business.

## How it works

```
WhatsApp visitor
      │
      ▼
Meta Cloud API ──POST /webhook──▶ Express server
                                      │
                                      ├─ verify Meta's signature (X-Hub-Signature-256)
                                      ├─ dedupe (ignore retried message IDs)
                                      ├─ rate-limit per visitor
                                      ├─ per-visitor lock (serialize concurrent messages)
                                      ├─ check escalation keywords → human handoff if matched
                                      ├─ else: retrieve relevant knowledge-base chunks
                                      ├─ call Groq with system prompt (config/agent.json) + KB context + history
                                      ├─ parse structured JSON: {reply, lead_update, status, is_hot_lead}
                                      ├─ send `reply` back via Cloud API
                                      └─ if hot/escalated → notify sales rep (console/Slack/WhatsApp)
```

## 1. Get your credentials

**Meta WhatsApp Cloud API**
1. Create an app at https://developers.facebook.com/apps → add "WhatsApp".
2. Grab your **Phone Number ID** and an access token from WhatsApp > API Setup.
   For production, create a permanent **System User token** (Business
   Settings > System Users) instead of the 24h temporary token.
3. Grab your **App Secret** from App > Settings > Basic — used for webhook
   signature verification.
4. **One-time step that's easy to miss:** your app also needs to be
   subscribed to your WhatsApp Business Account (WABA), separate from the
   webhook URL/verify-token config:
   ```bash
   curl -X POST "https://graph.facebook.com/v20.0/{WABA_ID}/subscribed_apps" \
     -H "Authorization: Bearer {YOUR_ACCESS_TOKEN}"
   ```
   You should get `{"success": true}`. Without this, Meta will verify your
   webhook URL fine but never actually deliver inbound messages to it.
   Find your WABA ID on the API Setup page. This is a one-time action per
   app/WABA pair — it doesn't need to be repeated on server restarts.

**Groq**
1. Get an API key at https://console.groq.com/keys
2. Check https://console.groq.com/docs/models for current model names and
   set `GROQ_MODEL` accordingly.

## 2. Install & configure

```bash
npm install
cp .env.example .env
# edit .env with your tokens, phone number id, secret, etc.
```

Then customize the agent's brain:
- **`config/agent.json`** — business description, goal, persona/tone,
  qualifying questions, hot-lead criteria, escalation keywords, handoff
  message, special-case scenarios. Edit this any time; it's picked up on
  the next incoming message with **no restart needed**.
- **`config/knowledge/*.md`** — drop in as many markdown files as you want
  (pricing, FAQ, policies, product docs...). The agent automatically
  retrieves the most relevant sections for each visitor question. No code
  changes needed to add/edit/remove files — reload is automatic (checked
  on every message), or force it immediately via the admin API (see below).

## 3. Run it

```bash
npm start
```

Starts on `PORT` (default 3000). For local dev, tunnel it:
```bash
ngrok http 3000
```

## 4. Connect the webhook in Meta

Meta App → WhatsApp → Configuration:
- **Callback URL**: `https://<your-domain-or-ngrok>/webhook`
- **Verify token**: same value as `WHATSAPP_VERIFY_TOKEN` in `.env`
- Subscribe to the **messages** field
- Don't forget step 4 above (subscribe the app to your WABA) — it's a
  separate action from this webhook config.

Message your test/business number — the agent should reply.

## Sales dashboard

Open `http://localhost:3000/` (or your deployed URL) in a browser. Log in
with your `ADMIN_API_KEY` — the same key used for the `/admin` and `/api`
routes below. **Set `ADMIN_API_KEY` before deploying, or the dashboard has
no way to log in and the API is disabled entirely.**

What it gives a sales rep:
- **Real-time inbox** — every conversation, updating live (Server-Sent
  Events) as messages come in, with unread counts and 🔥 hot-lead badges.
- **Lead pipeline** — `New → Qualified → Demo Scheduled → Demo Completed →
  Won`, with `Lost` as a separate exit. Click any stage on a conversation's
  stepper to move it there. The bot auto-advances `New → Qualified` when it
  detects a hot lead; everything past that is rep-controlled.
- **Lead profile panel** — use case, budget, timeline, email, score, and
  the bot's internal status, kept in sync as the AI learns more.
- **AI conversation summary** — a 2-3 sentence brief for a rep jumping into
  a thread mid-way, generated on demand (doesn't run automatically, so it
  doesn't burn Groq calls on every message).
- **AI-suggested replies** — drafts a reply in the configured persona for
  the rep to review/edit before sending; never sent automatically.
- **Manual takeover** — "Take over" pauses the bot for that conversation
  (or it auto-pauses the moment a rep sends a message manually); "Hand
  back to bot" resumes automated replies.
- **Full-text search** — across message content and lead profile fields.
- **Send buttons, lists, images, and PDFs** — directly from the composer,
  using the same Cloud API interactive-message support the bot itself has.
- **Analytics** — new leads, hot leads, demos booked, and conversion rate
  (Won / (Won + Lost)) over a rolling window.

The dashboard is a static frontend (`public/`) served by the same Express
server — no separate build step or deployment.

### Dashboard API reference

All routes below require `x-admin-key: <ADMIN_API_KEY>` (the dashboard adds
this automatically once you're logged in; script it yourself with curl the
same way):

```bash
GET  /api/conversations?stage=&search=      # inbox list
GET  /api/conversations/:waId                # full detail
POST /api/conversations/:waId/read           # mark read
POST /api/conversations/:waId/stage          # {stage: "Won"}
POST /api/conversations/:waId/pause
POST /api/conversations/:waId/resume
POST /api/conversations/:waId/summary        # AI-generated, cached until refreshed
POST /api/conversations/:waId/suggest-reply  # AI draft, never auto-sent
POST /api/conversations/:waId/send           # {type: "text"|"buttons"|"list", ...}
POST /api/conversations/:waId/send-media     # multipart: file, type ("image"|"document"), caption
GET  /api/media/:mediaId                     # proxied file bytes (auth'd, so the token never reaches the browser)
GET  /api/search?q=...
GET  /api/analytics?days=30
GET  /api/stream?key=...                     # Server-Sent Events (EventSource can't send headers, hence ?key=)
```

The original simpler `/admin/*` routes (`/admin/leads`, pause/resume,
reload-knowledge) still work unchanged for scripting — the dashboard just
uses the richer `/api/*` routes described above.

## Human handoff behavior

Two ways a conversation gets handed to a human:
1. **Explicit escalation** — the visitor's message matches an
   `escalation_keywords` entry in `config/agent.json` (e.g. "talk to a
   person", "refund", "complaint"). This is checked with plain keyword
   matching *before* calling the LLM, so it's deterministic — it doesn't
   depend on the model noticing.
2. **Hot lead** — the LLM itself judges a genuine buying signal per
   `hot_lead_criteria` in the config, and fires a notification (but does
   *not* pause the bot — it keeps chatting while a human also gets pinged).

Once `paused` (via escalation or `/admin/.../pause`), the bot stores
incoming messages but does not auto-reply, until resumed via the admin API.

## Lead notifications

`src/leadNotifier.js` fires for hot leads and escalations, to:
- server logs
- `NOTIFY_WEBHOOK_URL` if set (any Slack/Teams/Zapier incoming webhook)
- `SALES_REP_WHATSAPP_NUMBER` if set (a WhatsApp text alert)

## Production hardening included

- **Signature verification** — rejects webhook POSTs that aren't
  genuinely from Meta, if `WHATSAPP_APP_SECRET` is set.
- **Idempotency** — dedupes retried message IDs so a slow response doesn't
  cause a duplicate reply.
- **Rate limiting** — per-visitor cap (`RATE_LIMIT_MAX` per
  `RATE_LIMIT_WINDOW_MIN` minutes) to control abuse and cost.
- **Per-visitor locking** — concurrent messages from the same person are
  processed in order, not interleaved, avoiding lost updates.
- **Atomic storage writes** — sessions are written to a temp file then
  renamed, so a crash mid-write can't corrupt the data file.
- **Retries with backoff** — transient Groq/WhatsApp API failures (5xx,
  429, timeouts) are retried automatically; 4xx auth errors are not.
- **LLM fallback reply** — if Groq is unreachable, the visitor still gets
  a graceful message instead of silence, and the lead is flagged for
  human follow-up.
- **Session timeout** — conversation history resets after
  `session_timeout_hours` of inactivity (config), so a visitor returning
  weeks later doesn't get a stale thread fed back to the LLM; their lead
  profile is retained regardless.
- **Structured logging** (pino) instead of bare `console.log`.
- **Graceful shutdown** — finishes in-flight requests on SIGTERM/SIGINT
  instead of dropping them.

## Deployment

**Docker (recommended):**
```bash
docker compose up -d --build
```
`docker-compose.yml` mounts `./data` and `./config` as volumes, so leads
persist across redeploys and you can edit `config/agent.json` or the
knowledge base without rebuilding the image.

**PM2 (plain VPS, no Docker):**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup   # auto-restart on server reboot
```

**Managed platforms (Render/Railway/Fly):**
Connect your repo, build command `npm install`, start command `npm start`,
set the `.env` values in their dashboard. **Important:** if the platform's
filesystem is ephemeral (wiped on redeploy), attach a persistent disk/volume
mounted at `./data`, or your leads will be lost on every deploy. Point Meta's
webhook Callback URL at your platform's HTTPS URL + `/webhook`.

## Known limitations (still intentionally simple)

- File-based storage isn't safe for **multiple concurrent server
  instances** (fine for one instance, which covers most small/medium
  volume). For horizontal scaling, swap `src/store.js` for Postgres/Redis
  — the exported functions are the contract to preserve.
- Rate limiting, idempotency, and the SSE event bus are all in-memory —
  reset on restart and not shared across instances. Use Redis (pub/sub
  for events, a shared store for the rest) if you scale out.
- Knowledge-base retrieval is TF-IDF-style keyword matching, not semantic
  embeddings — works well for FAQ/pricing-style docs, but if your KB grows
  large or needs to catch heavily paraphrased questions, consider a real
  vector DB.
- The dashboard has a single shared admin key, not per-rep accounts — fine
  for a small team, but there's no per-rep audit trail of who sent what.
- AI summaries/suggestions are generated on demand, not automatically —
  intentional (keeps Groq usage/cost predictable), but means a rep has to
  click to get one rather than having it always current.
- Media messages are proxied through the server on view (no local cache),
  so viewing an old image/PDF in the dashboard makes a live call to Meta's
  Graph API each time.
