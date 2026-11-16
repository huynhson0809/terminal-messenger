import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadOrCreateToken, startBridge } from '../src/bridge.js';

const TOKEN = 'a'.repeat(64);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t) {
  const messages = [];
  const statuses = [];
  const bridge = await startBridge({
    token: TOKEN,
    port: 0,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
  });
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.terminate();
    await bridge.close();
  });
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    clients.push(ws);
    ws.closed = new Promise((r) => ws.on('close', r));
    ws.received = [];
    ws.on('message', (d) => ws.received.push(JSON.parse(d.toString())));
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    return ws;
  };
  return { bridge, messages, statuses, connect };
}

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'condition not met in time');
};
const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

test('loadOrCreateToken creates 64-hex 0600 file and reuses it', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'nested', 'token');
  const a = loadOrCreateToken(path);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
  assert.equal(readFileSync(path, 'utf8').trim(), a);
  assert.equal(loadOrCreateToken(path), a);
});

test('binds to 127.0.0.1 and exposes real port', async (t) => {
  const { bridge } = await setup(t);
  assert.ok(bridge.port > 0);
  assert.equal(bridge.address.address, '127.0.0.1');
});

test('authenticated client triggers onStatus(true) and messages arrive', async (t) => {
  const { messages, statuses, bridge, connect } = await setup(t);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await until(() => statuses.length === 1);
  assert.deepEqual(statuses, [true]);
  assert.equal(bridge.isConnected(), true);
  ws.send(JSON.stringify({ type: 'incoming', text: 'hi' }));
  await until(() => messages.length === 1);
  assert.deepEqual(messages[0], { type: 'incoming', text: 'hi' });
  bridge.send({ type: 'send', text: 'yo' });
  await until(() => ws.received.length === 1);
  assert.deepEqual(ws.received[0], { type: 'send', text: 'yo' });
});

for (const [name, first] of [
  ['wrong token', JSON.stringify({ type: 'hello', token: 'b'.repeat(64) })],
  ['short token', JSON.stringify({ type: 'hello', token: 'abc' })],
  ['missing token', JSON.stringify({ type: 'hello' })],
  ['non-string token', JSON.stringify({ type: 'hello', token: 5 })],
  ['wrong type', JSON.stringify({ type: 'nope', token: TOKEN })],
  ['non-JSON', 'not json'],
]) {
  test(`rejects ${name}: closed, no status`, async (t) => {
    const { statuses, messages, bridge, connect } = await setup(t);
    const ws = await connect();
    ws.send(first);
    await ws.closed;
    await tick();
    assert.deepEqual(statuses, []);
    assert.deepEqual(messages, []);
    assert.equal(bridge.isConnected(), false);
  });
}

test('send after disconnect does not throw; isConnected false', async (t) => {
  const { statuses, bridge, connect } = await setup(t);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await until(() => bridge.isConnected());
  ws.close();
  await until(() => statuses.includes(false));
  assert.equal(bridge.isConnected(), false);
  assert.doesNotThrow(() => bridge.send({ type: 'x' }));
});

test('second authenticated client replaces the first', async (t) => {
  const { statuses, messages, bridge, connect } = await setup(t);
  const a = await connect();
  a.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await until(() => bridge.isConnected());
  const b = await connect();
  b.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await a.closed;
  await tick();
  assert.equal(bridge.isConnected(), true);
  assert.ok(!statuses.includes(false), 'old close must not report disconnected');
  b.send(JSON.stringify({ n: 1 }));
  await until(() => messages.length === 1);
  bridge.send({ to: 'b' });
  await until(() => b.received.length === 1);
  assert.equal(a.received.length, 0);
});

test('unauthenticated client cannot displace the live one', async (t) => {
  const { bridge, connect, statuses } = await setup(t);
  const a = await connect();
  a.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await until(() => bridge.isConnected());
  const evil = await connect();
  evil.send(JSON.stringify({ type: 'hello', token: 'c'.repeat(64) }));
  await evil.closed;
  await tick();
  assert.equal(bridge.isConnected(), true);
  assert.deepEqual(statuses, [true]);
});

test('close() shuts down server and clients', async (t) => {
  const { bridge, connect } = await setup(t);
  const a = await connect();
  a.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await until(() => bridge.isConnected());
  await bridge.close();
  await a.closed;
  assert.equal(bridge.isConnected(), false);
});
