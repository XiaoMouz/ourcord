// Test-only D1 accounting around the real authenticated upload route.
import service from "./service-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    let reads = 0, writes = 0;
    function wrap(statement) {
      const measure = (result) => {
        reads += result.meta.rows_read;
        writes += result.meta.rows_written;
        return result;
      };
      return {
        bind(...values) { return wrap(statement.bind(...values)); },
        async first(column) {
          const row = measure(await statement.all()).results[0];
          return row ? (column === undefined ? row : row[column]) : null;
        },
        async all(...args) { return measure(await statement.all(...args)); },
        async run(...args) { return measure(await statement.run(...args)); },
      };
    }
    const response = await service.fetch(request, {
      ...env, DB: { prepare(sql) { return wrap(env.DB.prepare(sql)); } },
    }, ctx);
    response.headers.set("X-Test-D1-Reads", String(reads));
    response.headers.set("X-Test-D1-Writes", String(writes));
    return response;
  },
};
