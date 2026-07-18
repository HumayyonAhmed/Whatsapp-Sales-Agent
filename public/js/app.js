// Dashboard frontend. Plain JS, no build step — matches this project's
// zero-toolchain philosophy. Talks to /api/* (src/dashboard.js) and
// /api/stream (SSE) for real-time updates.

const state = {
  adminKey: sessionStorage.getItem("adminKey") || null,
  conversations: [],
  stages: [],
  selectedWaId: null,
  selectedSession: null,
  stageFilter: "",
  search: "",
};

// ---------------- API helpers ----------------

async function api(pathAndQuery, opts = {}) {
  const res = await fetch(`/api${pathAndQuery}`, {
    ...opts,
    headers: { "x-admin-key": state.adminKey, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    logout();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

async function apiUpload(pathAndQuery, formData) {
  const res = await fetch(`/api${pathAndQuery}`, {
    method: "POST",
    headers: { "x-admin-key": state.adminKey },
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Upload failed (${res.status})`);
  }
  return res.json();
}

// ---------------- Auth ----------------

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  boot();
}

function showLogin(errorMsg) {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-error").textContent = errorMsg || "";
}

function logout() {
  sessionStorage.removeItem("adminKey");
  state.adminKey = null;
  const appEl = document.getElementById("app");
  appEl.classList.remove("show-chat", "show-menu", "show-drawer");
  document.getElementById("drawer-overlay").classList.add("hidden");
  showLogin();
}

document.getElementById("login-submit").addEventListener("click", async () => {
  const key = document.getElementById("login-key").value.trim();
  if (!key) return;
  state.adminKey = key;
  try {
    await api("/conversations"); // validates the key
    sessionStorage.setItem("adminKey", key);
    showApp();
  } catch {
    state.adminKey = null;
    document.getElementById("login-error").textContent = "Invalid admin key.";
  }
});
document.getElementById("login-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-submit").click();
});
document.getElementById("logout-btn").addEventListener("click", logout);

// ---------------- Boot ----------------

async function boot() {
  await loadStages();
  await Promise.all([loadAnalytics(), loadConversations()]);
  connectStream();
}

if (state.adminKey) showApp();
else showLogin();

// ---------------- Analytics ----------------

async function loadAnalytics() {
  const a = await api("/analytics?days=30");
  document.getElementById("m-newLeads").textContent = a.newLeads;
  document.getElementById("m-hotLeads").textContent = a.hotLeads;
  document.getElementById("m-demosBooked").textContent = a.demosBooked;
  document.getElementById("m-conversionRate").textContent = `${a.conversionRate}%`;
}

// ---------------- Stage filters ----------------

async function loadStages() {
  state.stages = await api("/stages");
  const container = document.getElementById("stage-filters");
  state.stages.forEach((stage) => {
    const btn = document.createElement("button");
    btn.className = "stage-chip";
    btn.dataset.stage = stage;
    btn.textContent = stage;
    container.appendChild(btn);
  });
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".stage-chip");
    if (!btn) return;
    container.querySelectorAll(".stage-chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.stageFilter = btn.dataset.stage || "";
    loadConversations();
    
    // Close left rail menu on mobile/tablet after click
    const appEl = document.getElementById("app");
    appEl.classList.remove("show-menu");
    document.getElementById("drawer-overlay").classList.add("hidden");
  });
}

// ---------------- Inbox list ----------------

let searchDebounce;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.search = e.target.value.trim();
    loadConversations();
  }, 250);
});

async function loadConversations() {
  const params = new URLSearchParams();
  if (state.stageFilter) params.set("stage", state.stageFilter);
  if (state.search) params.set("search", state.search);
  state.conversations = await api(`/conversations?${params.toString()}`);
  renderInboxList();
}

function timeAgo(ts) {
  if (!ts) return "";
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.round(diffHr / 24)}d`;
}

function stageTagClass(stage) {
  if (stage === "Won") return "tag won";
  if (stage === "Lost") return "tag lost";
  return "tag";
}

function renderInboxList() {
  const list = document.getElementById("inbox-list");
  list.innerHTML = "";
  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-state" style="height:auto;padding:30px 16px;">No conversations yet.</div>`;
    return;
  }
  for (const c of state.conversations) {
    const row = document.createElement("div");
    row.className = "conv-row" + (c.waId === state.selectedWaId ? " selected" : "");
    row.dataset.waid = c.waId;
    row.innerHTML = `
      <div class="conv-row-top">
        <span class="conv-row-name">${escapeHtml(c.name || c.waId)}</span>
        <span class="conv-row-time">${timeAgo(c.updatedAt)}</span>
      </div>
      <div class="conv-row-preview">${escapeHtml(c.lastMessage?.preview || "No messages yet")}</div>
      <div class="conv-row-tags">
        ${c.unreadCount ? `<span class="unread-dot"></span><span class="unread-count">${c.unreadCount}</span>` : ""}
        ${c.isHot ? `<span class="tag hot">🔥 Hot</span>` : ""}
        ${c.isEscalated ? `<span class="tag escalated">⚠️ Escalated</span>` : ""}
        ${c.activationReady ? `<span class="tag activation-ready">🚀 Ready</span>` : ""}
        <span class="${stageTagClass(c.stage)}">${escapeHtml(c.stage)}</span>
        ${c.paused ? `<span class="tag">Paused</span>` : ""}
      </div>
    `;
    row.addEventListener("click", () => selectConversation(c.waId));
    list.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- Conversation detail ----------------

async function selectConversation(waId) {
  state.selectedWaId = waId;
  renderInboxList(); // update selected highlight
  const session = await api(`/conversations/${encodeURIComponent(waId)}`);
  state.selectedSession = session;
  api(`/conversations/${encodeURIComponent(waId)}/read`, { method: "POST" }).then(loadConversations);

  document.getElementById("conversation-empty").classList.add("hidden");
  document.getElementById("conversation-active").classList.remove("hidden");
  document.getElementById("lead-drawer").classList.remove("hidden");
  
  // Transition views on mobile/tablet
  const appEl = document.getElementById("app");
  appEl.classList.add("show-chat");
  appEl.classList.remove("show-menu", "show-drawer");
  document.getElementById("drawer-overlay").classList.add("hidden");

  document.getElementById("conv-name").textContent = session.lead.name || waId;
  document.getElementById("conv-waid").textContent = waId;

  renderPauseControls(session);
  renderStageStepper(session);
  renderSummary(session);
  renderMessages(session);
  renderLeadDrawer(session);
}

function renderPauseControls(session) {
  document.getElementById("paused-indicator").classList.toggle("hidden", !session.paused);
  document.getElementById("pause-btn").classList.toggle("hidden", session.paused);
  document.getElementById("resume-btn").classList.toggle("hidden", !session.paused);
}

function renderStageStepper(session) {
  const forward = ["New", "Qualified", "Demo Scheduled", "Demo Completed", "Won"];
  const el = document.getElementById("stage-stepper");
  el.innerHTML = "";
  const currentIdx = forward.indexOf(session.stage);

  forward.forEach((stage, i) => {
    const node = document.createElement("button");
    node.className = "stage-node " + (i < currentIdx ? "done" : i === currentIdx ? "current" : "");
    node.textContent = stage;
    node.addEventListener("click", () => setStage(session.waId || state.selectedWaId, stage));
    el.appendChild(node);
    if (i < forward.length - 1) {
      const connector = document.createElement("div");
      connector.className = "stage-connector";
      el.appendChild(connector);
    }
  });

  const lostNode = document.createElement("button");
  lostNode.className = "stage-node lost" + (session.stage === "Lost" ? " current" : "");
  lostNode.style.marginLeft = "8px";
  lostNode.textContent = "Lost";
  lostNode.addEventListener("click", () => setStage(state.selectedWaId, "Lost"));
  el.appendChild(lostNode);
}

async function setStage(waId, stage) {
  await api(`/conversations/${encodeURIComponent(waId)}/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage }),
  });
  await selectConversation(waId);
  loadConversations();
  loadAnalytics();
}

function renderSummary(session) {
  document.getElementById("summary-text").textContent =
    session.summary || "No summary yet — click Summarize for a quick brief.";
}

function renderMessages(session) {
  const el = document.getElementById("messages");
  el.innerHTML = "";
  for (const m of session.history) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}`;
    const label = m.role === "user" ? "Visitor" : m.role === "agent" ? "You" : "Bot";
    const time = new Date(m.timestamp).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });

    let bodyHtml = escapeHtml(m.content);
    if (m.type === "image" && m.mediaId) {
      bodyHtml += `<div class="msg-media"><img src="/api/media/${m.mediaId}?key=${encodeURIComponent(state.adminKey)}" alt="${escapeHtml(m.caption || "image")}" /></div>`;
    } else if (m.type === "document" && m.mediaId) {
      bodyHtml += `<div class="msg-media"><a href="/api/media/${m.mediaId}?key=${encodeURIComponent(state.adminKey)}" target="_blank">📄 ${escapeHtml(m.filename || "document")}</a></div>`;
    }

    div.innerHTML = `${bodyHtml}<div class="msg-meta">${label} · ${time}</div>`;
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function renderLeadDrawer(session) {
  const dl = document.getElementById("lead-fields");
  const fields = [
    ["Use case", session.lead.use_case],
    ["Budget", session.lead.budget],
    ["Timeline", session.lead.timeline],
    ["Email", session.lead.email],
    ["Score", `${session.lead.score}/100`],
    ["AI status", session.lead.status],
  ];
  dl.innerHTML = fields
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value || "—")}</dd>`)
    .join("");
}

// ---------------- Pause / resume ----------------

document.getElementById("pause-btn").addEventListener("click", async () => {
  await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/pause`, { method: "POST" });
  selectConversation(state.selectedWaId);
  loadConversations();
});
document.getElementById("resume-btn").addEventListener("click", async () => {
  await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/resume`, { method: "POST" });
  selectConversation(state.selectedWaId);
  loadConversations();
});

// ---------------- AI helpers ----------------

document.getElementById("summarize-btn").addEventListener("click", async (e) => {
  e.target.textContent = "Summarizing…";
  e.target.disabled = true;
  try {
    const { summary } = await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/summary`, { method: "POST" });
    document.getElementById("summary-text").textContent = summary;
  } catch (err) {
    document.getElementById("summary-text").textContent = "Couldn't generate a summary right now.";
  } finally {
    e.target.textContent = "Summarize";
    e.target.disabled = false;
  }
});

document.getElementById("suggest-btn").addEventListener("click", async (e) => {
  e.target.textContent = "Thinking…";
  e.target.disabled = true;
  try {
    const { suggestion } = await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/suggest-reply`, { method: "POST" });
    document.getElementById("composer-input").value = suggestion;
  } catch {
    alert("Couldn't generate a suggestion right now.");
  } finally {
    e.target.textContent = "Suggest reply";
    e.target.disabled = false;
  }
});

// ---------------- Composer: send text ----------------

document.getElementById("send-btn").addEventListener("click", sendText);
document.getElementById("composer-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

async function sendText() {
  const input = document.getElementById("composer-input");
  const text = input.value.trim();
  if (!text || !state.selectedWaId) return;
  input.value = "";
  await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", text }),
  });
  selectConversation(state.selectedWaId);
  loadConversations();
}

// ---------------- Composer: media ----------------

document.getElementById("attach-image-btn").addEventListener("click", () => document.getElementById("file-input-image").click());
document.getElementById("attach-doc-btn").addEventListener("click", () => document.getElementById("file-input-doc").click());

document.getElementById("file-input-image").addEventListener("change", (e) => sendMedia(e.target.files[0], "image"));
document.getElementById("file-input-doc").addEventListener("change", (e) => sendMedia(e.target.files[0], "document"));

async function sendMedia(file, type) {
  if (!file || !state.selectedWaId) return;
  const caption = prompt(`Caption for this ${type === "image" ? "image" : "document"}? (optional)`) || "";
  const form = new FormData();
  form.append("file", file);
  form.append("type", type);
  form.append("caption", caption);
  try {
    await apiUpload(`/conversations/${encodeURIComponent(state.selectedWaId)}/send-media`, form);
    selectConversation(state.selectedWaId);
    loadConversations();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------- Composer: buttons / list modal ----------------

document.getElementById("attach-buttons-btn").addEventListener("click", () => openButtonsModal());
document.getElementById("attach-list-btn").addEventListener("click", () => openListModal());
document.getElementById("new-conv-btn").addEventListener("click", () => openNewConversationModal());

// ---------------- New Conversation modal ----------------

function openNewConversationModal() {
  const modal = document.getElementById("modal-content");
  modal.innerHTML = `
    <h3>Start a new conversation</h3>
    <label class="modal-label">Phone number</label>
    <input id="nc-phone" type="tel" placeholder="e.g. 03001234567 or 923001234567" autocomplete="off" />
    <p class="modal-hint">Pakistani numbers starting with 0 are auto-converted (03xx → 923xx).</p>
    <label class="modal-label">Opening message</label>
    <textarea id="nc-message" rows="3" placeholder="Type your first message to this contact…">Assalam-o-Alaikum! Kya ye water supply business ka number hai?</textarea>
    <p id="nc-error" class="modal-error"></p>
    <div class="modal-actions">
      <button class="ghost-btn" id="nc-cancel">Cancel</button>
      <button class="primary-btn" id="nc-send">Send &amp; Open</button>
    </div>
  `;
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("nc-phone").focus();

  document.getElementById("nc-cancel").addEventListener("click", closeModal);

  document.getElementById("nc-send").addEventListener("click", async () => {
    const phone   = document.getElementById("nc-phone").value.trim();
    const message = document.getElementById("nc-message").value.trim();
    const errEl   = document.getElementById("nc-error");
    const sendBtn = document.getElementById("nc-send");

    if (!phone)   { errEl.textContent = "Enter a phone number."; return; }
    if (!message) { errEl.textContent = "Enter an opening message."; return; }

    sendBtn.textContent = "Sending…";
    sendBtn.disabled = true;
    errEl.textContent = "";

    try {
      const { waId } = await api("/conversations/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, message }),
      });
      closeModal();
      await loadConversations();
      selectConversation(waId);
    } catch (err) {
      errEl.textContent = err.message || "Failed to send. Check the number and try again.";
      sendBtn.textContent = "Send & Open";
      sendBtn.disabled = false;
    }
  });

  // Allow Enter in the phone field to jump to message textarea
  document.getElementById("nc-phone").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("nc-message").focus(); }
  });
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

function openButtonsModal() {
  const modal = document.getElementById("modal-content");
  modal.innerHTML = `
    <h3>Send quick-reply buttons</h3>
    <textarea id="mb-body" placeholder="Message body" rows="2"></textarea>
    <div id="mb-buttons">
      <input class="mb-button" placeholder="Button 1 label" />
      <input class="mb-button" placeholder="Button 2 label" />
      <input class="mb-button" placeholder="Button 3 label (optional)" />
    </div>
    <div class="modal-actions">
      <button class="ghost-btn" id="mb-cancel">Cancel</button>
      <button class="primary-btn" id="mb-send">Send</button>
    </div>
  `;
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("mb-cancel").addEventListener("click", closeModal);
  document.getElementById("mb-send").addEventListener("click", async () => {
    const text = document.getElementById("mb-body").value.trim();
    const buttons = [...document.querySelectorAll(".mb-button")]
      .map((i) => i.value.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    if (!text || !buttons.length) return alert("Add a message and at least one button.");
    await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "buttons", text, buttons }),
    });
    closeModal();
    selectConversation(state.selectedWaId);
    loadConversations();
  });
}

function openListModal() {
  const modal = document.getElementById("modal-content");
  modal.innerHTML = `
    <h3>Send a list message</h3>
    <textarea id="ml-body" placeholder="Message body" rows="2"></textarea>
    <input id="ml-button-label" placeholder="List button label (e.g. View options)" />
    <div id="ml-rows">
      <input class="ml-row" placeholder="Option 1" />
      <input class="ml-row" placeholder="Option 2" />
      <input class="ml-row" placeholder="Option 3 (optional)" />
    </div>
    <div class="modal-actions">
      <button class="ghost-btn" id="ml-cancel">Cancel</button>
      <button class="primary-btn" id="ml-send">Send</button>
    </div>
  `;
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("ml-cancel").addEventListener("click", closeModal);
  document.getElementById("ml-send").addEventListener("click", async () => {
    const text = document.getElementById("ml-body").value.trim();
    const buttonLabel = document.getElementById("ml-button-label").value.trim() || "Choose";
    const rows = [...document.querySelectorAll(".ml-row")]
      .map((i) => i.value.trim())
      .filter(Boolean)
      .map((title, idx) => ({ id: `opt_${idx}`, title }));
    if (!text || !rows.length) return alert("Add a message and at least one option.");
    await api(`/conversations/${encodeURIComponent(state.selectedWaId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "list", text, list: { buttonLabel, sections: [{ title: "Options", rows }] } }),
    });
    closeModal();
    selectConversation(state.selectedWaId);
    loadConversations();
  });
}

