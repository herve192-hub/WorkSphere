const http = require("node:http");
const { connectAuditDatabase } = require("../outbox/connection");
const { createAuditService } = require("./app");

/** Own one native Audit client and HTTP listener; never open the API connection. */
async function startAuditService(config) {
  const connection = await connectAuditDatabase(config.mongoUri);
  let server;
  try {
    const service = createAuditService({ db: connection.db, keys: config.keys });
    await service.initialize();
    // Bound slow headers/body reads and idle sockets. A timed-out delivery may
    // still persist; sender retries must retain its event ID and deduplicate it.
    // Check incomplete requests every second instead of Node's 30-second default.
    server = http.createServer({ headersTimeout: 5000, requestTimeout: 10000,
      connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 }, service.app);
    server.setTimeout(10000, (socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.removeListener("error", reject); resolve(); });
    });
    let closing;
    return {
      server,
      close() {
        if (closing) return closing;
        // Stop admitting new work before draining active requests. Force-close
        // sockets after ten seconds; no partial/unknown write is acknowledged.
        service.beginShutdown();
        closing = (async () => {
          const timer = setTimeout(() => server.closeAllConnections(), 10000).unref();
          try { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
          finally { clearTimeout(timer); await connection.client.close(); }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await connection.client.close();
    throw error;
  }
}

module.exports = { startAuditService };
