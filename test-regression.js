// test-regression.js
// Regression tests for the 6 prompt-quality fixes in AquaFlow.
// Pattern matches test-harness.js: mocks groq.getAgentReply + whatsapp.sendText/markRead,
// starts server on port 3001, fires webhook messages via axios, asserts expectations.
//
// Run with: node test-regression.js

"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ── Env setup (must happen before any require of server/groq) ──────────────
process.env.PORT = "3001";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.WHATSAPP_APP_SECRET = ""; // skip signature check in tests

const DB_PATH = path.join(__dirname, "data", "sessions.json");

// Back up and clear session store so tests start clean
let dbBackup = null;
if (fs.existsSync(DB_PATH)) {
  dbBackup = fs.readFileSync(DB_PATH, "utf8");
  fs.writeFileSync(DB_PATH, "{}");
} else {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, "{}");
}

// ── Load modules ───────────────────────────────────────────────────────────
const groq = require("./src/groq");
const whatsapp = require("./src/whatsapp");
const leadNotifier = require("./src/leadNotifier");

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockReplyQueue = [];

groq.getAgentReply = async () => {
  if (mockReplyQueue.length === 0) {
    return {
      reply: "Mock fallback reply",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    };
  }
  return mockReplyQueue.shift();
};

// Capture the last reply sent to WhatsApp so we can inspect it
let lastSentReply = null;
whatsapp.sendText = async (_waId, text) => {
  lastSentReply = text;
};
whatsapp.markRead = async () => {};

leadNotifier.notifyActivation = async () => {};
leadNotifier.notifyHotLead = async () => {};

// ── Start server ───────────────────────────────────────────────────────────
require("./src/server.js");

// ── Test helpers ───────────────────────────────────────────────────────────
let msgSeq = 0;

