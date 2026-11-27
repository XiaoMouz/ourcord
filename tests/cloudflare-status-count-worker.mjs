import control from "./control-under-test.mjs";

export default {
  async fetch(request, env, ctx) {
    const reads = {};
    const pending = [];
    function wrap(raw, sql) {
      return {
        bind(...values) { return wrap(raw.bind(...values), sql); },
        all(...args) { return raw.all(...args); },
        async first(column) {
          const table = sql.match(/COUNT\(\*\).*FROM (users|peers|relay_servers|bans)/)?.[1];
          if (!table) return raw.first(column);
          const result = await raw.all();
          reads[table] = result.meta.rows_read;
          const row = result.results[0] ?? null;
          return column === undefined ? row : row?.[column] ?? null;
        },
      };
    }
    const response = await control.fetch(request, { ...env, DB: { prepare(sql) { return wrap(env.DB.prepare(sql), sql); } } }, {
      waitUntil(promise) { pending.push(promise); ctx.waitUntil(promise); },
    });
    // Make the subsequent request deterministic once the background cache
    // write has finished, while still invoking native waitUntil.
    await Promise.all(pending);
    const metered = new Response(response.body, response);
    metered.headers.set("X-Test-Count-Reads", JSON.stringify(reads));
    return metered;
  },
};
