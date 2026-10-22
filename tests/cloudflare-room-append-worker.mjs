// Test-only entrypoint, copied beside the bundled service by the
// runtime suite. Hold each pair of room INSERTs before either reaches real D1.
import service from "./service-under-test.mjs";

let pending = { arrivals: 0 };

export default {
  fetch(request, env, ctx) {
    function wrap(statement, sql) {
      async function gate() {
        if (!sql.startsWith("INSERT INTO rooms")) return;
        const pair = pending;
        if (++pair.arrivals === 2) {
          pending = { arrivals: 0 };
        }
        // Keep each request's own event loop alive; a shared unresolved
        // promise alone is not an active I/O event in workerd.
        const deadline = Date.now() + 5000;
        while (pair.arrivals < 2) {
          if (Date.now() >= deadline) throw new Error("second room INSERT never arrived");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return {
        bind(...values) { return wrap(statement.bind(...values), sql); },
        async first(...args) { await gate(); return statement.first(...args); },
        async run(...args) { await gate(); return statement.run(...args); },
      };
    }
    const DB = { prepare(sql) { return wrap(env.DB.prepare(sql), sql); } };
    return service.fetch(request, { ...env, DB }, ctx);
  },
};
