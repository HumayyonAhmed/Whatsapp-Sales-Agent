const axios = require("axios");
const logger = require("./logger");
const { getConfig } = require("./configLoader");
const knowledgeBase = require("./knowledgeBase");
const { withRetry } = require("./retry");

const GROQ_API_URL = process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions";
// Check https://console.groq.com/docs/models for the current model list
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const LLM_PROVIDER = process.env.LLM_PROVIDER || "groq";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const GEMINI_API_URL = process.env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta/models";

function buildSystemPrompt(kbContext) {
  const cfg = getConfig();
  const { business, goal, persona, qualifying_questions, hot_lead_criteria, scenarios, lead_fields, activation, system_prompt_extra } = cfg;

  const questionsList = (qualifying_questions || [])
    .map((q) => `- ${q.id}: "${q.ask}"`)
    .join("\n");

  const scenarioList = (scenarios || [])
    .map((s) => `- When: ${s.when}\n  Do: ${s.instruction}`)
    .join("\n");

  // Build lead_update JSON schema dynamically from config
  const leadFieldsSchema = (lead_fields || [])
    .map((f) => `    "${f.id}": string or null`)
    .join(",\n");

  // Build activation trigger field for JSON output shape, if configured
  const activationTriggerLine = activation?.enabled && activation?.trigger_field
    ? `  "${activation.trigger_field}": boolean,\n`
    : "";

  // Build activation-related output rules, if configured
  let activationRules = "";
  if (activation?.enabled && activation?.trigger_field && activation?.required_fields?.length) {
    const reqFields = activation.required_fields.join(", ");
    activationRules =
      `- Once ${activation.trigger_field} is true, check "Known lead data so far". If any of [${reqFields}] are null, keep asking for them one at a time (framed as "so we can set your account up"). Do NOT say "we've got everything we need" until all are confirmed present.\n`;
  }

  return `You are a WhatsApp sales assistant for ${business.name}.

ABOUT THE BUSINESS:
${business.description}

YOUR GOAL:
${goal}

TONE & STYLE:
${persona.tone}. ${persona.style_notes}

ANTI-HALLUCINATION (reply text):
Before writing any reply, check the "Known lead data so far" block. NEVER state, imply, or guess any specific detail that the visitor has not explicitly stated. If a detail is not in "Known lead data so far" and the visitor has not just stated it, ask for it without guessing. Same rule applies to all details.

QUALIFYING QUESTIONS (ask at most one per message, only when it fits naturally, never as a rigid checklist):
${questionsList || "(none configured)"}

WHAT COUNTS AS A HOT LEAD:
${hot_lead_criteria}

SPECIAL SITUATIONS:
${scenarioList || "(none configured)"}

${kbContext ? `RELEVANT KNOWLEDGE BASE EXCERPTS (use this to answer accurately; don't mention "knowledge base" to the visitor, just answer naturally; never invent facts beyond this):\n${kbContext}` : ""}

OUTPUT RULES (structural — do not override with business logic):
- If you don't know something, say so honestly and say a team member will follow up.
- Refund, legal, or dispute requests: do not resolve yourself. Set status "escalated", is_hot_lead false (unless it's also a genuine buying signal), and flag for human handoff.
${activationRules}
You must respond with ONLY a raw JSON object (no markdown fences, no extra
text) matching this exact shape:
{
  "reply": "the WhatsApp message to send back to the visitor",
  "lead_update": {
${leadFieldsSchema}
  },
  "status": "new" | "engaged" | "qualified" | "hot" | "escalated" | "customer",
  "is_hot_lead": boolean,
${activationTriggerLine}  "internal_note": "short note to sales rep explaining why, empty string if not hot"
}

Only set lead_update fields when the visitor actually revealed that info in
this message or earlier in the conversation; otherwise use null so existing
data isn't overwritten.

${system_prompt_extra || ""}

Set is_hot_lead true only for a genuine strong buying signal, not just casual interest.`;
}

async function getAgentReply({ history, userMessage, currentLead }) {
  const kbChunks = knowledgeBase.retrieve(userMessage, 1);
  const kbContext = kbChunks.join("\n\n---\n\n");

  if (LLM_PROVIDER === "gemini") {
    const systemInstruction = buildSystemPrompt(kbContext) + "\n\n" + `Known lead data so far: ${JSON.stringify(currentLead)}`;
    const contents = [
      ...history.map(({ role, content }) => ({
        role: role === "user" ? "user" : "model",
        parts: [{ text: content }]
      })),
      {
        role: "user",
        parts: [{ text: userMessage }]
      }
    ];

    const { data } = await withRetry(
      () =>
        axios.post(
          `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            contents,
            systemInstruction: {
              parts: [{ text: systemInstruction }]
            },
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.4
            }
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 20_000,
          }
        ),
      { label: "Gemini chat completion" }
    );

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
    return parseAgentJson(raw);
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(kbContext) },
    { role: "system", content: `Known lead data so far: ${JSON.stringify(currentLead)}` },
    ...history,
    { role: "user", content: userMessage },
  ];

  const { data } = await withRetry(
    () =>
      axios.post(
        GROQ_API_URL,
        { model: GROQ_MODEL, messages, temperature: 0.4, response_format: { type: "json_object" } },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 20_000,
        }
      ),
    { label: "Groq chat completion" }
  );

  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
  return parseAgentJson(raw);
}

