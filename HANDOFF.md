# WhatsApp Sales Agent — Technical Handoff

This document is a complete technical briefing on a WhatsApp sales/lead-qualification
bot **plus a real-time sales dashboard**, intended to bring another AI (or developer)
fully up to speed with zero prior context. It covers what was built, why, the exact
architecture, every file's responsibility, the data model, all configuration surfaces,
known limitations, and where to pick up next.

> **Revision note:** this app started as bot-only (webhook → LLM → reply). A dashboard
> was added afterward without touching the AI reply pipeline (`groq.js`'s
> `getAgentReply`/system-prompt logic is unchanged). The additions are: message-level
> history (was: just `{role, content}` pairs, now: ids/timestamps/media), a rep-facing
> `stage` pipeline distinct from the bot's internal `lead.status`, a REST+SSE API
> (`src/dashboard.js`), and a vanilla-JS frontend (`public/`) served statically by the
> same Express server. Everything in this doc reflects the *current* state, not the
> bot-only starting point.

---

## 1. What this app does

A WhatsApp bot that:
1. Receives inbound WhatsApp messages via **Meta's WhatsApp Cloud API**.
2. Answers visitor questions using an **LLM (Groq API)** grounded in a **markdown
   knowledge base** (pricing, FAQ, policies — extensible).
3. **Qualifies leads** conversationally (BANT-lite: use case, budget, timeline,
   contact info) — one question at a time, not an interrogation.
4. **Scores leads** (0–100) and tracks a status pipeline:
   `new → engaged → qualified → hot → escalated → customer`.
5. **Hands off to a human** in two ways:
   - Deterministically, via keyword matching (e.g. "talk to a person", "refund"),
     checked *before* the LLM runs — doesn't depend on model judgment.
   - Via LLM judgment when it detects genuine buying signals (marks `is_hot_lead`).
6. **Notifies a human** (console log + optional Slack/Teams webhook + optional
   WhatsApp text) when a lead goes hot or escalates.
7. Is **fully re-configurable without code changes**: business info, sales goal,
   tone, qualifying questions, escalation rules, and the entire knowledge base live
   in `config/` and are hot-reloaded (no restart) when edited.
8. Gives a sales team a **real-time dashboard** (`public/`, served at `/`) with:
   a live inbox (Server-Sent Events push), a rep-facing lead pipeline
   (`New → Qualified → Demo Scheduled → Demo Completed → Won`, plus `Lost`),
   full-text search, on-demand AI conversation summaries, on-demand AI reply
   suggestions (never auto-sent), manual takeover/resume, and the ability for a
   rep to send text, buttons, lists, images, and PDFs directly from the browser.

Built for: small/medium business sales triage — the bot handles first contact and
qualification, a human closes the sale using the dashboard.

---

## 2. Architecture / request lifecycle

```
WhatsApp visitor sends a message
        │
        ▼
Meta WhatsApp Cloud API ──POST /webhook──▶ Express server (src/server.js)
        │
        ├─ 1. verifyMetaSignature() — HMAC-SHA256 check using WHATSAPP_APP_SECRET
        │      (X-Hub-Signature-256 header). Skipped w/ warning if secret unset.
        │
        ├─ 2. res.sendStatus(200) immediately — ack fast so Meta doesn't retry/dup
        │
        ├─ 3. isDuplicate(message.id) — idempotency.js in-memory Set w/ 10min TTL
        │      dedupes Meta's own retried deliveries
        │
        ├─ 4. rateLimitAllow(waId) — rateLimiter.js token-bucket per visitor
        │      (RATE_LIMIT_MAX per RATE_LIMIT_WINDOW_MIN), drops if exceeded
        │
        ├─ 5. withUserLock(waId, handleMessage) — lock.js promise-chain mutex,
        │      serializes concurrent messages from the SAME visitor only
        │
        └─ 6. handleMessage(waId, message):
              │
              ├─ getSession(waId) — store.js, file-based, loads/creates session
              │
              ├─ session timeout check — if now - lastActivity > config
              │     session_timeout_hours, wipe session.history (NOT lead profile)
              │
              ├─ if session.paused (human already took over) → store message,
              │     do NOT call LLM, do NOT auto-reply, return
              │
              ├─ escalation keyword check (cfg.escalation_keywords, plain
              │     substring match, case-insensitive) — if matched:
              │       → set session.paused = true, lead.status = "escalated"
              │       → send cfg.handoff_message directly (NO LLM call)
              │       → notifyHotLead(reason: "Escalation requested")
              │       → save + return
              │
              ├─ else: knowledgeBase.retrieve(userMessage, k=3) — TF-IDF-style
              │     keyword scoring over config/knowledge/*.md chunks
              │
              ├─ groq.getAgentReply({history, userMessage, currentLead}):
              │     → builds system prompt from config/agent.json + KB context
              │     → POSTs to Groq (OpenAI-compatible /chat/completions,
              │        response_format: json_object)
              │     → retries on 429/5xx/timeout (2 retries, exponential backoff)
              │     → on total failure: groq.fallbackReply() — graceful message,
              │        marks lead "escalated" instead of leaving visitor silent
              │     → parses model's JSON: {reply, lead_update, status,
              │        is_hot_lead, internal_note}
              │
              ├─ merge lead_update into session.lead (only non-null fields,
              │     so partial info across turns doesn't overwrite prior data)
              │
              ├─ scoreLead() — deterministic 0-100 score: profile completeness
              │     (name/email/use_case/budget/timeline, 15-20pts each) + 15pts
              │     if LLM flagged is_hot_lead
              │
              ├─ sendText(waId, reply) — whatsapp.js, Graph API call w/ retry
              │
              ├─ if is_hot_lead && !session.alertedHot (fire once per session):
              │     → notifyHotLead() — console + optional Slack webhook +
              │        optional WhatsApp alert to sales rep
              │
              └─ saveSession(waId, session) — store.js, atomic write
                    (temp file + rename) to data/sessions.json
```