// ---------------- Real-time (SSE) ----------------

function connectStream() {
  const es = new EventSource(`/api/stream?key=${encodeURIComponent(state.adminKey)}`);
  es.onopen = () => document.getElementById("live-dot").classList.add("connected");
  es.onerror = () => document.getElementById("live-dot").classList.remove("connected");
  es.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }
    loadConversations();
    loadAnalytics();
    if (data.waId === state.selectedWaId) selectConversation(state.selectedWaId);
  };
}

// ---------------- Responsive drawer controls ----------------

document.getElementById("menu-btn").addEventListener("click", () => {
  const appEl = document.getElementById("app");
  const overlay = document.getElementById("drawer-overlay");
  appEl.classList.toggle("show-menu");
  overlay.classList.toggle("hidden", !appEl.classList.contains("show-menu"));
});

document.getElementById("back-btn").addEventListener("click", () => {
  const appEl = document.getElementById("app");
  appEl.classList.remove("show-chat");
  state.selectedWaId = null;
  renderInboxList();
});

document.getElementById("drawer-toggle-btn").addEventListener("click", () => {
  const appEl = document.getElementById("app");
  const overlay = document.getElementById("drawer-overlay");
  appEl.classList.toggle("show-drawer");
  overlay.classList.toggle("hidden", !appEl.classList.contains("show-drawer"));
});

document.getElementById("drawer-close-btn").addEventListener("click", () => {
  const appEl = document.getElementById("app");
  const overlay = document.getElementById("drawer-overlay");
  appEl.classList.remove("show-drawer");
  overlay.classList.toggle("hidden", !appEl.classList.contains("show-menu"));
});

document.getElementById("drawer-overlay").addEventListener("click", () => {
  const appEl = document.getElementById("app");
  appEl.classList.remove("show-menu", "show-drawer");
  document.getElementById("drawer-overlay").classList.add("hidden");
});
