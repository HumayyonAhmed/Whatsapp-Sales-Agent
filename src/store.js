// File-based session/lead store, hardened with atomic writes (write to a
// temp file then rename) so a crash mid-write can't corrupt the DB file.
// Combine with src/lock.js (per-visitor serialization) to avoid lost
// updates. Swap this module for Postgres/Redis if you need multi-instance
// deployment — keep these exported function signatures as the contract.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");
const { getConfig } = require("./configLoader");

const DB_PATH = path.join(__dirname, "..", "data", "sessions.json");

const STAGES = ["New", "Qualified", "Demo Scheduled", "Demo Completed", "Won", "Lost"];

function loadAll() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") logger.error({ err }, "Failed to read sessions.json, starting fresh");
    return {};
  }
}

function saveAll(db) {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH); // atomic on the same filesystem
}

function emptySession() {
  const now = Date.now();
  const cfg = getConfig();
  const lead = {};
  for (const field of (cfg.lead_fields || [])) {
    lead[field.id] = null;
  }
  lead.status = "new"; // internal AI pipeline: new -> engaged -> qualified -> hot -> escalated -> customer
  lead.score = 0;

  return {
    history: [], // [{id, role: 'user'|'assistant'|'agent', content, timestamp, type, mediaId?, caption?, filename?}]
    lead,
    stage: "New", // dashboard-facing sales pipeline, rep-controlled
    stageHistory: [{ stage: "New", at: now }],
    paused: false, // true once a human has taken over (manual send, escalation, or explicit pause)
    alertedHot: false,
    activationSent: false,
    unreadCount: 0,
    lastReadAt: now,
    summary: null,
    summaryUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
  };
}

function getSession(waId) {
  const db = loadAll();
  if (!db[waId]) {
    db[waId] = emptySession();
    saveAll(db);
  }
  return db[waId];
}

function saveSession(waId, session) {
  const db = loadAll();
  session.updatedAt = Date.now();
  db[waId] = session;
  saveAll(db);
}

function newMessageId() {
  return crypto.randomBytes(8).toString("hex");
}

// Appends a message to a session's history with a stable id + timestamp.
// Does not save — caller still owns the save (keeps this composable within
// a single lock-protected read/modify/write cycle in server.js).
function appendMessage(session, { role, content, type = "text", mediaId = null, caption = null, filename = null }) {
  const msg = { id: newMessageId(), role, content, type, mediaId, caption, filename, timestamp: Date.now() };
  session.history.push(msg);
  return msg;
}

function setStage(session, stage) {
  if (!STAGES.includes(stage)) throw new Error(`Invalid stage: ${stage}`);
  session.stage = stage;
  session.stageHistory.push({ stage, at: Date.now() });
}

// ---- Dashboard-facing read queries ----

function lastMessagePreview(session) {
  const last = session.history[session.history.length - 1];
  if (!last) return null;
  const preview =
    last.type === "text" ? last.content : `[${last.type}]${last.caption ? " " + last.caption : ""}`;
  return { preview: preview.slice(0, 140), role: last.role, timestamp: last.timestamp };
}

function listConversations({ stage, search } = {}) {
  const db = loadAll();
  let rows = Object.entries(db).map(([waId, s]) => ({
    waId,
    name: s.lead?.name || null,
    stage: s.stage || "New",
    status: s.lead?.status,
    score: s.lead?.score || 0,
    isHot: s.lead?.status === "hot" || s.alertedHot,
    isEscalated: s.lead?.status === "escalated",
    activationReady: s.activationSent || s.trialActivationSent || false,
    paused: s.paused,
    unreadCount: s.unreadCount || 0,
    lastMessage: lastMessagePreview(s),
    updatedAt: s.updatedAt,
  }));

  if (stage) rows = rows.filter((r) => r.stage === stage);
  if (search) {
    const q = search.toLowerCase();
    const matchingWaIds = new Set(searchConversations(search).map((r) => r.waId));
    rows = rows.filter(
      (r) => r.waId.includes(q) || (r.name || "").toLowerCase().includes(q) || matchingWaIds.has(r.waId)
    );
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Full-text search across message content and lead profile fields.
// Returns [{waId, snippet, matchedIn}], not full sessions.
function searchConversations(query) {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase();
  const db = loadAll();
  const results = [];

  for (const [waId, s] of Object.entries(db)) {
    const lead = s.lead || {};
    const leadFields = [lead.name, lead.email, lead.use_case, lead.budget, lead.timeline]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (leadFields.includes(q)) {
      results.push({ waId, snippet: leadFields.slice(0, 140), matchedIn: "profile" });
      continue;
    }

    const hit = (s.history || []).find((m) => (m.content || "").toLowerCase().includes(q));
    if (hit) {
      const idx = hit.content.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 40);
      results.push({
        waId,
        snippet: (start > 0 ? "…" : "") + hit.content.slice(start, start + 120),
        matchedIn: "message",
      });
    }
  }
  return results;
}

function getAnalytics({ sinceMs } = {}) {
  const db = loadAll();
  const since = sinceMs ? Date.now() - sinceMs : 0;
  const sessions = Object.values(db);

  const newLeads = sessions.filter((s) => s.createdAt >= since).length;
  const hotLeads = sessions.filter((s) => s.alertedHot && s.updatedAt >= since).length;

  const demosBooked = sessions.filter((s) =>
    (s.stageHistory || []).some((h) => h.stage === "Demo Scheduled" && h.at >= since)
  ).length;

  const won = sessions.filter((s) => s.stage === "Won").length;
  const lost = sessions.filter((s) => s.stage === "Lost").length;
  const conversionRate = won + lost > 0 ? won / (won + lost) : 0;

  return {
    totalConversations: sessions.length,
    newLeads,
    hotLeads,
    demosBooked,
    won,
    lost,
    conversionRate: Math.round(conversionRate * 1000) / 10, // one decimal, as a %
  };
}

module.exports = {
  STAGES,
  getSession,
  saveSession,
  appendMessage,
  setStage,
  listConversations,
  searchConversations,
  getAnalytics,
  // kept for backward compatibility with the original /admin/leads route
  listLeads: () => listConversations(),
};
