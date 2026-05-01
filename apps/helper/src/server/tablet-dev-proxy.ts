import { connect } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';

const DEV_SERVER_UNAVAILABLE_BODY = 'Tablet dev server unavailable.';
const DEV_SERVER_UNAVAILABLE_HEADERS = {
  'cache-control': 'no-cache, no-store, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'content-type': 'text/plain; charset=utf-8'
} as const;

export type TabletDevProxy = {
  target: string;
  fetch(request: Request): Promise<Response>;
  proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
};

export function createTabletDevProxy(target: string): TabletDevProxy {
  const targetUrl = new URL(target);

  return {
    target,
    async fetch(request: Request): Promise<Response> {
      const incoming = new URL(request.url);
      const upstream = new URL(incoming.pathname + incoming.search, targetUrl);

      const headers = new Headers(request.headers);
      headers.set('host', targetUrl.host);
      headers.delete('accept-encoding');

      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: 'manual'
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer();
      }

      try {
        const response = await fetch(upstream, init);
        const responseHeaders = new Headers(response.headers);
        const contentType = responseHeaders.get('content-type') ?? '';
        if (contentType.includes('text/html')) {
          responseHeaders.set('cache-control', 'no-cache, no-store, must-revalidate');
          responseHeaders.set('pragma', 'no-cache');
          responseHeaders.set('expires', '0');
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch {
        return devServerUnavailableResponse();
      }
    },
    proxyUpgrade(request, clientSocket, head) {
      const upstreamHost = targetUrl.hostname;
      const upstreamPort = Number(targetUrl.port) || 80;
      let connected = false;
      const upstreamSocket = connect(upstreamPort, upstreamHost, () => {
        connected = true;
        const requestLine = `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1\r\n`;
        const headerLines = [`Host: ${targetUrl.host}`];
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'undefined' || name.toLowerCase() === 'host') {
            continue;
          }
          if (Array.isArray(value)) {
            for (const item of value) {
              headerLines.push(`${name}: ${item}`);
            }
          } else {
            headerLines.push(`${name}: ${value}`);
          }
        }
        upstreamSocket.write(`${requestLine}${headerLines.join('\r\n')}\r\n\r\n`);
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });

      const cleanup = () => {
        clientSocket.destroy();
        upstreamSocket.destroy();
      };
      upstreamSocket.on('error', () => {
        if (!connected && !clientSocket.destroyed && clientSocket.writable) {
          clientSocket.end(devServerUnavailableUpgradeResponse());
          upstreamSocket.destroy();
          return;
        }
        cleanup();
      });
      clientSocket.on('error', cleanup);
    }
  };
}

function devServerUnavailableResponse(): Response {
  return new Response(DEV_SERVER_UNAVAILABLE_BODY, {
    status: 503,
    headers: DEV_SERVER_UNAVAILABLE_HEADERS
  });
}

function devServerUnavailableUpgradeResponse(): string {
  return [
    'HTTP/1.1 503 Service Unavailable',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(DEV_SERVER_UNAVAILABLE_BODY)}`,
    'Cache-Control: no-cache, no-store, must-revalidate',
    'Pragma: no-cache',
    'Expires: 0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    DEV_SERVER_UNAVAILABLE_BODY
  ].join('\r\n');
}
