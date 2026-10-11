import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
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
let mf, db, kv, client;
let failPut = false, failGet = false, collide = false;
let onPut;
let clockOffset = 0;
const now = () => Math.floor(Date.now() / 1000);
const create = (extra = {}) => call('resource.create_url', { operation_id: randomUUID(), target_url: 'https://example.com/', ...extra });
const errorCall = async (operation, args, code) => {
  const result = await client.callTool({ name: 'invoke', arguments: { operation, arguments: args } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, code, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes('secret-must-not-leak'), false);
  return result.structuredContent.error;
};
const cron = async () => (await mf.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() });
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
    name: "service", modulesRoot: '.', modules: [
      { type: 'ESModule', path: 'tests/worker-fixture.mjs' },
      { type: 'ESModule', path: 'build/index.js' },
      { type: 'CompiledWasm', path: 'build/index_bg.wasm' },
    ],
    compatibilityDate: '2026-10-11',
    bindings: { PUBLIC_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'compat-aud' },
    d1Databases: ['DB'], kvNamespaces: ['MAPPINGS'],
    serviceBindings: { FAULTS: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/request') { const result = Response.json({ collide, offset: clockOffset }); collide = false; return result; }
      if (path === '/kv-put') {
        if (onPut) await onPut(await req.json());
        if (failPut) return new Response('failure', { status: 503 });
      }
      if (path === '/kv-get' && failGet) return new Response('failure', { status: 503 });
      return Response.json({ offset: clockOffset });
    } },
    outboundService: async req => {
      assert.equal(req.url, issuer + '/cdn-cgi/access/certs');
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
    },
  }] }));
  db = await mf.getD1Database('DB');
  kv = await mf.getKVNamespace('MAPPINGS');
  await db.exec((await readFile('migrations/0001_resources.sql', 'utf8')).replaceAll('\n', ' '));
  client = new Client({ name: 'service-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    fetch: (url, init) => mf.dispatchFetch(String(url), init),
    requestInit: { headers: { 'cf-access-jwt-assertion': jwt() } },
  });
  await client.connect(transport);
});
after(async () => { await client?.close(); await mf?.dispose(); });


test('formal URL create is idempotent and anonymously redirects with a 12-character ID', async () => {
  const args = { operation_id: randomUUID(), target_url: 'https://example.com/a?b=1', title: '测试', tags: ['docs'] };
  const created = await call('resource.create_url', args);
  assert.match(created.resource.id, /^[A-Za-z0-9]{12}$/);
  assert.equal(created.resource.state, 'published');
  assert.equal(created.operation.status, 'completed');
  assert.equal(created.operation.steps.kv, 'accepted');
  assert.equal((await call('resource.create_url', args)).resource.id, created.resource.id);
  const response = await request('/r/' + created.resource.id, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), args.target_url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Access assertion verification, origin checks and MCP protocol boundaries', async () => {
  assert.equal((await request('/mcp')).status, 401);
  for (const token of [jwt({ aud: ['other'] }), jwt({ iss: 'https://evil.test' }), jwt({ exp: 1 }), jwt({ nbf: 9999999999 }), jwt({}, { alg: 'none' }), jwt({}, { kid: 'unknown' }), jwt().slice(0, -12) + 'aaaaaaaaaaaa']) {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, token)).status, 401);
  }
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), { origin: 'https://evil.test' })).status, 403);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), { 'mcp-protocol-version': 'bad' })).status, 400);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), { accept: 'application/json' })).status, 406);
  assert.equal((await request('/mcp', { headers: { 'cf-access-jwt-assertion': jwt() } })).status, 405);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping', extra: 'x'.repeat(66000) })).status, 413);
  const unknown = await rpc({ jsonrpc: '2.0', id: 3, method: 'missing' });
  assert.equal((await unknown.json()).error.code, -32601);
  assert.equal((await request('/r/invalid')).headers.get('cache-control'), 'no-store');
  assert.equal(await (await request('/r/invalid', { method: 'HEAD' })).text(), '');
  assert.equal((await request('/upload', { method: 'POST' })).status, 404);
});