Separately, admin operators can hit `src/admin.js` routes (protected by
`ADMIN_API_KEY` header) to view leads, manually pause/resume the bot per
conversation (human takeover), or force a knowledge-base reload.

---

## 3. File-by-file reference

```
whatsapp-sales-agent/
├── config/
│   ├── agent.json              # THE BRAIN — business info, goal, persona,
│   │                            qualifying questions, hot-lead criteria,
│   │                            escalation keywords, handoff message,
│   │                            scenario-specific instructions, session
│   │                            timeout. Hot-reloaded via configLoader.js
│   │                            (mtime check, no restart needed).
│   └── knowledge/*.md          # THE KNOWLEDGE BASE — any number of markdown
│                                 files. Chunked by ## heading, retrieved via
│                                 TF-IDF-style scoring in knowledgeBase.js.
│                                 Add/edit/remove files freely; auto-detected
│                                 via mtime fingerprint on next retrieval, or
│                                 force-reload via POST /admin/reload-knowledge.
│
├── src/
│   ├── server.js                # Express app. Webhook GET (verify) + POST
│   │                              (receive). Mounts /admin, /api, and static
│   │                              public/ (the dashboard). Stores EVERY
│   │                              inbound message (text or media) via
│   │                              store.appendMessage; non-text media is
│   │                              stored for the rep but does NOT trigger an
│   │                              auto-reply (dashboard is the safety net).
│   │                              Auto-advances stage New→Qualified on a
│   │                              hot-lead signal. Emits SSE events via
│   │                              events.js after every state change. Also:
│   │                              /health, graceful shutdown, crash handlers.
│   │
│   ├── groq.js                  # LLM integration — UNCHANGED core logic
│   │                              (buildSystemPrompt/getAgentReply/
│   │                              fallbackReply) from before the dashboard.
│   │                              ADDED: summarizeConversation(history) and
│   │                              suggestReply(history, lead) — separate,
│   │                              on-demand calls used only by the
│   │                              dashboard's Summarize/Suggest-reply
│   │                              buttons, never by the automated pipeline.
│   │                              Now uses shared retry.js instead of its
│   │                              own copy of the backoff logic.
│   │
│   ├── whatsapp.js               # Meta Cloud API client. sendText(),
│   │                              sendButtons(). ADDED: sendList() (interactive
│   │                              list messages), uploadMedia()/sendImageById()/
│   │                              sendDocumentById() (rep sending images/PDFs
│   │                              from the dashboard), downloadMedia() (proxying
│   │                              media bytes back to the dashboard for preview,
│   │                              so the Meta access token never reaches the
│   │                              browser). Uses Node's built-in FormData/Blob
│   │                              globals for multipart upload — no extra
│   │                              dependency. Now uses shared retry.js.
│   │
│   ├── retry.js                  # NEW — withRetry() extracted from groq.js/
│   │                              whatsapp.js's previously-duplicated backoff
│   │                              logic. Retries 429/5xx/timeout, not 4xx.
│   │
│   ├── knowledgeBase.js          # Unchanged by the dashboard work. Zero-dependency
│   │                              retrieval — reads config/knowledge/*.md, splits
│   │                              on markdown headings, TF-IDF-style scoring.
│   │                              retrieve(query, k) / reload().
│   │
│   ├── configLoader.js           # Unchanged. Reads config/agent.json, hot-reload
│   │                              via mtime check.
│   │
│   ├── store.js                  # SIGNIFICANTLY EXPANDED. Session/lead persistence,
│   │                              still file-based + atomic writes. Schema now
│   │                              includes: message-level history (id, role,
│   │                              content, timestamp, type, mediaId, caption,
│   │                              filename — was just {role, content}), a
│   │                              rep-facing `stage` field + `stageHistory` audit
│   │                              trail (separate from the bot's `lead.status`),
│   │                              `unreadCount`/`lastReadAt`, `summary`/
│   │                              `summaryUpdatedAt`. New exports: appendMessage(),
│   │                              setStage(), listConversations() (inbox view,
│   │                              richer than the old listLeads()),
│   │                              searchConversations() (full-text), getAnalytics().
│   │                              `listLeads` kept as an alias to
│   │                              listConversations() for backward compatibility
│   │                              with src/admin.js. STILL single-instance only
│   │                              (see Limitations) — this is the swap point for
│   │                              Postgres/Redis if you scale out.
│   │
│   ├── leadNotifier.js           # Unchanged. notifyHotLead({waId, lead,
│   │                              internalNote, reason}).
│   │
│   ├── auth.js                   # NEW — requireAdminKey middleware, shared
│   │                              between admin.js and dashboard.js. Accepts the
│   │                              key via `x-admin-key` header OR `?key=` query
│   │                              param (the latter needed because browsers'
│   │                              EventSource/SSE can't send custom headers).
│   │                              404s (not 401) if ADMIN_API_KEY is unset.
│   │
│   ├── events.js                 # NEW — tiny EventEmitter-based pub/sub.
│   │                              emitConversationEvent(waId, payload) is called
│   │                              from server.js and dashboard.js after any
│   │                              state change; dashboard.js's /api/stream SSE
│   │                              route subscribes and pushes to connected
│   │                              browser tabs. Chosen over WebSockets to avoid
│   │                              an extra dependency — plain HTTP, one-directional
│   │                              "something changed" signal is all the dashboard
│   │                              needs (it refetches on event, doesn't rely on
│   │                              the event payload as source of truth).
│   │
│   ├── dashboard.js               # NEW — the dashboard's REST + SSE API, mounted
│   │                              at /api. All routes behind requireAdminKey.
│   │                              GET  /api/conversations?stage=&search=
│   │                              GET  /api/conversations/:waId
│   │                              POST /api/conversations/:waId/read
│   │                              POST /api/conversations/:waId/stage
│   │                              POST /api/conversations/:waId/pause|resume
│   │                              POST /api/conversations/:waId/summary          (calls groq.summarizeConversation)
│   │                              POST /api/conversations/:waId/suggest-reply    (calls groq.suggestReply)
│   │                              POST /api/conversations/:waId/send            (text/buttons/list; auto-pauses)
│   │                              POST /api/conversations/:waId/send-media      (multipart upload via multer; auto-pauses)
│   │                              GET  /api/media/:mediaId                      (auth'd proxy, streams Graph API bytes)
│   │                              GET  /api/search?q=
│   │                              GET  /api/analytics?days=
│   │                              GET  /api/stages
│   │                              GET  /api/stream                              (SSE)
│   │                              Uses multer (memoryStorage, 16MB limit) for
│   │                              file uploads — no disk writes, buffer goes
│   │                              straight to whatsapp.uploadMedia().
│   │
│   ├── admin.js                  # UNCHANGED, still works. Simpler scriptable API
│   │                              (mounted at /admin): GET /leads, GET /leads/:waId,
│   │                              POST /leads/:waId/pause|resume, POST
│   │                              /reload-knowledge. Now imports requireAdminKey
│   │                              from auth.js instead of its own inline copy.
│   │                              The dashboard frontend does NOT use these routes
│   │                              — it uses the richer /api/* ones — but they're
│   │                              kept for existing scripts/curl usage.
│   │
│   ├── rateLimiter.js            # Unchanged. In-memory per-visitor token bucket.
│   │
│   ├── idempotency.js            # Unchanged. In-memory seen-message-id dedup.
│   │
│   ├── lock.js                   # Unchanged. Per-waId promise-chain mutex.
│   │
│   └── logger.js                 # Unchanged. pino structured logger.
│
├── public/                        # NEW — the dashboard frontend. Plain HTML/CSS/JS,
│   │                                no build step, no framework — served directly
│   │                                by express.static() in server.js. Deliberately
│   │                                matches the project's zero-toolchain philosophy.
│   ├── index.html                 # Single-page shell: login gate, 3-pane layout
│   │                                (left rail: brand/analytics/stage filters,
│   │                                middle: inbox list, right: conversation pane +
│   │                                lead drawer), plus a modal overlay for the
│   │                                buttons/list composer.
│   ├── css/style.css              # Design tokens: a "control room" dark palette
│   │                                where color carries fixed meaning — coral/
│   │                                --signal ONLY means urgency (hot/unread),
│   │                                blue/--ai-accent ONLY marks AI-generated
│   │                                content (summary bar, suggest-reply button).
│   │                                Type: IBM Plex Mono for data (timestamps,
│   │                                stage tags, counters), Inter for conversation
│   │                                content — the split is intentional signal, not
│   │                                decoration. The stage stepper is the one
│   │                                deliberately "designed" signature element
│   │                                (a real pipeline, so a sequence/stepper is
│   │                                actually justified here, not just decorative
│   │                                numbering).
│   └── js/app.js                  # All frontend logic (~500 lines, no modules/
│                                    bundler — one file, organized by section
│                                    comment headers). sessionStorage holds the
│                                    admin key (fine — this is the user's own
│                                    real browser, not a sandboxed artifact
│                                    environment). Talks to /api/* via fetch()
│                                    with x-admin-key header; opens an
│                                    EventSource to /api/stream?key=... for
│                                    real-time updates (on any event, just
│                                    refetches the inbox + open conversation —
│                                    simple over clever, avoids client-side
│                                    state-merge bugs).
│
├── package.json                  # deps: axios, dotenv, express, multer, pino

├── .env.example                   # all required/optional env vars, documented
├── Dockerfile                     # node:22-slim, npm ci --omit=dev, VOLUME
│                                    for /app/data
├── docker-compose.yml             # mounts ./data and ./config as volumes
├── ecosystem.config.js            # PM2 config, alternative to Docker
├── README.md                      # setup, deployment, admin API usage,
│                                    the WABA-subscription gotcha, limitations
└── data/sessions.json             # runtime-created, gitignored — the
                                     actual lead/conversation database
```

