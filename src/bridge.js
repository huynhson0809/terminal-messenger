import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const AUTH_TIMEOUT_MS = 5000;
const MAX_PAYLOAD = 1024 * 1024;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function loadOrCreateToken(path) {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (TOKEN_RE.test(existing)) {
      chmodSync(path, 0o600);
      return existing;
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function startBridge({ token, port = 8765, onMessage, onStatus }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: HOST, port, maxPayload: MAX_PAYLOAD });
    let current = null;

    wss.on('connection', (ws) => {
      let authed = false;
      const timer = setTimeout(() => {
        if (!authed) ws.terminate();
      }, AUTH_TIMEOUT_MS);
      timer.unref();

      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(timer);
        if (ws === current) {
          current = null;
          onStatus(false);
        }
      });

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          if (!authed) ws.terminate();
          return;
        }
        if (!authed) {
          if (
            msg === null ||
            typeof msg !== 'object' ||
            msg.type !== 'hello' ||
            !tokenMatches(token, msg.token)
          ) {
            ws.terminate();
            return;
          }
          authed = true;
          clearTimeout(timer);
          const previous = current;
          current = ws;
          if (previous) previous.terminate();
          else onStatus(true);
          return;
        }
        if (ws === current) onMessage(msg);
      });
    });

    wss.once('error', reject);
    wss.once('listening', () => {
      wss.removeListener('error', reject);
      wss.on('error', () => {});
      const address = wss.address();
      resolve({
        port: address.port,
        address,
        isConnected: () => current !== null && current.readyState === 1,
        send(msg) {
          if (!current || current.readyState !== 1) return;
          try {
            current.send(JSON.stringify(msg));
          } catch {
            // connection dropped mid-send; ignore
          }
        },
        close() {
          return new Promise((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          });
        },
      });
    });
  });
}
