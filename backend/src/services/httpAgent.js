/**
 * Shared HTTP agents for connection pooling
 * Reuses TCP connections across requests to reduce latency and prevent socket exhaustion
 */

const http = require('http');
const https = require('https');

// Configure based on expected concurrent connections
const isProduction = process.env.NODE_ENV === 'production';

// HTTP agent with connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,          // Keep connections alive for 30s
  maxSockets: isProduction ? 250 : 25,  // Max concurrent connections per host
  maxFreeSockets: isProduction ? 50 : 5, // Max idle connections to keep
  timeout: 30000,                  // Socket timeout
  scheduling: 'fifo'              // First-in-first-out for fairness
});

// HTTPS agent with connection pooling
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: isProduction ? 250 : 25,
  maxFreeSockets: isProduction ? 50 : 5,
  timeout: 30000,
  scheduling: 'fifo',
  // TLS session caching for faster reconnects
  sessionTimeout: 300              // 5 minute TLS session cache
});

// Log agent stats periodically (every minute in dev, every 5 minutes in prod)
// Production logging detects connection pool exhaustion that would otherwise be invisible
let _statsTimer = null;
const statsInterval = isProduction ? 300000 : 60000;
_statsTimer = setInterval(() => {
  try {
    const httpStats = {
      pending: httpAgent.requests ? Object.keys(httpAgent.requests).length : 0,
      sockets: httpAgent.sockets ? Object.values(httpAgent.sockets).reduce((acc, arr) => acc + arr.length, 0) : 0,
      freeSockets: httpAgent.freeSockets ? Object.values(httpAgent.freeSockets).reduce((acc, arr) => acc + arr.length, 0) : 0
    };
    const httpsStats = {
      pending: httpsAgent.requests ? Object.keys(httpsAgent.requests).length : 0,
      sockets: httpsAgent.sockets ? Object.values(httpsAgent.sockets).reduce((acc, arr) => acc + arr.length, 0) : 0,
      freeSockets: httpsAgent.freeSockets ? Object.values(httpsAgent.freeSockets).reduce((acc, arr) => acc + arr.length, 0) : 0
    };

    // In dev: log whenever sockets are active. In prod: only log under pressure.
    const shouldLog = isProduction
      ? (httpsStats.sockets > httpsAgent.maxSockets * 0.8 || httpStats.pending > 0)
      : (httpStats.sockets > 0 || httpsStats.sockets > 0);

    if (shouldLog) {
      console.log(`[HttpAgent] HTTP: ${httpStats.sockets} active, ${httpStats.freeSockets} idle, ${httpStats.pending} pending | HTTPS: ${httpsStats.sockets} active, ${httpsStats.freeSockets} idle, ${httpsStats.pending} pending`);
    }
  } catch (_) { /* stats collection is non-critical */ }
}, statsInterval);
if (_statsTimer.unref) _statsTimer.unref();

// Graceful shutdown
function destroy() {
  if (_statsTimer) clearInterval(_statsTimer);
  httpAgent.destroy();
  httpsAgent.destroy();
}

process.on('SIGTERM', destroy);
process.on('SIGINT', destroy);

module.exports = {
  httpAgent,
  httpsAgent,
  destroy
};
