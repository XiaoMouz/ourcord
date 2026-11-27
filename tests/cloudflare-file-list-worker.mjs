// Test-only accounting around the unchanged authenticated service entry point.
import service from "./service-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    let reads = 0;
    function wrap(statement) {
      return {
        bind(...values) { return wrap(statement.bind(...values)); },
        first(...args) { return statement.first(...args); },
        async all(...args) {
          const result = await statement.all(...args);
          reads += result.meta.rows_read;
          return result;
        },
      };
    }
    const response = await service.fetch(request, { ...env, DB: { prepare(sql) { return wrap(env.DB.prepare(sql)); } } }, ctx);
    response.headers.set("X-Test-File-List-Reads", String(reads));
    return response;
  },
};
