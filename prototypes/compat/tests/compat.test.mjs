import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'https://s.example.test';
const issuer = 'https://compat.cloudflareaccess.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'compat-key', alg: 'RS256', use: 'sig' };
function jwt(changes = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ iss: issuer, aud: ['compat-aud'], sub: 'fixture-user', exp: now + 3600, nbf: now - 1, ...changes })}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
let mf, db, bucket, client;
const request = (path, init) => mf.dispatchFetch(origin + path, init);
const rpc = (body, token = jwt(), headers = {}) => request('/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': token, ...headers }, body: JSON.stringify(body),
});
const call = async (operation, args = {}) => {
  const result = await client.callTool({ name: 'invoke', arguments: { operation, arguments: args } });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent;
};
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "compat", modulesRoot: 'build', modules: [
      { type: 'ESModule', path: 'build/index.js' },
      { type: 'CompiledWasm', path: 'build/index_bg.wasm' },
    ],
    compatibilityDate: '2026-10-11',
    bindings: { PUBLIC_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'compat-aud' },
    d1Databases: ['DB'], r2Buckets: ['FILES'],
    outboundService: async req => {
      assert.equal(req.url, issuer + '/cdn-cgi/access/certs');
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
    },
  }] }));
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('FILES');
  await db.exec((await readFile('migrations/0001_compat.sql', 'utf8')).replaceAll('\n', ' '));
  client = new Client({ name: 'compat-probe', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    fetch: (url, init) => mf.dispatchFetch(String(url), init),
    requestInit: { headers: { 'cf-access-jwt-assertion': jwt() } },
  });
  await client.connect(transport);
});
after(async () => { await client?.close(); await mf?.dispose(); });

test('Access JWT enforcement and anonymous route separation', async () => {
  assert.equal((await request('/r/probe')).status, 200);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, '')).status, 401);
  for (const token of [jwt({ aud: ['other'] }), jwt({ iss: 'https://evil.test' }), jwt({ exp: 1 }), jwt({ nbf: 9999999999 }), jwt({}, { alg: 'none' }), jwt({}, { kid: 'unknown' }), jwt().slice(0, -12) + 'aaaaaaaaaaaa']) {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, token)).status, 401);
  }
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), { origin: 'https://evil.test' })).status, 403);
});

test('official MCP SDK discovers exactly two tools and calls Rust operations', async () => {
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['describe', 'invoke']);
  const catalog = await client.callTool({ name: 'describe', arguments: {} });
  assert(catalog.structuredContent.operations.some(op => op.name === 'prototype.echo'));
  assert.deepEqual(await call('prototype.echo', { message: 'Rust/Wasm' }), { message: 'Rust/Wasm' });
  const bad = await client.callTool({ name: 'invoke', arguments: { operation: 'prototype.echo', arguments: { message: 7 } } });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.code, 'INVALID_ARGUMENTS');
  const unknown = await rpc({ jsonrpc: '2.0', id: 8, method: 'missing' });
  assert.equal((await unknown.json()).error.code, -32601);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await request('/mcp', { headers: { 'cf-access-jwt-assertion': jwt() } })).status, 405);
});

