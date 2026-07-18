require("dotenv").config();
const crypto = require("crypto");
const path = require("path");
const express = require("express");

const { sendText, markRead } = require("./whatsapp");
const { getAgentReply, fallbackReply } = require("./groq");
const store = require("./store");
const { notifyHotLead, notifyActivation } = require("./leadNotifier");
const { getConfig } = require("./configLoader");
const { isDuplicate } = require("./idempotency");
const { allow: rateLimitAllow } = require("./rateLimiter");
const { withUserLock } = require("./lock");
const { emitConversationEvent } = require("./events");
const adminRouter = require("./admin");
const dashboardRouter = require("./dashboard");
const logger = require("./logger");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HISTORY_MESSAGES = 8; // how much conversation gets fed back into the LLM prompt
const MAX_STORED_MESSAGES = 500; // how much a rep can scroll back through in the dashboard

// Capture the raw request body (needed for Meta's X-Hub-Signature-256 check)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use("/admin", adminRouter);
app.use("/api", dashboardRouter);
app.use(express.static(path.join(__dirname, "..", "public")));

// ---- Signature verification ----
function verifyMetaSignature(req, res, next) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    logger.warn("WHATSAPP_APP_SECRET not set — skipping signature verification (not safe for production)");
    return next();
  }

  const signature = req.get("x-hub-signature-256");
  if (!signature) return res.sendStatus(401);

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logger.warn("Rejected webhook POST with invalid signature");
    return res.sendStatus(401);
  }
  next();
}

// ---- 1. Webhook verification ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info("Webhook verified.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- 2. Incoming messages ----
app.post("/webhook", verifyMetaSignature, async (req, res) => {
  res.sendStatus(200); // ack fast so Meta doesn't retry/duplicate

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return; // e.g. a status/delivery callback, ignore

    if (isDuplicate(message.id)) {
      logger.info({ messageId: message.id }, "Duplicate webhook delivery ignored");
      return;
    }

    const waId = message.from;

    if (!rateLimitAllow(waId)) {
      logger.warn({ waId }, "Rate limit exceeded, dropping message");
      return;
    }

    await withUserLock(waId, () => handleMessage(waId, message));
  } catch (err) {
    logger.error({ err: err.message }, "Error handling webhook event");
  }
});

