// Test-only entry into the production cron handler, retaining real D1 metrics.
import service from "./service-under-test.mjs";

export default {
  async fetch(_request, env, ctx) {
    const selections = [];
    let writes = 0;
    function wrap(statement, sql) {
      return {
        bind(...values) { return wrap(statement.bind(...values), sql); },
        async all() {
          const result = await statement.all();
          if (sql.includes("FROM file_backends")) selections.push({
            ids: result.results.map((row) => row.id), reads: result.meta.rows_read,
          });
          return result;
        },
        async run() {
          const result = await statement.run();
          if (sql.startsWith("UPDATE file_backends")) writes += result.meta.rows_written;
          return result;
        },
      };
    }
    const DB = { prepare(sql) { return wrap(env.DB.prepare(sql), sql); } };
    await service.scheduled({}, { ...env, DB }, ctx);
    return Response.json({ selections, writes });
  },
};
