"use strict";
/* Tiny HTTP helper: boot an Express app on an ephemeral port for node:test. */
async function serve(app) {
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base,
    async close() {
      await new Promise((resolve) => srv.close(resolve));
    },
  };
}

module.exports = { serve };