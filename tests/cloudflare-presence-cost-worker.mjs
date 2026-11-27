// Test-only wrapper: expose real D1 statement metrics without changing SQL.
import service from "./service-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    let rowsRead = 0;
    let rowsWritten = 0;
    function wrap(statement) {
      return {
        bind(...values) { return wrap(statement.bind(...values)); },
        first(...args) { return statement.first(...args); },
        async run(...args) {
          const result = await statement.run(...args);
          rowsRead += result.meta.rows_read;
          rowsWritten += result.meta.rows_written;
          return result;
        },
      };
    }
    const DB = { prepare(sql) { return wrap(env.DB.prepare(sql)); } };
    const response = await service.fetch(request, { ...env, DB }, ctx);
    response.headers.set("X-Test-D1-Rows-Read", String(rowsRead));
    response.headers.set("X-Test-D1-Rows-Written", String(rowsWritten));
    return response;
  },
};
