const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const CONFIG_PATH = path.join(__dirname, "..", "config", "agent.json");

let cached = null;
let cachedMtimeMs = 0;

function load() {
  const stat = fs.statSync(CONFIG_PATH);
  if (cached && stat.mtimeMs === cachedMtimeMs) return cached;

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  cached = parsed;
  cachedMtimeMs = stat.mtimeMs;
  logger.info("Loaded agent config from config/agent.json");
  return cached;
}

// Call this any time — it's cheap (one stat syscall) and always returns
// the latest config if the file changed, so editing config/agent.json
// takes effect on the next message with no server restart required.
function getConfig() {
  try {
    return load();
  } catch (err) {
    logger.error({ err }, "Failed to load config/agent.json, using last known good config");
    if (cached) return cached;
    throw err;
  }
}

module.exports = { getConfig };