function multipart(data, changes = {}, tail = '') {
  const boundary = 'compat-boundary';
  const metadata = { operation_id: randomUUID(), filename: 'fixture.bin', content_type: 'application/octet-stream', size_bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...changes };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}${tail || '--\r\n'}`),
  ]);
  return { metadata, body, contentType: `multipart/form-data; boundary=${boundary}` };
}
const upload = (token, form) => request('/upload', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': form.contentType }, body: form.body });

test('application token supports repeated uploads, persists only hash, expires and revokes', async () => {
  const session = await call('session.create');
  assert.equal(session.expires_at - session.created_at, 86400);
  const row = await db.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(session.session_id).first();
  assert.equal(row.token_hash, createHash('sha256').update(session.token).digest('hex'));
  for (const data of [Buffer.from('hello streaming'), Buffer.alloc(0)]) {
    const form = multipart(data);
    const res = await upload(session.token, form);
    assert.equal(res.status, 201, await res.clone().text());
    const result = await res.json();
    assert.equal(result.state, 'stored');
    assert.deepEqual(Buffer.from(await (await request('/r/' + result.resource_id)).arrayBuffer()), data);
    assert.equal((await upload(session.token, form)).status, 200);
    assert.equal((await upload(session.token, multipart(data, { ...form.metadata, filename: 'changed.bin' }))).status, 409);
  }
  await call('session.revoke', { session_id: session.session_id });
  assert.equal((await upload(session.token, multipart(Buffer.from('revoked')))).status, 401);
  const expired = await call('session.create');
  await db.prepare('UPDATE upload_sessions SET expires_at = 1 WHERE id = ?').bind(expired.session_id).run();
  assert.equal((await upload(expired.token, multipart(Buffer.from('expired')))).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, session.token)).status, 401);
});

test('length, checksum and truncated multipart failures never publish an object', async () => {
  const { token } = await call('session.create');
  for (const changes of [{ size_bytes: 1 }, { size_bytes: 99 }, { sha256: '0'.repeat(64) }]) {
    const form = multipart(Buffer.from('wrong'), changes);
    const res = await upload(token, form);
    assert.equal(res.status, 422, await res.clone().text());
    const row = await db.prepare('SELECT * FROM uploads WHERE operation_id = ?').bind(form.metadata.operation_id).first();
    assert.equal(row.state, 'failed');
    assert.equal(await bucket.head('objects/' + row.resource_id), null);
    assert.equal((await request('/r/' + row.resource_id)).status, 404);
  }
  const form = multipart(Buffer.from('truncated'));
  form.body = form.body.subarray(0, form.body.length - 16);
  assert.equal((await upload(token, form)).status, 422);
});

test('160 MiB request streams through Wasm with bounded memory and native R2 checksum', async () => {
  const { token } = await call('session.create');
  const chunk = Buffer.alloc(64 * 1024, 0xa5);
  const count = 2560;
  const hash = createHash('sha256');
  for (let i = 0; i < count; i++) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const form = multipart(Buffer.alloc(0), { size_bytes: chunk.length * count, sha256 });
  const trailer = Buffer.from('\r\n--compat-boundary--\r\n');
  const prefix = form.body.subarray(0, form.body.length - trailer.length);
  let sent = -1;
  const body = new ReadableStream({ pull(controller) {
    if (sent === -1) controller.enqueue(prefix);
    else if (sent < count) controller.enqueue(chunk);
    else { controller.enqueue(trailer); controller.close(); }
    sent++;
  } });
  const res = await request('/upload', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': form.contentType }, body, duplex: 'half' });
  assert.equal(res.status, 201, await res.clone().text());
  const result = await res.json();
  assert.equal(result.size_bytes, 160 * 1024 * 1024);
  assert(result.stream.chunks > 100);
  assert(result.stream.max_chunk_bytes < 1024 * 1024);
  assert(result.stream.wasm_memory_bytes < 16 * 1024 * 1024);
  const object = await bucket.head('objects/' + result.resource_id);
  assert.equal(Buffer.from(object.checksums.sha256).toString('hex'), sha256);
  console.log('stream evidence:', JSON.stringify({ size_bytes: result.size_bytes, ...result.stream }));
});

test('concurrent retries reserve one operation and lost response is recoverable', async () => {
  const { token } = await call('session.create');
  const form = multipart(Buffer.alloc(1024 * 1024, 3));
  const responses = await Promise.all([upload(token, form), upload(token, form)]);
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert(responses.every(r => [200, 201, 409].includes(r.status)));
  // Discard responses to emulate loss after the persistent result was committed.
  const row = await call('operation.get', { operation_id: form.metadata.operation_id });
  assert.equal(row.state, 'stored');
  assert.equal((await (await upload(token, form)).json()).resource_id, row.resource_id);
});

test('extra multipart parts and exact-length missing closing delimiter cannot publish', async () => {
  const { token } = await call('session.create');
  for (const ending of ['\r\nContent-Disposition: form-data; name="file"\r\n\r\nextra\r\n--compat-boundary--\r\n', '-']) {
    const form = multipart(Buffer.from('valid file'), {}, ending);
    const res = await upload(token, form);
    assert.equal(res.status, 422, await res.clone().text());
    const row = await db.prepare('SELECT * FROM uploads WHERE operation_id=?').bind(form.metadata.operation_id).first();
    assert.equal(row.state, 'failed');
    assert.equal(await bucket.head('objects/' + row.resource_id), null);
  }
});

test('client disconnect during file body never publishes and cleans local R2', async () => {
  const { token } = await call('session.create');
  const form = multipart(Buffer.alloc(1024 * 1024, 9));
  const controller = new AbortController();
  let bodyController;
  const body = new ReadableStream({ start(c) { bodyController = c; c.enqueue(form.body.subarray(0, 16384)); } });
  const pending = fetch(new URL('/upload', await mf.ready), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': form.contentType }, body, duplex: 'half', signal: controller.signal }).catch(() => null);
  const deadline = Date.now() + 5000;
  let row;
  try {
    do {
      row = await db.prepare('SELECT * FROM uploads WHERE operation_id=?').bind(form.metadata.operation_id).first();
      if (Date.now() > deadline) assert.fail('upload did not register before disconnect');
      await new Promise(resolve => setImmediate(resolve));
    } while (!row);
    controller.abort();
    bodyController.error(new Error('injected client disconnect'));
    await pending;
    do {
      row = await db.prepare('SELECT * FROM uploads WHERE operation_id=?').bind(form.metadata.operation_id).first();
      if (Date.now() > deadline) assert.fail(`disconnect state did not settle: ${row.state}`);
      await new Promise(resolve => setImmediate(resolve));
    } while (row.state === 'pending');
    assert.equal(row.state, 'failed');
    assert.equal(await bucket.head('objects/' + row.resource_id), null);
    assert.equal((await request('/r/' + row.resource_id)).status, 404);
  } finally { controller.abort(); }
});

test('multipart framing cannot grow without bound before file streaming', async () => {
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('small'));
  form.body = Buffer.from(form.body.toString().replace('Content-Disposition:', `X-Padding: ${'a'.repeat(300 * 1024)}\r\nContent-Disposition:`));
  assert.equal((await upload(token, form)).status, 400);
});

test('R2 success followed by D1 failure stays pending and is not publicly readable', async () => {
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('recoverable object'));
  await db.exec(`CREATE TRIGGER fail_publish BEFORE UPDATE OF state ON uploads WHEN NEW.operation_id = '${form.metadata.operation_id}' AND NEW.state = 'stored' BEGIN SELECT RAISE(FAIL, 'injected finalization failure'); END;`);
  try {
    assert.equal((await upload(token, form)).status, 500);
    const row = await call('operation.get', { operation_id: form.metadata.operation_id });
    assert.equal(row.state, 'pending');
    assert.equal((await bucket.head('objects/' + row.resource_id)).size, form.metadata.size_bytes);
    assert.equal((await request('/r/' + row.resource_id)).status, 404);
    assert.equal((await upload(token, form)).status, 409);
  } finally {
    await db.exec('DROP TRIGGER fail_publish;');
  }
});
