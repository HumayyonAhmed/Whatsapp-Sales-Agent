// Per-visitor rate limit so one person (or a misbehaving retry loop) can't
// spam your LLM/WhatsApp bill. In-memory — fine for a single server
// instance; use a shared store (Redis) if you run multiple instances.
const buckets = new Map(); // waId -> { count, windowStart }

const MAX_MESSAGES = parseInt(process.env.RATE_LIMIT_MAX || "20", 10);
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MIN || "10", 10) * 60 * 1000;

// Returns true if this message is allowed, false if the sender is over
// the limit for the current window.
function allow(waId) {
  const now = Date.now();
  const bucket = buckets.get(waId);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(waId, { count: 1, windowStart: now });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= MAX_MESSAGES;
}

// Periodic cleanup so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [waId, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > WINDOW_MS) buckets.delete(waId);
  }
}, 5 * 60 * 1000).unref();

module.exports = { allow };