async function handleMessage(waId, message) {
  const session = store.getSession(waId);
  const cfg = getConfig();

  // Reset conversation context (not the lead profile) after a long gap
  const timeoutMs = (cfg.session_timeout_hours ?? 12) * 60 * 60 * 1000;
  if (Date.now() - session.lastActivity > timeoutMs) {
    session.history = [];
  }
  session.lastActivity = Date.now();
  session.unreadCount = (session.unreadCount || 0) + 1;

  if (message.id) markRead(message.id).catch(() => {});

  const inbound = extractInbound(message);

  // Non-text media (image/audio/document/video/location): store it for the
  // rep to see in the dashboard. The bot itself can't reason about media
  // content, so it doesn't auto-reply — the dashboard is the safety net now.
  if (inbound.type !== "text") {
    store.appendMessage(session, inbound);
    trimHistory(session);
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });
    logger.info({ waId, mediaType: inbound.type }, "Non-text message stored for rep review, no auto-reply");
    return;
  }

  const text = inbound.content;

  // Human already took over (escalation or manual /pause) — store and stop.
  if (session.paused) {
    store.appendMessage(session, inbound);
    trimHistory(session);
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });
    logger.info({ waId }, "Message received while paused (human handling) — no auto-reply sent");
    return;
  }

  // Deterministic escalation — checked before any LLM call.
  const escalationKeywords = cfg.escalation_keywords || [];
  const lowerText = text.toLowerCase();
  const matchedKeyword = escalationKeywords.find((k) => lowerText.includes(k.toLowerCase()));

  if (matchedKeyword) {
    store.appendMessage(session, inbound);
    session.lead.status = "escalated";
    session.paused = true;
    await sendText(waId, cfg.handoff_message);
    store.appendMessage(session, { role: "assistant", content: cfg.handoff_message });
    trimHistory(session);
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });
    await notifyHotLead({
      waId,
      lead: session.lead,
      internalNote: `Visitor requested human help (matched: "${matchedKeyword}")`,
      reason: "Escalation requested",
    });
    return;
  }

  let agentResult;
  try {
    agentResult = await getAgentReply({
      history: session.history.slice(-MAX_HISTORY_MESSAGES).map(({ role, content }) => ({
        role: role === "user" ? "user" : "assistant",
        content,
      })),
      userMessage: text,
      currentLead: session.lead,
    });
  } catch (err) {
    logger.error({ err: err.message, waId }, "Groq call failed, escalating silently");
    
    // Store the inbound message, pause/escalate the session, and notify the rep
    store.appendMessage(session, inbound);
    session.lead.status = "escalated";
    session.paused = true;
    trimHistory(session);
    
    await notifyHotLead({
      waId,
      lead: session.lead,
      internalNote: `LLM call failed (error: ${err.message}) — escalating silently.`,
      reason: "Escalation requested",
    });
    
    store.saveSession(waId, session);
    emitConversationEvent(waId, { type: "message" });
    return;
  }

  for (const [key, value] of Object.entries(agentResult.lead_update || {})) {
    if (value) session.lead[key] = value;
  }
  const activation = cfg.activation;
  if (activation?.enabled && activation?.trigger_field && agentResult[activation.trigger_field] && !session.lead.phone) {
    session.lead.phone = waId;
  }
  if (agentResult.status) session.lead.status = agentResult.status;
  if (session.lead.status === "escalated") {
    session.paused = true;
  }
  session.lead.score = scoreLead(session.lead, agentResult.is_hot_lead);

  // Light auto-assist on the rep-facing pipeline: a hot lead is at least
  // "Qualified" — the rep still manually advances Demo Scheduled → Won/Lost.
  if (agentResult.is_hot_lead && session.stage === "New") {
    store.setStage(session, "Qualified");
  }

  store.appendMessage(session, inbound);
  store.appendMessage(session, { role: "assistant", content: agentResult.reply });
  trimHistory(session);

  await sendText(waId, agentResult.reply);

  if (agentResult.is_hot_lead && !session.alertedHot) {
    session.alertedHot = true;
    session.lead.status = "hot";
    await notifyHotLead({ waId, lead: session.lead, internalNote: agentResult.internal_note });
  }

  if (agentResult.status === "escalated") {
    await notifyHotLead({
      waId,
      lead: session.lead,
      internalNote: agentResult.internal_note || "System or model requested escalation.",
      reason: "Escalation requested",
    });
  }

  if (
    activation?.enabled &&
    activation?.trigger_field &&
    agentResult[activation.trigger_field] &&
    (activation.required_fields || []).every((f) => session.lead[f]) &&
    !session.activationSent && !session.trialActivationSent
  ) {
    session.activationSent = true;
    await notifyActivation({ waId, lead: session.lead, cfg });

    if (activation.auto_escalate) session.lead.status = "escalated";
    if (activation.auto_pause) session.paused = true;
  }

  store.saveSession(waId, session);
  emitConversationEvent(waId, { type: "message" });
}

function trimHistory(session) {
  if (session.history.length > MAX_STORED_MESSAGES) {
    session.history = session.history.slice(-MAX_STORED_MESSAGES);
  }
}

function extractInbound(message) {
  if (message.type === "text") {
    return { role: "user", content: message.text.body, type: "text" };
  }
  if (message.type === "interactive") {
    const content =
      message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "";
    return { role: "user", content, type: content ? "text" : "unsupported" };
  }
  if (["image", "document", "audio", "video"].includes(message.type)) {
    const media = message[message.type];
    return {
      role: "user",
      content: media.caption || `[${message.type}]`,
      type: message.type,
      mediaId: media.id,
      caption: media.caption || null,
      filename: media.filename || null,
    };
  }
  if (message.type === "location") {
    return { role: "user", content: `[location: ${message.location.latitude}, ${message.location.longitude}]`, type: "location" };
  }
  return { role: "user", content: "[unsupported message type]", type: "unsupported" };
}

// Config-driven lead score (0-100) combining profile completeness + LLM signal
function scoreLead(lead, isHot) {
  const cfg = getConfig();
  let score = 0;
  for (const field of (cfg.lead_fields || [])) {
    if (field.score_points && lead[field.id]) {
      score += field.score_points;
    }
  }
  if (isHot) score += 15;
  return Math.min(score, 100);
}

app.get("/health", (_req, res) => res.json({ status: "ok", uptimeSeconds: process.uptime() }));

const server = app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));

// ---- Crash safety ----
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting so the process manager can restart cleanly");
  process.exit(1);
});

function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
