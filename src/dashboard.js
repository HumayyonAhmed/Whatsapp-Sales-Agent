// REST + SSE API consumed by the dashboard frontend (public/). Everything
// here is additive — it reads/writes the same session store the WhatsApp
// bot logic in server.js uses, and never touches the AI reply pipeline
// itself. Auth: requireAdminKey (header or ?key= for the SSE route).
const express = require("express");
const multer = require("multer");
const { requireAdminKey } = require("./auth");
const store = require("./store");
const whatsapp = require("./whatsapp");
const groq = require("./groq");
const { bus, emitConversationEvent } = require("./events");
const logger = require("./logger");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

router.use(requireAdminKey);

// ---- Conversations (inbox) ----

router.get("/conversations", (req, res) => {
  const { stage, search } = req.query;
  res.json(store.listConversations({ stage, search }));
});

router.get("/conversations/:waId", (req, res) => {
  res.json(store.getSession(req.params.waId));
});

router.get("/search", (req, res) => {
  res.json(store.searchConversations(req.query.q || ""));
});

router.get("/analytics", (req, res) => {
  const sinceMs = req.query.days ? Number(req.query.days) * 24 * 60 * 60 * 1000 : undefined;
  res.json(store.getAnalytics({ sinceMs }));
});

router.get("/stages", (_req, res) => res.json(store.STAGES));

// ---- Initiate a new outbound conversation ----
// Sends a first message to a brand-new (or existing) number and creates/
// updates the session so the conversation appears in the inbox immediately.
router.post("/conversations/new", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message are required" });
  }

  // Normalise: strip spaces/dashes, ensure it starts with a country code.
  // We accept "03001234567" (Pakistan) and auto-prefix 92, or already-full numbers.
  let waId = String(phone).replace(/[\s\-().+]/g, "");
  if (waId.startsWith("0")) waId = "92" + waId.slice(1); // 03xx → 923xx

  if (!/^\d{10,15}$/.test(waId)) {
    return res.status(400).json({ error: "Invalid phone number — use digits only, e.g. 03001234567 or 923001234567" });
  }

  try {
    await whatsapp.sendText(waId, message);

    const session = store.getSession(waId);
    store.appendMessage(session, { role: "agent", content: message, type: "text" });
    session.paused = true; // rep-initiated — keep bot off until rep hands back
    session.lastActivity = Date.now();
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });

    res.json({ ok: true, waId });
  } catch (err) {
    logger.error({ err: err.message, waId }, "Failed to initiate outbound conversation");
    res.status(502).json({ error: "Failed to send message via WhatsApp — check the number and try again." });
  }
});

// ---- Mark read ----
router.post("/conversations/:waId/read", (req, res) => {
  const session = store.getSession(req.params.waId);
  session.unreadCount = 0;
  session.lastReadAt = Date.now();
  store.saveSession(req.params.waId, session);
  res.json({ ok: true });
});