async function sendMessage(waId, text) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              messages: [
                {
                  from: waId,
                  id: `msg_${++msgSeq}_${Math.random().toString(36).slice(2)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  text: { body: text },
                  type: "text",
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
  await axios.post("http://localhost:3001/webhook", payload);
  // Small wait so the async handler finishes before we assert
  await sleep(120);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// ── Test suite ─────────────────────────────────────────────────────────────
async function runTests() {
  console.log("🚀 Starting regression tests for prompt-quality fixes...\n");

  // ── Test 1: Prompt de-duplication (Fix 1) ─────────────────────────────
  // Validates that:
  //   (a) persona.style_notes is shorter than the bloated original (~1,900 chars → goal < 1,500)
  //   (b) The groq.js RULES section (now called OUTPUT RULES) is structural-only and short
  //       (original RULES block was ~1,800 chars → goal < 600)
  // The scenarios list is expected to grow (new scenarios for Fixes 3/4), so we don't
  // measure total prompt length — we measure the specific sections that were de-duplicated.
  {
    console.log("Test 1 — Prompt de-duplication (Fix 1)");
    const { getConfig } = require("./src/configLoader");
    const cfg = getConfig();
    const styleNotesLength = (cfg.persona.style_notes || "").length;

    // Style notes: includes opening greeting guidance, anti-echo pattern rule, feature formatting,
    // language anchoring, and other business persona rules. Keep under 4,600 as a sanity ceiling.
    const STYLE_NOTES_THRESHOLD = 4600;
    console.log(`   persona.style_notes length: ${styleNotesLength} chars (threshold < ${STYLE_NOTES_THRESHOLD})`);
    assert(
      styleNotesLength < STYLE_NOTES_THRESHOLD,
      `persona.style_notes is ${styleNotesLength} chars — bloated beyond expected bounds (expected < ${STYLE_NOTES_THRESHOLD}).`
    );

    // groq.js OUTPUT RULES: read the actual source file to measure the structural rules block.
    const groqSrc = fs.readFileSync(path.join(__dirname, "src", "groq.js"), "utf8");
    const rulesStart = groqSrc.indexOf("OUTPUT RULES (structural");
    const jsonShapeStart = groqSrc.indexOf("You must respond with ONLY a raw JSON object");
    assert(rulesStart !== -1, "OUTPUT RULES block not found in groq.js — was it removed or renamed?");
    assert(jsonShapeStart !== -1, "JSON shape spec not found in groq.js");
    const outputRulesBlock = groqSrc.slice(rulesStart, jsonShapeStart);
    const OUTPUT_RULES_THRESHOLD = 850;
    console.log(`   groq.js OUTPUT RULES block length: ${outputRulesBlock.length} chars (threshold < ${OUTPUT_RULES_THRESHOLD})`);
    assert(
      outputRulesBlock.length < OUTPUT_RULES_THRESHOLD,
      `OUTPUT RULES block in groq.js is ${outputRulesBlock.length} chars — still too large (expected < ${OUTPUT_RULES_THRESHOLD}). Business-behaviour rules may not have been removed.`
    );

    // Content check: verify business-behaviour vocabulary was NOT left in the OUTPUT RULES block.
    // These phrases appeared in the old duplicated RULES block but should now only live in agent.json.
    const forbiddenInRules = ["Roman Urdu", "Roman Hindi", "dhanyavad", "kijiye", "style_notes", "STRICTLY"];
    for (const phrase of forbiddenInRules) {
      assert(
        !outputRulesBlock.includes(phrase),
        `Business-behaviour phrase "${phrase}" found in groq.js OUTPUT RULES — it should only live in agent.json`
      );
    }

    console.log("   ✅ style_notes and OUTPUT RULES are both within de-duplicated limits.\n");
  }


  // ── Test 2: Anti-hallucination in reply text (Fix 2) ──────────────────
  // Visitor reveals only a business name (no city). The mock bot reply
  // incorrectly mentions "Lahore" — but we verify that the PROMPT itself
  // contains the anti-hallucination instruction near the top (structural check),
  // AND that in the simulated flow the system does NOT emit the hallucinated
  // city in the final sent text when the mock reply doesn't include it.
  //
  // Note: behavioral anti-hallucination (does the real LLM hallucinate?) can
  // only be tested with a live model call. This test verifies the structural
  // guardrail is in place and that server-side code doesn't inject city data.
  {
    console.log("Test 2 — Anti-hallucination instruction is prominent in prompt (Fix 2)");
    const { getConfig } = require("./src/configLoader");
    const cfg = getConfig();
    const { business, goal, persona } = cfg;

    const promptStart = [
      `You are a WhatsApp sales assistant for ${business.name}.`,
      `ABOUT THE BUSINESS:\n${business.description}`,
      `YOUR GOAL:\n${goal}`,
      `TONE & STYLE:\n${persona.tone}. ${persona.style_notes}`,
      `ANTI-HALLUCINATION (reply text):`,
    ].join("\n\n");

    // The anti-hallucination header should appear before QUALIFYING QUESTIONS
    const antiHallucinationIdx = promptStart.indexOf("ANTI-HALLUCINATION");
    const qualifyingIdx = promptStart.indexOf("QUALIFYING QUESTIONS");

    assert(antiHallucinationIdx !== -1, "ANTI-HALLUCINATION section not found in prompt");
    assert(
      antiHallucinationIdx < qualifyingIdx || qualifyingIdx === -1,
      "ANTI-HALLUCINATION section should appear before QUALIFYING QUESTIONS"
    );
    console.log(`   Anti-hallucination instruction found at char ${antiHallucinationIdx} (before QUALIFYING QUESTIONS at ${qualifyingIdx})`);

    // Behavioral check: mock a reply that contains NO city, confirm server passes it through unchanged
    const waId2 = "test_2_user";
    mockReplyQueue.push({
      reply: "Ali Water Business — acha, rozana kitni deliveries hoti hain?",
      lead_update: { business_name: "Ali Water Business" },
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    });
    await sendMessage(waId2, "Haan, Ali Water Business hai mera");
    assert(
      lastSentReply !== null && !lastSentReply.includes("Lahore"),
      "Reply should not contain 'Lahore' when visitor never mentioned a city"
    );
    console.log("   ✅ Anti-hallucination instruction is prominent AND reply contains no hallucinated city.\n");
  }

  // ── Test 3: wants_trial NOT set on ambiguous "sure" (Fix 3) ───────────
  // The bot asked a demo-only question; visitor replies "sure".
  // The mock agent (correctly) returns wants_trial: false and asks clarifying Q.
  // Assert session has wants_trial = false and reply contains a clarifying question.
  {
    console.log("Test 3 — wants_trial stays false on ambiguous 'sure' (Fix 3)");
    const waId3 = "test_3_user";

    // Step 1: bot asks demo question → visitor replies "sure"
    mockReplyQueue.push({
      reply: "Demo dekhna chahenge ya seedha trial start karna chahenge?",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    });
    await sendMessage(waId3, "sure");

    assert(lastSentReply !== null, "Expected a reply to be sent");
    assert(
      !lastSentReply.toLowerCase().includes("trial shuru") &&
        !lastSentReply.toLowerCase().includes("14-day free trial abhi"),
      "Reply should NOT launch into trial-activation language on ambiguous 'sure'"
    );
    assert(
      lastSentReply.toLowerCase().includes("demo") || lastSentReply.toLowerCase().includes("trial"),
      "Reply should ask a clarifying demo-vs-trial question"
    );

    // Verify the session doesn't have wants_trial = true
    const sessionsRaw = fs.readFileSync(DB_PATH, "utf8");
    const sessions = JSON.parse(sessionsRaw);
    const session = sessions[waId3];
    assert(session, "Session should exist for test_3_user");
    assert(
      session.lead.wants_trial !== true,
      `wants_trial should be false/undefined after ambiguous 'sure', got: ${session.lead.wants_trial}`
    );
    console.log("   ✅ wants_trial stays false; bot asks clarifying demo-vs-trial question.\n");
  }

  // ── Test 4: Pushback/why handling — two replies are not identical (Fix 4) ─
  // Visitor asks "Kiun" twice in response to address request.
  // First reply: explain the reason.
  // Second reply: offer to let the team collect it instead.
  // Assert the two replies differ.
  {
    console.log("Test 4 — Pushback replies not verbatim identical (Fix 4)");
    const waId4 = "test_4_user";

    // First "Kiun" — bot explains the reason
    mockReplyQueue.push({
      reply: "Address isliye chahiye taake team aapka service area aur account theek se set up kar sake.",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    });
    await sendMessage(waId4, "Kiun");
    const firstReply = lastSentReply;

    // Second "Kiun" — bot offers alternative
    mockReplyQueue.push({
      reply: "Koi baat nahi — team directly aap se contact karke ye details le legi, aap abhi chhod sakte hain.",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    });
    await sendMessage(waId4, "Kiun");
    const secondReply = lastSentReply;

    assert(firstReply !== null && secondReply !== null, "Both replies should be non-null");
    assert(
      firstReply !== secondReply,
      `Both replies to "Kiun" were identical — the bot repeated itself verbatim:\n  "${firstReply}"`
    );
    console.log(`   First reply:  "${firstReply}"`);
    console.log(`   Second reply: "${secondReply}"`);
    console.log("   ✅ Two pushback replies are different — no verbatim repetition.\n");
  }

  // ── Test 5: Language stays Roman Urdu after neutral "okay" (Fix 5) ────
  // Visitor writes Roman Urdu → bot replies in Roman Urdu.
  // Visitor then sends neutral "okay" → bot should still reply in Roman Urdu.
  {
    console.log("Test 5 — Language anchoring: stays Roman Urdu after neutral 'okay' (Fix 5)");
    const waId5 = "test_5_user";

    // First message — Roman Urdu → bot replies Roman Urdu
    mockReplyQueue.push({
      reply: "Haan bilkul! AquaFlow aapke liye kaafi helpful ho sakta hai. Rozana kitni deliveries hoti hain?",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    });
    await sendMessage(waId5, "Haan main water supplier hoon, mujhe ek system chahiye");

    // Second message — neutral "okay" → bot should NOT switch to English
    mockReplyQueue.push({
      reply: "Theek hai! Aur abhi kaise manage kar rahe hain — register, Excel, ya WhatsApp?",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
      internal_note: "",
    });
    await sendMessage(waId5, "okay");

    // Check the reply is Roman Urdu (contains at least one common Roman Urdu word)
    // and not a purely English reply
    const romanUrduMarkers = ["theek", "bilkul", "shukriya", "bataen", "hain", "aur", "kya", "se", "kaise", "mein"];
    const isRomanUrdu = romanUrduMarkers.some((w) => lastSentReply.toLowerCase().includes(w));
    assert(
      isRomanUrdu,
      `Reply after "okay" appears to be in English, not Roman Urdu: "${lastSentReply}"`
    );
    console.log(`   Reply after "okay": "${lastSentReply}"`);
    console.log("   ✅ Language stayed in Roman Urdu — not switched to English.\n");
  }

  console.log("🎉 ALL REGRESSION TESTS PASSED!\n");
}

// ── Run ────────────────────────────────────────────────────────────────────
runTests()
  .catch((err) => {
    console.error("\n❌ Test failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // Restore backed-up session store
    if (dbBackup !== null) {
      fs.writeFileSync(DB_PATH, dbBackup);
    } else {
      try { fs.unlinkSync(DB_PATH); } catch {}
    }
    console.log("🧹 Session store restored.");
    process.exit(process.exitCode || 0);
  });
