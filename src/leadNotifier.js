const axios = require("axios");
const { sendText } = require("./whatsapp");
const logger = require("./logger");

async function notifyHotLead({ waId, lead, internalNote, reason = "hot lead" }) {
  const summary =
    `🔥 ${reason} on WhatsApp!\n` +
    `From: ${waId}\n` +
    `Name: ${lead.name || "unknown"}\n` +
    `Use case: ${lead.use_case || "unknown"}\n` +
    `Budget: ${lead.budget || "unknown"}\n` +
    `Timeline: ${lead.timeline || "unknown"}\n` +
    `Why: ${internalNote || "strong buying signal detected"}`;

  logger.info({ waId, lead }, summary);

  if (process.env.NOTIFY_WEBHOOK_URL) {
    try {
      await axios.post(process.env.NOTIFY_WEBHOOK_URL, { text: summary }, { timeout: 8000 });
    } catch (err) {
      logger.error({ err: err.message }, "Failed to post to NOTIFY_WEBHOOK_URL");
    }
  }

  if (process.env.SALES_REP_WHATSAPP_NUMBER) {
    try {
      await sendText(process.env.SALES_REP_WHATSAPP_NUMBER, summary);
    } catch (err) {
      logger.error({ err: err.message }, "Failed to WhatsApp-alert sales rep");
    }
  }
}

async function notifyTrialReady({ waId, lead }) {
  const summary =
    `🚀 TRIAL READY TO ACTIVATE\n` +
    `From: ${waId}\n` +
    `Business Name: ${lead.business_name || "unknown"}\n` +
    `Owner Name: ${lead.name || "unknown"}\n` +
    `Phone: ${lead.phone || "unknown"}\n` +
    `Email: ${lead.email || "unknown"}\n` +
    `Address: ${lead.address || "unknown"}\n` +
    `City: ${lead.city || "unknown"}\n` +
    `Daily Deliveries: ${lead.daily_deliveries || "unknown"}\n` +
    `Current Method: ${lead.current_method || "unknown"}`;

  logger.info({ waId, lead }, summary);

  if (process.env.NOTIFY_WEBHOOK_URL) {
    try {
      await axios.post(process.env.NOTIFY_WEBHOOK_URL, { text: summary }, { timeout: 8000 });
    } catch (err) {
      logger.error({ err: err.message }, "Failed to post to NOTIFY_WEBHOOK_URL");
    }
  }

  if (process.env.SALES_REP_WHATSAPP_NUMBER) {
    try {
      await sendText(process.env.SALES_REP_WHATSAPP_NUMBER, summary);
    } catch (err) {
      logger.error({ err: err.message }, "Failed to WhatsApp-alert sales rep");
    }
  }
}

module.exports = { notifyHotLead, notifyTrialReady };