---

## 4. Data model

`data/sessions.json` — a flat object keyed by WhatsApp ID (`waId`, e.g. a phone
number without `+`), each value shaped:

```json
{
  "<waId>": {
    "history": [
      {
        "id": "d7d6075fbff91350",
        "role": "user",           // user (visitor) | assistant (bot) | agent (human rep)
        "content": "...",
        "type": "text",            // text | image | document | audio | video | location | unsupported
        "mediaId": null,           // Meta media id, when type isn't text
        "caption": null,
        "filename": null,
        "timestamp": 1234567890000
      }
    ],                                  // capped at 500 stored (MAX_STORED_MESSAGES);
                                         // only the last 16 are fed back into the LLM prompt (MAX_HISTORY_MESSAGES)
    "lead": {
      "name": null, "email": null, "budget": null, "timeline": null, "use_case": null,
      "status": "new",                 // INTERNAL AI pipeline: new|engaged|qualified|hot|escalated|customer
      "score": 0                       // 0-100, deterministic formula in server.js
    },
    "stage": "New",                    // REP-FACING sales pipeline: New|Qualified|Demo Scheduled|Demo Completed|Won|Lost
    "stageHistory": [ { "stage": "New", "at": 1234567890000 } ],  // audit trail, feeds analytics
    "paused": false,                   // true = human has taken over, bot silent
    "alertedHot": false,                // ensures hot-lead notification fires once
    "unreadCount": 0,                  // dashboard inbox unread badge; reset via POST .../read
    "lastReadAt": 1234567890000,
    "summary": null,                    // AI-generated, on-demand (dashboard "Summarize" button)
    "summaryUpdatedAt": null,
    "createdAt": 1234567890000,
    "updatedAt": 1234567890000,
    "lastActivity": 1234567890000       // drives session_timeout_hours reset
  }
}
```