function parseAgentJson(raw) {
  const cleaned = raw.replace(/^```json\s*|^```\s*|```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    logger.warn({ raw }, "Groq did not return valid JSON, falling back to raw text reply");
    return {
      reply: cleaned || "Sorry, could you say that again?",
      lead_update: {},
      status: null,
      is_hot_lead: false,
      internal_note: "",
    };
  }
}

// Fallback reply used when the Groq API is unreachable/erroring, so the
// visitor never gets silence.
function fallbackReply() {
  const cfg = getConfig();
  const fallbackMsg = cfg.fallback_message ||
    `Apologies, we're having a quick connection issue on our side. A member of our ${cfg.business?.name || "team"} has been alerted and will message you directly here shortly! Thank you for your patience. 🙏`;
  return {
    reply: fallbackMsg,
    lead_update: {},
    status: "escalated",
    is_hot_lead: false,
    internal_note: "LLM call failed — automatic fallback triggered.",
  };
}

async function plainCompletion(messages, { temperature = 0.3, maxTokens = 300 } = {}) {
  if (LLM_PROVIDER === "gemini") {
    const systemMessages = messages.filter((m) => m.role === "system");
    const otherMessages = messages.filter((m) => m.role !== "system");

    const systemInstruction = systemMessages.map((m) => m.content).join("\n\n");
    const contents = otherMessages.map(({ role, content }) => ({
      role: role === "user" ? "user" : "model",
      parts: [{ text: content }]
    }));

    const payload = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens
      }
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: systemInstruction }]
      };
    }

    const { data } = await withRetry(
      () =>
        axios.post(
          `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          payload,
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 20_000,
          }
        ),
      { label: "Gemini plain completion" }
    );

    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  }

  const { data } = await withRetry(
    () =>
      axios.post(
        GROQ_API_URL,
        { model: GROQ_MODEL, messages, temperature, max_tokens: maxTokens },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 20_000,
        }
      ),
    { label: "Groq plain completion" }
  );
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// Used by the dashboard's "Summarize" button — a short brief for a rep
// scanning a long thread, not shown to the visitor.
async function summarizeConversation(history) {
  if (!history.length) return "No messages yet.";
  const transcript = history
    .map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "Summarize this WhatsApp sales conversation in 2-3 short sentences for a sales rep " +
        "who hasn't read it yet. Focus on: what the visitor wants, any objections or concerns " +
        "raised, and where they seem to be in the buying decision. Be factual, no speculation " +
        "beyond what was said.",
    },
    { role: "user", content: transcript },
  ];
  return plainCompletion(messages, { temperature: 0.2, maxTokens: 150 });
}

// Used by the dashboard's "Suggest reply" button — drafts a reply in the
// configured persona for a REP to review/edit before sending, when they've
// taken over the conversation manually.
async function suggestReply(history, currentLead) {
  const kbChunks = knowledgeBase.retrieve(
    history.filter((m) => m.role === "user").slice(-1)[0]?.content || "",
    1
  );
  const cleanHistory = (history || [])
    .slice(-8)
    .map(({ role, content }) => ({
      role: role === "user" ? "user" : "assistant",
      content,
    }));
  const messages = [
    { role: "system", content: buildSystemPrompt(kbChunks.join("\n\n---\n\n")) },
    { role: "system", content: `Known lead data so far: ${JSON.stringify(currentLead)}` },
    {
      role: "system",
      content:
        "A human sales rep is now handling this conversation and wants a suggested reply to " +
        "review and possibly edit before sending. Respond with ONLY the suggested WhatsApp " +
        "message text — no JSON, no explanation, just the message itself.",
    },
    ...cleanHistory,
  ];
  return plainCompletion(messages, { temperature: 0.5, maxTokens: 200 });
}

module.exports = { getAgentReply, fallbackReply, summarizeConversation, suggestReply };
