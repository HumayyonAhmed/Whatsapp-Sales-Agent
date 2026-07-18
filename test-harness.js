// Test harness for the "trial ready to activate" flow.
// It mocks external APIs (Groq, WhatsApp) and verifies state and notifications.

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Setup env variables BEFORE loading modules
process.env.PORT = 3001;
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.WHATSAPP_APP_SECRET = ""; // skips webhook signature check

const DB_PATH = path.join(__dirname, "data", "sessions.json");
let dbBackup = null;

// Backup sessions database
if (fs.existsSync(DB_PATH)) {
  dbBackup = fs.readFileSync(DB_PATH, "utf8");
  fs.writeFileSync(DB_PATH, "{}");
} else {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, "{}");
}

// Pre-load modules to configure mocks
const groq = require("./src/groq");
const leadNotifier = require("./src/leadNotifier");
const whatsapp = require("./src/whatsapp");

// Mock arrays to store state and verify expectations
let mockAgentReplies = [];
let notifyTrialReadyCalls = [];
let notifyHotLeadCalls = [];

// Override module functions
groq.getAgentReply = async () => {
  if (mockAgentReplies.length === 0) {
    return {
      reply: "Fallback mock reply",
      lead_update: {},
      status: "engaged",
      is_hot_lead: false,
      wants_trial: false,
    };
  }
  return mockAgentReplies.shift();
};

leadNotifier.notifyTrialReady = async (args) => {
  notifyTrialReadyCalls.push(args);
};

leadNotifier.notifyHotLead = async (args) => {
  notifyHotLeadCalls.push(args);
};

whatsapp.sendText = async () => {};
whatsapp.markRead = async () => {};

// Start server
require("./src/server.js");

async function sendWebhookMessage(text) {
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
                  from: "123456789",
                  id: "msg_" + Math.random().toString(36).substring(7),
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: { body: text },
                  type: "text"
                }
              ]
            },
            field: "messages"
          }
        ]
      }
    ]
  };
  await axios.post("http://localhost:3001/webhook", payload);
}

async function runTests() {
  console.log("🚀 Starting E2E trial activation flow tests...");

  // Message 1: Visitor agrees to trial. Mock update: wants_trial: true, business_name: "Aqua Oasis".
  // Other activation fields (name, email, address) are missing.
  mockAgentReplies.push({
    reply: "Great! Let's get started. What is your name?",
    lead_update: { business_name: "Aqua Oasis" },
    status: "engaged",
    is_hot_lead: true,
    wants_trial: true,
  });

  await sendWebhookMessage("I want to start a free trial");
  console.log("Sent Message 1.");
  if (notifyTrialReadyCalls.length !== 0) {
    throw new Error("FAIL: notifyTrialReady triggered prematurely (only business_name is set)");
  }

  // Message 2: Visitor provides name. Mock update: wants_trial: true, name: "Ahmad".
  mockAgentReplies.push({
    reply: "Got it, Ahmad. What's your email address?",
    lead_update: { name: "Ahmad" },
    status: "engaged",
    is_hot_lead: true,
    wants_trial: true,
  });

  await sendWebhookMessage("My name is Ahmad");
  console.log("Sent Message 2.");
  if (notifyTrialReadyCalls.length !== 0) {
    throw new Error("FAIL: notifyTrialReady triggered prematurely (email and address still missing)");
  }

  // Message 3: Visitor provides email. Mock update: wants_trial: true, email: "ahmad@oasis.com".
  mockAgentReplies.push({
    reply: "And what is the address where we should deliver?",
    lead_update: { email: "ahmad@oasis.com" },
    status: "engaged",
    is_hot_lead: true,
    wants_trial: true,
  });

  await sendWebhookMessage("My email is ahmad@oasis.com");
  console.log("Sent Message 3.");
  if (notifyTrialReadyCalls.length !== 0) {
    throw new Error("FAIL: notifyTrialReady triggered prematurely (address still missing)");
  }

  // Message 4: Visitor provides address. Mock update: wants_trial: true, address: "123 Main St Lahore".
  // Note: Phone is null, so it should fallback/default to waId ("123456789").
  // This will complete all 5 REQUIRED_FOR_ACTIVATION fields (business_name, name, phone, email, address).
  mockAgentReplies.push({
    reply: "Perfect! We've got everything we need — our team will activate your trial shortly and confirm here.",
    lead_update: { address: "123 Main St Lahore" },
    status: "qualified",
    is_hot_lead: true,
    wants_trial: true,
  });

  await sendWebhookMessage("My address is 123 Main St Lahore");
  console.log("Sent Message 4.");

  if (notifyTrialReadyCalls.length !== 1) {
    throw new Error(`FAIL: notifyTrialReady should have fired exactly once. Count: ${notifyTrialReadyCalls.length}`);
  }

  const notification = notifyTrialReadyCalls[0];
  if (notification.waId !== "123456789") {
    throw new Error(`FAIL: unexpected waId in notification: ${notification.waId}`);
  }
  if (notification.lead.phone !== "123456789") {
    throw new Error(`FAIL: phone fallback to waId failed. Phone is: ${notification.lead.phone}`);
  }
  if (notification.lead.business_name !== "Aqua Oasis" || notification.lead.name !== "Ahmad" || notification.lead.email !== "ahmad@oasis.com" || notification.lead.address !== "123 Main St Lahore") {
    throw new Error("FAIL: missing fields in lead notification payload");
  }
  console.log("✅ notifyTrialReady fired correctly with all fields and phone fallback!");

  // Message 5: Subsequent message. wants_trial remains true, but notification should not repeat.
  mockAgentReplies.push({
    reply: "Thanks for the message.",
    lead_update: {},
    status: "qualified",
    is_hot_lead: false,
    wants_trial: true,
  });

  await sendWebhookMessage("Just checking in");
  console.log("Sent Message 5.");
  if (notifyTrialReadyCalls.length !== 1) {
    throw new Error(`FAIL: notifyTrialReady fired repeatedly! Count: ${notifyTrialReadyCalls.length}`);
  }
  console.log("✅ notifyTrialReady did not fire repeatedly!");

  // Verify dashboard api response includes trialReady: true
  const res = await axios.get("http://localhost:3001/api/conversations", {
    headers: { "x-admin-key": "test-admin-key" }
  });
  const conversation = res.data.find(c => c.waId === "123456789");
  if (!conversation) {
    throw new Error("FAIL: Conversation not found in dashboard api response");
  }
  if (conversation.trialReady !== true) {
    throw new Error(`FAIL: trialReady should be true on dashboard api, got: ${conversation.trialReady}`);
  }
  console.log("✅ Dashboard api includes trialReady: true!");

  console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉");
}

runTests()
  .catch(err => {
    console.error("❌ Test failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // Restore backup database
    if (dbBackup !== null) {
      fs.writeFileSync(DB_PATH, dbBackup);
    } else {
      try {
        fs.unlinkSync(DB_PATH);
      } catch {}
    }
    console.log("🧹 Database cleanup completed.");
    process.exit();
  });
