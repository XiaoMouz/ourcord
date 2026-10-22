// Test-only D1 mutation accounting. Execute the original statements/batches.
import service from "./service-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    let rowsRead = 0;
    let rowsWritten = 0;
    const originals = new WeakMap();
    function record(result) {
      rowsRead += result.meta.rows_read;
      rowsWritten += result.meta.rows_written;
      return result;
    }
    function wrap(statement) {
      const wrapped = {
        bind(...values) { return wrap(statement.bind(...values)); },
        first(...args) { return statement.first(...args); },
        async run(...args) { return record(await statement.run(...args)); },
      };
      originals.set(wrapped, statement);
      return wrapped;
    }
    const DB = {
      prepare(sql) { return wrap(env.DB.prepare(sql)); },
      async batch(statements) {
        return (await env.DB.batch(statements.map((statement) => originals.get(statement)))).map(record);
      },
    };
    const response = await service.fetch(request, { ...env, DB }, ctx);
    response.headers.set("X-Test-Mutation-Reads", String(rowsRead));
    response.headers.set("X-Test-Mutation-Writes", String(rowsWritten));
    return response;
  },
};
