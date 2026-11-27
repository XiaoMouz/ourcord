import control from "./control-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    let rowsWritten = 0;
    let rowsRead = 0;
    function wrap(raw, sql) {
      return {
        bind(...values) { return wrap(raw.bind(...values), sql); },
        async first(column) {
          const result = await raw.all();
          rowsRead += result.meta.rows_read;
          const row = result.results[0] ?? null;
          return column === undefined ? row : row?.[column] ?? null;
        },
        async all(...args) {
          const result = await raw.all(...args);
          rowsRead += result.meta.rows_read;
          return result;
        },
        async run(...args) {
          const result = await raw.run(...args);
          rowsRead += result.meta.rows_read;
          if (sql.includes("INSERT INTO peer_connectivity")) rowsWritten += result.meta.rows_written;
          return result;
        },
      };
    }
    const response = await control.fetch(request, { ...env, DB: { prepare(sql) { return wrap(env.DB.prepare(sql), sql); } } }, ctx);
    const metered = new Response(response.body, response);
    metered.headers.set("X-Test-Topology-Writes", String(rowsWritten));
    metered.headers.set("X-Test-D1-Reads", String(rowsRead));
    return metered;
  },
};