**Two separate pipelines, on purpose:** `lead.status` is the bot's own internal
read of the conversation (used to build the LLM prompt context and decide when to
fire a hot-lead notification) — the AI updates it every turn. `stage` is what the
dashboard and rep actually manage — the bot only ever auto-advances it once
(`New → Qualified` on a hot-lead signal); `Demo Scheduled`, `Demo Completed`,
`Won`, and `Lost` are exclusively rep-driven via the dashboard's stage stepper.
Keeping these separate meant the existing AI logic needed zero changes to support
a sales-pipeline view that has different states than the AI's own vocabulary.

**Lead score formula** (`scoreLead()` in `server.js`, unchanged since before the
dashboard): name +15, email +20, use_case +15, budget +20, timeline +15, is_hot_lead
flag +15 (capped at 100).

---

## 5. `config/agent.json` schema (the primary customization surface)

```json
{
  "business": { "name": "...", "description": "..." },
  "goal": "free text — the agent's north star objective",
  "persona": { "tone": "...", "style_notes": "..." },
  "qualifying_questions": [ { "id": "budget", "ask": "..." }, ... ],
  "hot_lead_criteria": "free text describing what counts as a buying signal",
  "escalation_keywords": ["human", "refund", "complaint", ...],
  "handoff_message": "what the bot says verbatim when escalating",
  "scenarios": [ { "when": "...", "instruction": "..." }, ... ],
  "session_timeout_hours": 12
}
```

