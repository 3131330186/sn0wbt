import { isIPv4 } from 'node:net';

export function isLoopbackHostHeader(host) {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
}

export function isLocalConsoleRequest(req) {
  const peer = String(req.socket?.remoteAddress ?? '').toLowerCase();
  const ip = peer.replace(/^::ffff:/, '');
  const loopback = peer === '::1' || (isIPv4(ip) && ip.startsWith('127.'));
  return loopback && isLoopbackHostHeader(req.headers.host);
}

export function authorizeConsoleRequest(req, token) {
  if (isLocalConsoleRequest(req)) return true;
  if (!token) return false;
  const url = new URL(req.url, 'http://127.0.0.1');
  return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
}
