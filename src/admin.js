const express = require("express");
const { getSession, saveSession, listLeads } = require("./store");
const knowledgeBase = require("./knowledgeBase");
const logger = require("./logger");
const { requireAdminKey } = require("./auth");

const router = express.Router();

router.use(requireAdminKey);

// GET /admin/leads — quick overview of every conversation
router.get("/leads", (_req, res) => {
  res.json(listLeads());
});

// GET /admin/leads/:waId — full conversation + lead detail
router.get("/leads/:waId", (req, res) => {
  const session = getSession(req.params.waId);
  res.json(session);
});

// POST /admin/leads/:waId/pause — human is taking over; bot stops auto-replying
router.post("/leads/:waId/pause", (req, res) => {
  const session = getSession(req.params.waId);
  session.paused = true;
  saveSession(req.params.waId, session);
  logger.info({ waId: req.params.waId }, "Conversation paused by admin (human takeover)");
  res.json({ ok: true, paused: true });
});

// POST /admin/leads/:waId/resume — hand control back to the bot
router.post("/leads/:waId/resume", (req, res) => {
  const session = getSession(req.params.waId);
  session.paused = false;
  saveSession(req.params.waId, session);
  logger.info({ waId: req.params.waId }, "Conversation resumed by admin (bot back in control)");
  res.json({ ok: true, paused: false });
});

// POST /admin/reload-knowledge — force a knowledge-base reload without restart
router.post("/reload-knowledge", (_req, res) => {
  knowledgeBase.reload();
  res.json({ ok: true, reloaded: true });
});

module.exports = router;
