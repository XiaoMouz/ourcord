// Test-only accounting around the authenticated control entry point.
import control from "./control-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    let reads = 0;
    const wrap = (raw, sql) => ({
      raw, sql,
      bind(...values) { return wrap(raw.bind(...values), sql); },
      first(...args) { return raw.first(...args); },
      run(...args) { return raw.run(...args); },
    });
    const DB = {
      prepare(sql) { return wrap(env.DB.prepare(sql), sql); },
      async batch(statements) {
        const results = await env.DB.batch(statements.map((statement) => statement.raw));
        statements.forEach((statement, i) => {
          if (/DELETE FROM peer_connectivity/.test(statement.sql)) reads += results[i].meta.rows_read;
        });
        return results;
      },
    };
    const response = await control.fetch(request, { ...env, DB }, ctx);
    response.headers.set("X-Test-Topology-Reads", String(reads));
    return response;
  },
};