All of this is interpolated directly into the LLM system prompt in
`groq.js:buildSystemPrompt()`. `escalation_keywords` and `handoff_message` are
ALSO used directly in `server.js` for the deterministic (non-LLM) handoff path —
this is intentional duplication: the config is single-sourced, but consumed in
two different ways (semantic guidance to the LLM, and exact-match code logic) for
different reliability guarantees.

---

## 6. Knowledge base mechanism (`knowledgeBase.js`)

- No external embeddings API, no vector DB dependency — pure JS TF-IDF-style
  scoring, chosen deliberately to keep the app zero-extra-infra and avoid native
  build dependencies (see Section 8 for why `better-sqlite3` was rejected).
- Files in `config/knowledge/*.md` are split into chunks at each markdown
  heading (`##`/`###`). Each chunk is tokenized (lowercased, stopwords
  stripped), term frequencies computed, and an inverse-document-frequency
  weight computed across all chunks.
- `retrieve(query, k)` tokenizes the user's message, scores every chunk by
  summed `tf * idf` over matching terms, returns the top-k chunk texts (only
  chunks with score > 0).
- Index is rebuilt automatically when any file's mtime changes (checked cheaply
  via `fs.statSync` fingerprint on every `retrieve()` call) — no restart needed
  to add/edit KB content. `reload()` forces an immediate rebuild (used by the
  admin endpoint, mostly redundant given the automatic check, but useful to
  force it right after a deploy).
- **Known ceiling**: works well for FAQ/pricing-style docs matched on
  vocabulary overlap. Will not handle heavily paraphrased questions with very
  different wording than the source docs, and doesn't scale gracefully much
  past a few dozen pages. Upgrade path: swap for a real vector store
  (pgvector, Pinecone, Weaviate) behind the same `retrieve(query, k)` interface.

---

