// Drop any number of .md files into config/knowledge/ — no code changes
// needed. This module chunks them by heading and retrieves the most
// relevant chunks for a given user message using simple TF-IDF scoring.
// Good enough for a few dozen KB pages; swap for a real vector DB
// (pgvector, Pinecone, etc.) if your KB grows much larger than that.
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const KB_DIR = path.join(__dirname, "..", "config", "knowledge");
const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","to","of","in","on",
  "for","and","or","it","this","that","with","as","at","by","from","your",
  "you","we","our","i","do","does","did","if","can","will","would","not",
  "no","yes","how","what","when","where","which","who","why",
]);

let chunks = []; // [{ file, title, text, tf: Map<term,count> }]
let idf = new Map();
let lastLoadedMtimes = "";

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

function chunkMarkdown(fileName, raw) {
  const sections = raw.split(/\n(?=##?\s)/g); // split before each heading
  return sections
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const headingMatch = s.match(/^#{1,3}\s+(.*)/);
      const title = headingMatch ? headingMatch[1].trim() : fileName;
      return { file: fileName, title, text: s };
    });
}

function buildIndex() {
  let files = [];
  try {
    files = fs.readdirSync(KB_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    logger.warn(`No knowledge base directory found at ${KB_DIR}`);
  }

  const mtimeFingerprint = files
    .map((f) => `${f}:${fs.statSync(path.join(KB_DIR, f)).mtimeMs}`)
    .join("|");
  if (mtimeFingerprint === lastLoadedMtimes && chunks.length) return; // unchanged

  const newChunks = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(KB_DIR, file), "utf8");
    newChunks.push(...chunkMarkdown(file, raw));
  }

  // term frequency per chunk + document frequency across chunks
  const df = new Map();
  for (const chunk of newChunks) {
    const terms = tokenize(chunk.text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    chunk.tf = tf;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }

  const N = Math.max(newChunks.length, 1);
  const newIdf = new Map();
  for (const [term, count] of df.entries()) {
    newIdf.set(term, Math.log((N + 1) / (count + 0.5)) + 1);
  }

  chunks = newChunks;
  idf = newIdf;
  lastLoadedMtimes = mtimeFingerprint;
  logger.info(`Knowledge base loaded: ${chunks.length} chunk(s) from ${files.length} file(s)`);
}

// Returns the top-k most relevant chunks' text for a query, or [] if
// nothing scores above a minimal relevance threshold.
function retrieve(query, k = 3) {
  buildIndex(); // cheap no-op if files haven't changed
  if (!chunks.length) return [];

  const queryTerms = tokenize(query);
  if (!queryTerms.length) return [];

  const scored = chunks.map((chunk) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.tf.get(term) || 0;
      if (tf > 0) score += tf * (idf.get(term) || 1);
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk.text);
}

function reload() {
  lastLoadedMtimes = ""; // force rebuild on next retrieve()
  buildIndex();
}

module.exports = { retrieve, reload };