// ---- Stage change (rep-controlled sales pipeline) ----
router.post("/conversations/:waId/stage", (req, res) => {
  const { stage } = req.body;
  if (!store.STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${store.STAGES.join(", ")}` });
  }
  const session = store.getSession(req.params.waId);
  store.setStage(session, stage);
  store.saveSession(req.params.waId, session);
  emitConversationEvent(req.params.waId, { type: "stage", stage });
  res.json({ ok: true, stage });
});

// ---- Human takeover controls ----
router.post("/conversations/:waId/pause", (req, res) => {
  const session = store.getSession(req.params.waId);
  session.paused = true;
  store.saveSession(req.params.waId, session);
  emitConversationEvent(req.params.waId, { type: "paused", paused: true });
  res.json({ ok: true, paused: true });
});

router.post("/conversations/:waId/resume", (req, res) => {
  const session = store.getSession(req.params.waId);
  session.paused = false;
  store.saveSession(req.params.waId, session);
  emitConversationEvent(req.params.waId, { type: "paused", paused: false });
  res.json({ ok: true, paused: false });
});

// ---- AI helpers for the rep (summary + suggested reply) ----
router.post("/conversations/:waId/summary", async (req, res) => {
  try {
    const session = store.getSession(req.params.waId);
    const summary = await groq.summarizeConversation(session.history);
    session.summary = summary;
    session.summaryUpdatedAt = Date.now();
    store.saveSession(req.params.waId, session);
    res.json({ summary, summaryUpdatedAt: session.summaryUpdatedAt });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to generate conversation summary");
    res.status(502).json({ error: "Failed to generate summary" });
  }
});

router.post("/conversations/:waId/suggest-reply", async (req, res) => {
  try {
    const session = store.getSession(req.params.waId);
    const suggestion = await groq.suggestReply(session.history, session.lead);
    res.json({ suggestion });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to generate reply suggestion");
    res.status(502).json({ error: "Failed to generate a suggestion" });
  }
});

// ---- Manual send (text / buttons / list) — this is the rep talking ----
router.post("/conversations/:waId/send", async (req, res) => {
  const { waId } = req.params;
  const { type = "text", text, buttons, list } = req.body;

  try {
    const session = store.getSession(waId);
    let sentSummaryText = text;

    if (type === "text") {
      await whatsapp.sendText(waId, text);
    } else if (type === "buttons") {
      await whatsapp.sendButtons(waId, text, buttons);
      sentSummaryText = `${text} [buttons: ${buttons.map((b) => b.title).join(", ")}]`;
    } else if (type === "list") {
      await whatsapp.sendList(waId, text, list.buttonLabel, list.sections);
      sentSummaryText = `${text} [list: ${list.buttonLabel}]`;
    } else {
      return res.status(400).json({ error: "type must be text, buttons, or list" });
    }

    store.appendMessage(session, { role: "agent", content: sentSummaryText, type: "text" });
    session.paused = true; // a rep sending a message is a takeover
    session.lastActivity = Date.now();
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message, waId }, "Manual send failed");
    res.status(502).json({ error: "Failed to send message via WhatsApp" });
  }
});

// ---- Manual send: image / PDF upload ----
router.post("/conversations/:waId/send-media", upload.single("file"), async (req, res) => {
  const { waId } = req.params;
  const { caption, type } = req.body; // type: 'image' | 'document'
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!["image", "document"].includes(type)) {
    return res.status(400).json({ error: "type must be image or document" });
  }

  try {
    const session = store.getSession(waId);
    const mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype, req.file.originalname);

    if (type === "image") {
      await whatsapp.sendImageById(waId, mediaId, caption);
    } else {
      await whatsapp.sendDocumentById(waId, mediaId, caption, req.file.originalname);
    }

    store.appendMessage(session, {
      role: "agent",
      content: caption || req.file.originalname,
      type,
      mediaId,
      caption,
      filename: req.file.originalname,
    });
    session.paused = true;
    session.lastActivity = Date.now();
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });
    res.json({ ok: true, mediaId });
  } catch (err) {
    logger.error({ err: err.message, waId }, "Manual media send failed");
    res.status(502).json({ error: "Failed to send media via WhatsApp" });
  }
});

// ---- Media proxy — lets the dashboard preview images/PDFs sent in either
// direction without exposing the WhatsApp access token to the browser ----
router.get("/media/:mediaId", async (req, res) => {
  try {
    const { buffer, mimeType } = await whatsapp.downloadMedia(req.params.mediaId);
    res.set("Content-Type", mimeType || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    logger.error({ err: err.message }, "Media proxy fetch failed");
    res.status(502).json({ error: "Failed to fetch media" });
  }
});

// ---- Real-time stream (SSE) ----
router.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`retry: 3000\n\n`);

  const onEvent = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  bus.on("conversation", onEvent);

  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off("conversation", onEvent);
  });
});

module.exports = router;