## 7. Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `WHATSAPP_TOKEN` | Meta access token (use a permanent System User token in prod) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Phone Number ID (not the WABA ID) |
| `WHATSAPP_VERIFY_TOKEN` | Shared secret for GET /webhook handshake |
| `WHATSAPP_API_VERSION` | Graph API version, e.g. `v20.0` |
| `WHATSAPP_APP_SECRET` | Enables HMAC signature verification on POST /webhook; skipped w/ warning if blank |
| `GROQ_API_KEY` | Groq API key |
| `GROQ_API_URL` | Default `https://api.groq.com/openai/v1/chat/completions` |
| `GROQ_MODEL` | Default `llama-3.3-70b-versatile` — check console.groq.com/docs/models |
| `NOTIFY_WEBHOOK_URL` | Optional Slack/Teams/Zapier incoming webhook for hot-lead/escalation alerts |
| `SALES_REP_WHATSAPP_NUMBER` | Optional — also sends alerts as a WhatsApp text |
| `ADMIN_API_KEY` | Enables `/admin/*` and `/api/*` (dashboard) routes; unset = both 404/disabled, and the dashboard has no way to log in |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MIN` | Per-visitor rate limit, default 20 per 10 min |
| `LOG_LEVEL` | pino log level, default `info` |
| `PORT` | Server port, default 3000 |

Business/behavior config (name, goal, tone, questions, etc.) is **deliberately
NOT in `.env`** — it lives in `config/agent.json` instead, since it's meant to
be edited more like content than infrastructure config.

---

## 8. Design decisions worth knowing (and why)

- **Groq, not xAI's "Grok"** — early confusion in this project's history; the
  user meant the Groq low-latency inference API (OpenAI-compatible endpoint),
  not xAI's Grok model. Confirmed and corrected; `src/groq.js` targets
  `api.groq.com`.
- **File-based storage, hardened, not a database** — `better-sqlite3` was
  tested and rejected: it requires native compilation (node-gyp) and failed to
  install in a sandboxed/restricted-network test environment; broader risk of
  failing on minimal/serverless deploy targets. `node:sqlite` (Node 22+ built-in)
  was also tested and works, but is still experimental and version-gated. The
  chosen approach — plain JSON file + atomic rename-on-write + in-process
  per-visitor mutex — has zero native dependencies and "just works" on any
  Node ≥18 host, at the cost of not being safe for multi-instance horizontal
  scaling (single-instance only, documented as a known limitation).
- **Deterministic escalation before the LLM call** — hot-lead detection is
  left to the LLM's judgment (probabilistic, fine for a "nice to have" signal),
  but explicit "get me a human" requests are matched via plain keyword
  substring checks in code, executed *before* any LLM call. This guarantees a
  human handoff always fires on the literal words configured, independent of
  model behavior/mood — treated as a reliability-critical path, not left to
  prompt-following.
- **Ack-then-process pattern** — `POST /webhook` calls `res.sendStatus(200)`
  immediately, before any processing, matching Meta's expectation of a fast
  ack to avoid webhook retries; all actual work happens after, wrapped in
  try/catch so a downstream failure never surfaces as an HTTP error back to
  Meta (which would trigger unwanted retries/duplicate processing).
- **Hot-reloadable config via mtime check, not file-watchers** — chose a
  cheap `fs.statSync` fingerprint check on each relevant operation over
  `fs.watch()`/chokidar, to avoid platform-specific file-watching quirks
  (especially on Docker volumes / some Windows setups) and an extra
  dependency, at the cost of at-most-one-request staleness, which is
  irrelevant in practice.

---

## 9. Known limitations / explicitly out of scope

- No horizontal scaling: file-based store + in-memory rate limiter/idempotency
  cache/SSE event bus are all single-process/single-instance. Documented swap
  points: `store.js` → Postgres/Redis; rate limiter/idempotency → Redis; SSE
  event bus → Redis pub/sub (or a hosted push service) if running multiple
  server instances behind a load balancer.
- Single shared `ADMIN_API_KEY` for the whole dashboard — no per-rep accounts,
  no audit trail of which specific rep sent a manual message (the message is
  attributed to role `"agent"` generically).
- Groq JSON-mode responses (the automated reply pipeline) are defensively
  parsed with a fallback path (`parseAgentJson`), but there's no schema
  validation library (e.g. zod) — a malformed-but-parseable JSON object from
  the model could technically slip through with unexpected field types. The
  dashboard's summary/suggest-reply calls use plain-text completions instead
  of JSON mode, so this risk doesn't apply to them.
- Media proxying (`GET /api/media/:mediaId`) makes a live authenticated call
  to Meta's Graph API on every view — no local caching, so repeatedly opening
  an old image is a bit slow and uses API quota.
- Knowledge-base retrieval is TF-IDF keyword matching (see Section 6) — no
  semantic/embedding search.
- No outbound proactive messaging (only reacts to inbound within Meta's
  session-window rules, plus rep-initiated manual sends) — no drip campaigns,
  no scheduled re-engagement.

## 10. Natural next steps (if asked "what should we build next")

- Swap `store.js` for Postgres if/when running multiple instances (also
  solves the SSE/rate-limit/idempotency single-instance limitations at once
  if paired with Redis pub/sub).
- Add schema validation (zod) around the Groq JSON response in the automated
  pipeline.
- Per-rep dashboard accounts/audit trail instead of one shared admin key.
- Cache proxied media locally (or point the dashboard at signed URLs) to cut
  down on repeated Graph API calls.
- Add semantic (embedding-based) retrieval if the knowledge base grows large
  or needs to handle heavily paraphrased queries.
- Outbound/proactive messaging (e.g. auto re-engage a stale Qualified lead
  after N days, respecting Meta's messaging-window/template-message rules).
- Auto-generate a fresh summary in the background after N new messages,
  instead of purely on-demand, if reps end up wanting it always current.