test('two tools discover strict operation schemas, results, side effects and valid examples', async () => {
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['describe', 'invoke']);
  const catalog = await client.callTool({ name: 'describe', arguments: {} });
  assert.equal(catalog.structuredContent.operations.length, 8);
  const invalidDescribe = await client.callTool({ name: 'describe', arguments: { operation: null } });
  assert.equal(invalidDescribe.isError, true);
  for (const op of catalog.structuredContent.operations) {
    const detail = await client.callTool({ name: 'describe', arguments: { operation: op.name } });
    assert.equal(detail.isError, false);
    assert.equal(detail.structuredContent.inputSchema.additionalProperties, false);
    assert(detail.structuredContent.result && detail.structuredContent.side_effects);
    await errorCall(op.name, { ...detail.structuredContent.example, unknown_field: true }, 'INVALID_ARGUMENTS');
  }
  const base = { operation_id: randomUUID(), target_url: 'https://example.com/' };
  for (const changes of [{ title: null }, { tags: ['duplicate', 'duplicate'] }, { tags: [7] }, { title: 'x'.repeat(513) }, { target_url: 'javascript:alert(1)' }, { target_url: '/relative' }, { target_url: 'https://example.com/\r\nset-cookie: bad' }, { operation_id: '' }]) {
    await errorCall('resource.create_url', { ...base, ...changes }, 'INVALID_ARGUMENTS');
  }
  for (const limit of [0, 101, 1.5, '20', null]) await errorCall('resource.list', { limit }, 'INVALID_ARGUMENTS');
  await errorCall('resource.get', { resource_id: '............' }, 'INVALID_ARGUMENTS');
  await errorCall('resource.list', { created_from: 10, created_to: 5 }, 'INVALID_TIME_RANGE');
  await errorCall('session.create', {}, 'UNKNOWN_OPERATION');
});

test('concurrent creates and response loss keep one resource; conflicts and D1 aborts leave no orphan', async () => {
  const args = { operation_id: randomUUID(), target_url: 'https://example.com/race' };
  const results = await Promise.all(Array.from({ length: 6 }, () => call('resource.create_url', args)));
  assert.equal(new Set(results.map(result => result.resource.id)).size, 1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM resources WHERE target_url=?').bind(args.target_url).first()).n, 1);
  const recovered = await call('operation.get', { operation_id: args.operation_id });
  assert.equal(recovered.resource.id, results[0].resource.id);
  await errorCall('resource.create_url', { ...args, title: 'changed' }, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call('resource.create_url', { ...args, title: '', description: '', tags: [] })).resource.id, recovered.resource.id);
  const other = await create({ target_url: args.target_url });
  assert.notEqual(other.resource.id, recovered.resource.id);
  await db.exec("CREATE TRIGGER abort_operation BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'injected transaction failure secret-must-not-leak'); END");
  try {
    const failure = await errorCall('resource.create_url', { operation_id: randomUUID(), target_url: 'https://example.com/rollback' }, 'STORAGE_UNAVAILABLE');
    assert.equal(failure.retryable, true);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM resources WHERE target_url='https://example.com/rollback'").first()).n, 0);
    await errorCall('resource.update', { resource_id: other.resource.id, title: 'must rollback' }, 'STORAGE_UNAVAILABLE');
    assert.equal((await call('resource.get', { resource_id: other.resource.id })).resource.title, '');
  } finally { await db.exec('DROP TRIGGER abort_operation'); }
});

test('12-character ID collision retries without overwriting a retained tombstone', async () => {
  await db.prepare("INSERT INTO resources(id,kind,state,title,created_at,deleted_at) VALUES('AAAAAAAAAAAA','url','deleted','reserved',?,?)").bind(now(), now()).run();
  collide = true;
  const result = await create();
  assert.notEqual(result.resource.id, 'AAAAAAAAAAAA');
  assert.match(result.resource.id, /^[A-Za-z0-9]{12}$/);
  assert.equal((await call('resource.get', { resource_id: 'AAAAAAAAAAAA' })).resource.title, 'reserved');
});

