import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
try { config = loadConfig(); } catch (error) { console.error(error.message); process.exit(1); }
const { app, cancelActive } = createApp({ config });
const server = app.listen(config.port, '0.0.0.0', () => console.info(`Fitler scraper listening on port ${config.port}`));
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;
server.maxConnections = 100;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  cancelActive();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
