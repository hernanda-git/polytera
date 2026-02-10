import http from 'http';
import type { WatcherOrchestrator } from '../watchers/watcher-orchestrator.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'health' });

let _server: http.Server | null = null;

/**
 * Start a simple HTTP health check server.
 *
 * GET /health — returns orchestrator health as JSON:
 *   - 200 if healthy or degraded
 *   - 503 if unhealthy
 *
 * GET /ready — returns 200 if at least one watcher is running
 */
export function startHealthServer(
  orchestrator: WatcherOrchestrator,
  port: number
): void {
  _server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const health = orchestrator.getHealth();

    if (req.url === '/health') {
      const statusCode = health.status === 'unhealthy' ? 503 : 200;

      // Serialize BigInts for JSON output
      const payload = {
        status: health.status,
        uptimeMs: health.uptimeMs,
        totalEventsDetected: health.totalEventsDetected,
        dedupHits: health.dedupHits,
        watchers: health.watchers.map((w) => ({
          name: w.name,
          state: w.state,
          lastEventAt: w.lastEventAt,
          lastBlockSeen: w.lastBlockSeen?.toString() ?? null,
          eventsDetected: w.eventsDetected,
          errors: w.errors,
          startedAt: w.startedAt,
        })),
      };

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (req.url === '/ready') {
      const isReady = health.status !== 'unhealthy';
      res.writeHead(isReady ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ ready: isReady }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  _server.listen(port, () => {
    log.info({ port }, 'Health server listening');
  });

  _server.on('error', (err) => {
    log.error({ err }, 'Health server error');
  });
}

/**
 * Gracefully close the health server.
 */
export function stopHealthServer(): void {
  if (_server) {
    _server.close();
    _server = null;
    log.info('Health server stopped');
  }
}