test('updates redirect to current URL and deletion cannot be undone by replay or metadata edit', async () => {
  const args = { operation_id: randomUUID(), target_url: 'https://example.com/old', title: 'history' };
  const created = await call('resource.create_url', args);
  const resource_id = created.resource.id;
  const updated = await call('resource.update', { resource_id, target_url: 'https://example.com/new', title: 'new title', tags: ['a'] });
  assert.equal(updated.operation.type, 'resource.update');
  const response = await request('/r/' + resource_id, { method: 'HEAD', redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('location'), 'https://example.com/new');
  await errorCall('resource.update', { resource_id }, 'INVALID_ARGUMENTS');
  const deleted = await call('resource.delete', { resource_id });
  assert.equal(deleted.resource.state, 'deleted');
  assert.equal(deleted.resource.title, 'new title');
  assert.equal(deleted.resource.target_url, null);
  assert.equal((await request('/r/' + resource_id)).status, 404);
  assert.equal((await call('resource.create_url', args)).resource.state, 'deleted');
  assert.equal((await call('resource.delete', { resource_id })).resource.state, 'deleted');
  await errorCall('resource.update', { resource_id, title: 'restore' }, 'RESOURCE_DELETED');
  const listed = await call('operation.list', { resource_id });
  assert.equal(listed.items.length, 3);
  assert.equal((await call('resource.list', { keyword: 'new title' })).items.length, 0);
});

test('literal keyword search, tag intersection, time bounds and filter-bound keyset pagination', async () => {
  const tag = randomUUID();
  const ids = [];
  for (const title of ['文档 ABC 100%_1', '文档 abc 100XX1', '文档 abc 100%_1 second', 'unmatched']) {
    const item = await create({ title, description: '中文描述', tags: title === 'unmatched' ? [tag] : [tag, 'docs'] });
    ids.push(item.resource.id);
  }
  const literal = await call('resource.list', { keyword: 'ABC 100%_1', tags: [tag, 'docs'] });
  assert.deepEqual(new Set(literal.items.map(row => row.id)), new Set([ids[0], ids[2]]));
  const filter = { keyword: '中文', tags: [tag], kind: 'url', created_from: now() - 60, created_to: now() + 60 };
  const all = [], seenCursors = new Set();
  let cursor;
  do {
    const page = await call('resource.list', { ...filter, limit: 1, ...(cursor ? { cursor } : {}) });
    all.push(...page.items.map(row => row.id));
    if (page.next_cursor) {
      assert(!seenCursors.has(page.next_cursor)); seenCursors.add(page.next_cursor);
      await errorCall('resource.list', { ...filter, keyword: 'different', cursor: page.next_cursor }, 'INVALID_CURSOR');
    }
    assert.equal(page.has_more, Boolean(page.next_cursor));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(all.length, 4);
  assert.equal(new Set(all).size, 4);
  const expected = (await db.prepare('SELECT id FROM resources WHERE id IN (?,?,?,?) ORDER BY created_at DESC,id DESC').bind(...ids).all()).results.map(row => row.id);
  assert.deepEqual(all, expected);
  await errorCall('resource.list', { cursor: 'not-a-cursor' }, 'INVALID_CURSOR');
  const ops = await call('operation.list', { limit: 2 });
  assert.equal(ops.items.length, 2);
  assert.equal(ops.has_more, true);
  assert.equal((await call('operation.list', { limit: 2, cursor: ops.next_cursor })).items.some(row => ops.items.some(first => first.operation_id === row.operation_id)), false);
});

test('KV failure preserves published state; public reads fall back to primary and faults are not 404', async () => {
  failPut = true;
  try {
    const result = await create();
    assert.equal(result.resource.state, 'published');
    assert.equal(result.operation.status, 'retry_pending');
    assert.equal(result.operation.steps.kv, 'failed');
    assert.equal(result.operation.last_error.code, 'KV_SYNC_FAILED');
    assert.equal(result.operation.retry_count, 0);
    assert.equal(result.operation.total_attempts, 1);
    assert(result.operation.next_retry_at >= now() + 295);
    failGet = true;
    assert.equal((await request('/r/' + result.resource.id, { redirect: 'manual' })).status, 302);
    await db.exec('ALTER TABLE resources RENAME TO resources_offline');
    try { assert.equal((await request('/r/' + result.resource.id)).status, 503); }
    finally { await db.exec('ALTER TABLE resources_offline RENAME TO resources'); }
  } finally { failGet = false; failPut = false; }
});

test('KV absolute freshness rejects expired/malformed/negative entries and does not extend on cache hit', async () => {
  const result = await create();
  const id = result.resource.id;
  const original = JSON.parse(await kv.get(id));
  assert.equal(original.valid_until - original.observed_at, 60);
  await request('/r/' + id, { redirect: 'manual' });
  assert.deepEqual(JSON.parse(await kv.get(id)), original);
  for (const value of [JSON.stringify({ ...original, observed_at: now() - 61, valid_until: now() - 1, target_url: 'https://example.com/stale' }), 'bad-json', JSON.stringify({ ...original, state: 'missing' }), JSON.stringify({ ...original, valid_until: now() + 600 }), JSON.stringify({ ...original, target_url: 'javascript:alert(1)' })]) {
    await kv.put(id, value);
    const response = await request('/r/' + id, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), result.resource.target_url);
  }
  failGet = true;
  try { assert.equal((await request('/r/ZZZZZZZZZZZZ')).status, 404); }
  finally { failGet = false; }
});

test('Cron retries current state, enforces leases, exponential backoff and ten-attempt limit', async () => {
  failPut = true;
  let operation_id;
  try {
    const result = await create();
    operation_id = result.operation.operation_id;
    for (let retry = 1; retry <= 10; retry++) {
      await db.prepare('UPDATE operations SET next_retry_at=0 WHERE id=?').bind(operation_id).run();
      await cron();
      const op = (await call('operation.get', { operation_id })).operation;
      assert.equal(op.retry_count, retry);
      assert.equal(op.total_attempts, retry + 1);
      assert.equal(op.status, retry === 10 ? 'needs_attention' : 'retry_pending');
      if (retry < 10) assert(Math.abs(op.next_retry_at - now() - Math.min(300 * 2 ** retry, 3600)) <= 2);
      else assert.equal(op.next_retry_at, null);
    }
    await cron();
    assert.equal((await call('operation.get', { operation_id })).operation.total_attempts, 11);
  } finally { failPut = false; }
  const retried = await call('operation.retry', { operation_id });
  assert.equal(retried.operation.status, 'pending');
  assert.equal(retried.operation.retry_count, 0);
  assert.equal(retried.operation.total_attempts, 11);
  assert.equal(retried.operation.last_error.code, 'KV_SYNC_FAILED');
  await db.prepare("UPDATE operations SET status='running',lease_token='active',lease_until=?,next_retry_at=0 WHERE id=?").bind(now() + 3600, operation_id).run();
  await cron();
  assert.equal((await call('operation.retry', { operation_id })).operation.status, 'running');
  assert.equal((await call('operation.get', { operation_id })).operation.total_attempts, 11);
  await db.prepare('UPDATE operations SET lease_until=0 WHERE id=?').bind(operation_id).run();
  await cron();
  assert.equal((await call('operation.get', { operation_id })).operation.status, 'completed');
});

test('old sync tasks cannot resurrect deleted resources; interrupted D1 acknowledgment is recoverable', async () => {
  failPut = true;
  let result;
  try { result = await create(); }
  finally { failPut = false; }
  const operation_id = result.operation.operation_id;
  await call('resource.delete', { resource_id: result.resource.id });
  await call('operation.retry', { operation_id });
  await cron();
  assert.equal((await request('/r/' + result.resource.id)).status, 404);
  assert.equal(JSON.parse(await kv.get(result.resource.id)).state, 'deleted');
  assert.equal((await call('operation.get', { operation_id })).resource.state, 'deleted');
  await db.exec("CREATE TRIGGER interrupt_ack BEFORE UPDATE ON operations WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'acknowledgment interrupted'); END");
  let interrupted;
  try { interrupted = await create(); }
  finally { await db.exec('DROP TRIGGER interrupt_ack'); }
  assert.equal(interrupted.operation.status, 'running');
  assert.equal((await request('/r/' + interrupted.resource.id, { redirect: 'manual' })).status, 302);
  await db.prepare('UPDATE operations SET next_retry_at=0,lease_until=0 WHERE id=?').bind(interrupted.operation.operation_id).run();
  await cron();
  assert.equal((await call('operation.get', { operation_id: interrupted.operation.operation_id })).operation.status, 'completed');
});

test('cursors cannot be reused across resource and operation lists', async () => {
  await create();
  await create();
  const page = await call('operation.list', { limit: 1 });
  assert(page.next_cursor);
  await errorCall('resource.list', { cursor: page.next_cursor, limit: 1 }, 'INVALID_CURSOR');
});

test('resource detail returns most recently registered operation within the same second', async () => {
  const created = await create({ operation_id: '~'.repeat(128) });
  const updated = await call('resource.update', { resource_id: created.resource.id, title: 'latest' });
  await db.prepare('UPDATE operations SET created_at=123 WHERE resource_id=?').bind(created.resource.id).run();
  const result = await call('resource.get', { resource_id: created.resource.id });
  assert.equal(result.operation.operation_id, updated.operation.operation_id);
});

test('delayed backfill competing with deletion cannot renew its old snapshot', { timeout: 10000 }, async () => {
  const created = await create();
  const id = created.resource.id;
  await kv.delete(id);
  let release, arrived, snapshot;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { arrived = resolve; });
  onPut = async mapping => {
    if (mapping.id === id && mapping.state === 'published') {
      snapshot = mapping;
      arrived();
      await blocked;
    }
  };
  const reading = request('/r/' + id, { redirect: 'manual' });
  try {
    await waiting;
    await call('resource.delete', { resource_id: id });
    clockOffset = 61000;
    release();
    await reading;
    const stored = JSON.parse(await kv.get(id));
    assert.deepEqual(stored, snapshot);
    assert.equal(stored.valid_until, snapshot.observed_at + 60);
    assert.equal((await request('/r/' + id)).status, 404);
    assert.equal(JSON.parse(await kv.get(id)).state, 'deleted');
  } finally { release(); await reading; onPut = undefined; clockOffset = 0; }
});

