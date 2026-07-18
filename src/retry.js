const logger = require("./logger");

// Shared retry-with-backoff wrapper for outbound API calls (Groq, Meta Graph
// API). Retries transient failures (timeout, 429, 5xx); does NOT retry 4xx
// auth/validation errors since those won't self-resolve on retry.
async function withRetry(fn, { retries = 2, baseDelayMs = 500, label = "API call" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      logger.warn({ status, attempt }, `${label} failed, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
