// Ensures two messages arriving close together from the SAME visitor are
// handled one at a time (read session -> call LLM -> save session), so a
// slow LLM call can't cause a lost update when a second message arrives
// mid-flight. Different visitors still run fully in parallel.
const tails = new Map(); // waId -> tail promise of the current queue

function withUserLock(waId, fn) {
  const previous = tails.get(waId) || Promise.resolve();

  // Run fn() only after whatever came before it has settled (success or failure)
  const run = previous.then(fn, fn);

  // Keep the chain alive for the next caller, but never let a rejection
  // here break the *next* person's turn.
  const tail = run.catch(() => {});
  tails.set(waId, tail);

  tail.finally(() => {
    if (tails.get(waId) === tail) tails.delete(waId);
  });

  return run;
}

module.exports = { withUserLock };
