import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index";

startBot();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Keep-alive self-ping: hit /ping every 4 minutes so Replit never puts
  // the process to sleep due to inactivity.  Works in tandem with an
  // external uptime monitor (e.g. UptimeRobot) hitting the same endpoint.
  const PING_INTERVAL_MS = 4 * 60 * 1000;
  setInterval(() => {
    // Prefer the public Replit domain so the request goes through the proxy
    const domains = process.env["REPLIT_DOMAINS"];
    const base = domains
      ? `https://${domains.split(",")[0]}`
      : `http://localhost:${port}`;
    fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(10_000) })
      .then(() => logger.debug("Keep-alive ping sent"))
      .catch((e: unknown) => logger.warn({ err: e }, "Keep-alive ping failed"));
  }, PING_INTERVAL_MS).unref(); // .unref() so the timer never blocks graceful shutdown
});
