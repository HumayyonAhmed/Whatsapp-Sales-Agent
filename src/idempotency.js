// Meta will retry webhook delivery if your server doesn't ack fast enough,
// which can otherwise cause the same inbound message to be processed
// (and replied to) twice. Track seen message IDs for a short window.
const seen = new Map(); // messageId -> timestamp
const TTL_MS = 10 * 60 * 1000; // 10 minutes is plenty for WhatsApp's retry window

function isDuplicate(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seen.entries()) {
    if (now - ts > TTL_MS) seen.delete(id);
  }
}, 60 * 1000).unref();

module.exports = { isDuplicate };
