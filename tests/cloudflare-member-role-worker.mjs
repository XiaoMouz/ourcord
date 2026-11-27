// Test-only pause immediately before the real D1 role write.
import service from "./service-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    function wrap(statement, sql) {
      return {
        bind(...values) { return wrap(statement.bind(...values), sql); },
        first(...args) { return statement.first(...args); },
        async run(...args) {
          if (sql.includes("UPDATE lobby_members") && request.headers.has("X-Test-Pause-Role")) {
            await fetch("https://role-gate.test/");
          }
          return statement.run(...args);
        },
      };
    }
    return service.fetch(request, {
      ...env, DB: { prepare(sql) { return wrap(env.DB.prepare(sql), sql); } },
    }, ctx);
  },
};