test('simultaneous Cron calls acquire one operation lease and stale holders cannot acknowledge it', { timeout: 10000 }, async () => {
  failPut = true;
  let created;
  try { created = await create(); }
  finally { failPut = false; }
  const operation_id = created.operation.operation_id;
  await db.prepare('UPDATE operations SET next_retry_at=0 WHERE id=?').bind(operation_id).run();
  let release, arrived, writes = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { arrived = resolve; });
  onPut = async mapping => {
    if (mapping.id === created.resource.id) { writes++; arrived(); await blocked; }
  };
  const running = cron();
  try {
    await waiting;
    await cron();
    assert.equal(writes, 1);
    await db.prepare("UPDATE operations SET lease_token='replacement',status='running' WHERE id=?").bind(operation_id).run();
    release();
    await running;
    const op = (await call('operation.get', { operation_id })).operation;
    assert.equal(op.status, 'running');
    assert.equal(op.total_attempts, 2);
  } finally { release(); await running; onPut = undefined; }
  await db.prepare('UPDATE operations SET lease_until=0,next_retry_at=0 WHERE id=?').bind(operation_id).run();
  await cron();
  assert.equal((await call('operation.get', { operation_id })).operation.status, 'completed');
});

test('the tenth interrupted automatic attempt stops until manually resumed', async () => {
  const created = await create();
  const operation_id = created.operation.operation_id;
  await db.prepare("UPDATE operations SET status='running',retry_count=10,total_attempts=11,lease_token='crashed',lease_until=0,next_retry_at=0 WHERE id=?").bind(operation_id).run();
  await cron();
  const op = (await call('operation.get', { operation_id })).operation;
  assert.equal(op.status, 'needs_attention');
  assert.equal(op.total_attempts, 11);
  assert.equal(op.last_error.code, 'EXECUTION_INTERRUPTED');
  await call('operation.retry', { operation_id });
  await cron();
  assert.equal((await call('operation.get', { operation_id })).operation.status, 'completed');
});
