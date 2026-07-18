// Tiny pub/sub used to push real-time updates to the dashboard over
// Server-Sent Events (see src/dashboard.js's /api/stream route). Chosen
// over WebSockets to avoid an extra dependency — SSE is plain HTTP and
// perfectly sufficient for one-directional "something changed, go refetch
// or patch the UI" notifications.
const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(50); // generous headroom for concurrent dashboard tabs

function emitConversationEvent(waId, payload) {
  bus.emit("conversation", { waId, ...payload, at: Date.now() });
}

module.exports = { bus, emitConversationEvent };
