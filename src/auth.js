// Shared admin-key auth. Accepts the key via the `x-admin-key` header
// (used by normal fetch() calls, curl, etc.) OR a `key` query param (needed
// for the SSE endpoint specifically, since browsers' EventSource API can't
// send custom headers). If ADMIN_API_KEY isn't set, protected routes are
// disabled entirely (404) rather than left open.
function requireAdminKey(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return res.status(404).json({ error: "Admin API disabled (ADMIN_API_KEY not set)" });

  const provided = req.get("x-admin-key") || req.query.key;
  if (provided !== key) return res.status(401).json({ error: "Unauthorized" });
  next();
}

module.exports = { requireAdminKey };
