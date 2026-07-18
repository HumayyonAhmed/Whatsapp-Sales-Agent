const axios = require("axios");
const logger = require("./logger");
const { withRetry } = require("./retry");

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}`;

const client = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  timeout: 10_000,
});

async function sendText(to, body) {
  return withRetry(
    () =>
      client.post("/messages", {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body, preview_url: false },
      }),
    { label: "WhatsApp sendText" }
  );
}

// Quick-reply buttons (max 3)
async function sendButtons(to, bodyText, buttons) {
  return withRetry(
    () =>
      client.post("/messages", {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((b, i) => ({
              type: "reply",
              reply: { id: b.id || `btn_${i}`, title: b.title.slice(0, 20) },
            })),
          },
        },
      }),
    { label: "WhatsApp sendButtons" }
  );
}

// Interactive list message — sections: [{ title, rows: [{id, title, description}] }]
async function sendList(to, bodyText, buttonLabel, sections) {
  return withRetry(
    () =>
      client.post("/messages", {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonLabel.slice(0, 20),
            sections: sections.map((s) => ({
              title: s.title.slice(0, 24),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title.slice(0, 24),
                description: (r.description || "").slice(0, 72),
              })),
            })),
          },
        },
      }),
    { label: "WhatsApp sendList" }
  );
}

async function sendImageById(to, mediaId, caption) {
  return withRetry(
    () =>
      client.post("/messages", {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { id: mediaId, caption: caption || undefined },
      }),
    { label: "WhatsApp sendImage" }
  );
}

async function sendDocumentById(to, mediaId, caption, filename) {
  return withRetry(
    () =>
      client.post("/messages", {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, caption: caption || undefined, filename: filename || undefined },
      }),
    { label: "WhatsApp sendDocument" }
  );
}

// Uploads a file buffer to Meta and returns a media id, for use with
// sendImageById/sendDocumentById. Uses the platform's built-in FormData
// (Node 18+) — no extra dependency needed.
async function uploadMedia(buffer, mimeType, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename || "upload");

  const { data } = await withRetry(
    () =>
      axios.post(`${BASE_URL}/media`, form, {
        headers: { Authorization: `Bearer ${TOKEN}` }, // let axios set the multipart boundary
        timeout: 30_000,
      }),
    { label: "WhatsApp media upload" }
  );
  return data.id;
}

// Fetches a media file's bytes (for the dashboard's media-preview proxy
// route) given a media id from an inbound OR outbound message.
async function downloadMedia(mediaId) {
  const { data: meta } = await withRetry(
    () => axios.get(`https://graph.facebook.com/${API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      timeout: 10_000,
    }),
    { label: "WhatsApp media metadata" }
  );

  const { data: bytes, headers } = await withRetry(
    () =>
      axios.get(meta.url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        responseType: "arraybuffer",
        timeout: 30_000,
      }),
    { label: "WhatsApp media download" }
  );

  return { buffer: Buffer.from(bytes), mimeType: headers["content-type"] || meta.mime_type };
}

async function markRead(messageId) {
  return withRetry(
    () =>
      client.post("/messages", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    { label: "WhatsApp markRead" }
  );
}

module.exports = {
  sendText,
  sendButtons,
  sendList,
  sendImageById,
  sendDocumentById,
  uploadMedia,
  downloadMedia,
  markRead,
};
