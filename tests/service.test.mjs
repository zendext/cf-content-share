import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'https://s.example.test';
const issuer = 'https://service-test.cloudflareaccess.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'service-key', alg: 'RS256', use: 'sig' };
function jwt(changes = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ iss: issuer, aud: ['service-aud'], sub: 'fixture-user', exp: now + 3600, nbf: now - 1, ...changes })}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
let mf, db, kv, client;
let failPut = false, failGet = false, collide = false;
let onPut,onR2Put,onR2Stored,onR2Delete,onHeartbeat,onCachePut,onCacheStored;
let failCacheRead=false,failCacheWrite=false,failR2Get=false;
let limits={};
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
    bindings: { PUBLIC_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'service-aud' },
    d1Databases: ['DB'], kvNamespaces: ['MAPPINGS'], r2Buckets: ['FILES'],
    serviceBindings: { FAULTS: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/request') { const result = Response.json({ collide, offset: clockOffset, limits }); collide = false; return result; }
      if(path==='/r2-get' && failR2Get)return new Response('failed',{status:503});
      if(path==='/cache-match' && failCacheRead)return new Response('failed',{status:503});
      if(path==='/cache-put'){if(onCachePut)onCachePut(await req.json());if(failCacheWrite)return new Response('failed',{status:503});}
      if(path==='/cache-stored' && onCacheStored)onCacheStored(await req.json());
      if(path==='/heartbeat') return Response.json(onHeartbeat ? await onHeartbeat() : {tick:false});
      if(path==='/r2-put' && onR2Put) {const result=await onR2Put(await req.json());if(result===false)return new Response('failed',{status:503});}
      if(path==='/r2-stored' && onR2Stored) await onR2Stored(await req.json());
      if(path==='/r2-delete' && onR2Delete) {const result=await onR2Delete(await req.json());if(result===false)return new Response('failed',{status:503});}
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
  await db.exec("INSERT INTO resources(id,kind,state,target_url,title,created_at) VALUES('LegacyUrl001','url','published','https://example.com/legacy','legacy',1); INSERT INTO operations(id,type,resource_id,fingerprint,created_at,updated_at,next_retry_at) VALUES('legacy-op','resource.create_url','LegacyUrl001','legacy-fingerprint',1,1,0)");
  await db.exec((await readFile('migrations/0002_files.sql', 'utf8')).replace(/^--.*$/gm, '').replaceAll('\n', ' '));
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
  assert.equal((await request('/upload', { method: 'POST' })).status, 401);
});

test('two tools discover strict operation schemas, results, side effects and valid examples', async () => {
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['describe', 'invoke']);
  const catalog = await client.callTool({ name: 'describe', arguments: {} });
  assert.equal(catalog.structuredContent.operations.length, 14);
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
  await errorCall('unimplemented.operation', {}, 'UNKNOWN_OPERATION');
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

function multipart(data, changes = {}, tail = '') {
  const boundary = 'formal-boundary';
  const metadata = { operation_id: randomUUID(), filename: 'fixture.bin', content_type: 'application/octet-stream', size_bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...changes };
  return { metadata, contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}${tail || '--\r\n'}`),
  ]) };
}
const upload = (token,form) => request('/upload',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':form.contentType},body:form.body,duplex:'half'});
async function uploaded(data, changes={}) {
 const {token}=await call('session.create');const form=multipart(data,changes);const response=await upload(token,form);
 assert.equal(response.status,201,await response.clone().text());return {...await response.json(),token,form};
}

test('session tokens are hash-only, valid for 24h, reusable, paginated and revocable',async()=>{
 const session=await call('session.create',{client:'file-test'});
 assert.equal(session.expires_at-session.created_at,86400);
 const row=await db.prepare('SELECT * FROM upload_sessions WHERE id=?').bind(session.session_id).first();
 assert.equal(row.token_hash,createHash('sha256').update(session.token).digest('hex'));assert(!JSON.stringify(row).includes(session.token));
 assert(session.upload.metadata_schema.properties.sha256);
 for(const data of [Buffer.alloc(0),Buffer.from('second upload')]){
 const form=multipart(data);const response=await upload(session.token,form);assert.equal(response.status,201,await response.clone().text());
 const result=await response.json();assert.equal(result.resource.state,'published');assert.match(result.resource.id,/^[A-Za-z0-9]{12}$/);
 assert.deepEqual(Buffer.from(await (await request('/r/'+result.resource.id)).arrayBuffer()),data);
 assert.equal((await upload(session.token,form)).status,200);
 }
 const page=await call('session.list',{limit:1});assert(!JSON.stringify(page).includes(session.token));
 await call('session.revoke',{session_id:session.session_id});assert.equal((await upload(session.token,multipart(Buffer.from('revoked')))).status,401);
 const expired=await call('session.create');await db.prepare('UPDATE upload_sessions SET expires_at=0 WHERE id=?').bind(expired.session_id).run();
 assert.equal((await upload(expired.token,multipart(Buffer.alloc(0)))).status,401);
});

test('same filename and same hash create independent resources; metadata is mutable, binary attributes are not',async()=>{
 const tag=randomUUID();const data=Buffer.from('same');
 const a=await uploaded(data,{filename:'中文 ABC 100%_1.bin',title:'file title',description:'description',tags:[tag]});
 const b=await uploaded(data,{filename:a.resource.filename});assert.notEqual(a.resource.id,b.resource.id);
 const conflicting=multipart(data,{...a.form.metadata,title:'changed'});assert.equal((await upload(a.token,conflicting)).status,409);
 assert.equal((await call('resource.list',{keyword:'abc 100%_1',tags:[tag],kind:'file'})).items[0].id,a.resource.id);
 assert.equal((await call('resource.list',{filename:a.resource.filename})).items.length,2);
 await call('resource.update',{resource_id:a.resource.id,title:'edited',tags:[]});
 await errorCall('resource.update',{resource_id:a.resource.id,target_url:'https://example.com/'},'IMMUTABLE_FILE');
 await errorCall('resource.update',{resource_id:a.resource.id,filename:'changed'},'INVALID_ARGUMENTS');
 assert.deepEqual(Buffer.from(await (await request('/r/'+a.resource.id)).arrayBuffer()),data);
 const deleted=await call('resource.delete',{resource_id:a.resource.id});assert.equal(deleted.resource.state,'deleted');assert.equal(deleted.operation.steps.r2_cleanup,'completed');
 assert.equal((await request('/r/'+a.resource.id)).status,404);assert.equal((await (await upload(a.token,a.form)).json()).resource.state,'deleted');
});

test('file ranges, HEAD, RFC filename, raw SVG and browser cache headers',async()=>{
 const data=Buffer.from('0123456789');const a=await uploaded(data,{filename:'中文 "x".txt'});const path='/r/'+a.resource.id;
 const response=await request(path);assert.equal(response.headers.get('cache-control'),'private, max-age=31536000, immutable');
 assert.match(response.headers.get('content-disposition'),/^attachment; filename="/);assert(response.headers.get('content-disposition').includes("filename*=UTF-8''%E4%B8%AD%E6%96%87"));
 await response.arrayBuffer();
 for(const [range,expected,header] of [['bytes=2-4','234','bytes 2-4/10'],['bytes=7-','789','bytes 7-9/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=0-99','0123456789','bytes 0-9/10']]){
 const res=await request(path,{headers:{range}});assert.equal(res.status,206);assert.equal(res.headers.get('content-range'),header);assert.equal(await res.text(),expected);
 }
 for(const range of ['bytes=10-','bytes=-0','bytes=4-2','bytes=0-1,4-5']){const res=await request(path,{headers:{range}});assert.equal(res.status,416);assert.equal(res.headers.get('cache-control'),'no-store');}
 const head=await request(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
 const image=await uploaded(svg,{content_type:'image/svg+xml',filename:'raw.svg'});assert.equal(image.resource.kind,'image');
 const shown=await request('/r/'+image.resource.id);assert.equal(shown.headers.get('content-type'),'image/svg+xml');assert.match(shown.headers.get('content-disposition'),/^inline/);assert.equal(shown.headers.get('content-security-policy'),null);assert.equal(await shown.text(),svg.toString());
});

test('length/hash/framing failures release only fenced reservations and allow same-operation retransmit',async()=>{
 const {token}=await call('session.create');const bucket=await mf.getR2Bucket('FILES');
 for(const changes of [{size_bytes:1},{size_bytes:99},{sha256:'0'.repeat(64)}]){
 const form=multipart(Buffer.from('wrong'),changes);const response=await upload(token,form);assert.equal(response.status,422,await response.clone().text());
 const result=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(result.resource.state,'pending');assert.equal(result.resource.accounting,'released');assert.equal(result.operation.steps.upload,'needs_reupload');assert.equal(result.operation.status,'needs_attention');
 const fence=await bucket.head(result.resource.file_key);assert.equal(fence.size,0);assert.equal(fence.customMetadata.role,'fence');
 assert.equal((await request('/r/'+result.resource.id)).status,404);
 }
 const data=Buffer.from('retransmit');const good=multipart(data);const bad={...good,body:good.body.subarray(0,good.body.length-12)};
 assert.equal((await upload(token,bad)).status,422);const old=await call('operation.get',{operation_id:good.metadata.operation_id});
 const res=await upload(token,good);assert.equal(res.status,201,await res.clone().text());const recovered=await res.json();assert.equal(recovered.resource.id,old.resource.id);assert.notEqual(recovered.resource.file_key,old.resource.file_key);assert.equal(recovered.operation.last_error.code,old.operation.last_error.code);assert.equal(recovered.operation.total_attempts,old.operation.total_attempts+1);
});

test('complete owned object is recovered after D1 publication failure',async()=>{
 const {token}=await call('session.create');const form=multipart(Buffer.from('publish recovery'));
 await db.exec("CREATE TRIGGER fail_publish BEFORE UPDATE ON resources WHEN NEW.state='published' AND OLD.state='pending' BEGIN SELECT RAISE(ABORT,'publish failed'); END");
 let result;try{const response=await upload(token,form);assert.equal(response.status,202);result=await response.json();assert.equal(result.resource.accounting,'reserved');assert.equal(result.resource.state,'pending');}finally{await db.exec('DROP TRIGGER fail_publish');}
 await db.prepare('UPDATE operations SET next_retry_at=0,lease_until=0 WHERE id=?').bind(form.metadata.operation_id).run();await cron();
 const recovered=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(recovered.resource.state,'published');assert.equal(recovered.resource.id,result.resource.id);assert.equal(await (await request('/r/'+result.resource.id)).text(),'publish recovery');
});

test('concurrent capacity admission and duplicate retries never overreserve or double count',async()=>{
 const baseline=await call('storage.get');const used=baseline.published_bytes+baseline.reserved_bytes+baseline.cleanup_bytes;
 limits={TOTAL_STORAGE_BYTES:used+10,MAX_FILE_BYTES:10};
 try{
 const {token}=await call('session.create');
 assert.equal((await upload(token,multipart(Buffer.alloc(11)))).status,413);
 const forms=[multipart(Buffer.alloc(10)),multipart(Buffer.alloc(10))];
 const responses=await Promise.all(forms.map(form=>upload(token,form)));assert.deepEqual(responses.map(r=>r.status).sort(),[201,413]);
 const winner=await responses.find(r=>r.status===201).json();
 const usage=await call('storage.get');assert.equal(usage.published_bytes,baseline.published_bytes+10);assert.equal(usage.reserved_bytes,baseline.reserved_bytes);
 await call('resource.delete',{resource_id:winner.resource.id});
 const form=multipart(Buffer.alloc(10));const same=await Promise.all([upload(token,form),upload(token,form)]);assert.equal(same.filter(r=>r.status===201).length,1);assert(same.every(r=>[200,201,409].includes(r.status)));
 const result=await call('operation.get',{operation_id:form.metadata.operation_id});await call('resource.delete',{resource_id:result.resource.id});
 const after=await call('storage.get');assert.equal(after.published_bytes,baseline.published_bytes);assert.equal(after.reserved_bytes,baseline.reserved_bytes);
 }finally{limits={};}
});

test('R2 cleanup failure retains capacity through retry exhaustion, manual reset and eventual deletion',async()=>{
 const a=await uploaded(Buffer.alloc(13));const baseline=await call('storage.get');onR2Delete=()=>false;
 let operation_id;
 try{
 const deleted=await call('resource.delete',{resource_id:a.resource.id});operation_id=deleted.operation.operation_id;
 assert.equal(deleted.resource.accounting,'cleanup');assert.equal(deleted.operation.status,'retry_pending');assert.equal(deleted.operation.steps.kv,'accepted');assert.equal(deleted.operation.steps.r2_cleanup,'failed');assert.equal((await request('/r/'+a.resource.id)).status,404);
 for(let i=1;i<=10;i++){await db.prepare('UPDATE operations SET next_retry_at=0 WHERE id=?').bind(operation_id).run();await cron();}
 const stopped=await call('operation.get',{operation_id});assert.equal(stopped.operation.status,'needs_attention');assert.equal(stopped.operation.retry_count,10);
 const usage=await call('storage.get');assert.equal(usage.published_bytes,baseline.published_bytes-13);assert.equal(usage.cleanup_bytes,baseline.cleanup_bytes+13);
 }finally{onR2Delete=undefined;}
 await call('operation.retry',{operation_id});await cron();
 const done=await call('operation.get',{operation_id});assert.equal(done.resource.accounting,'released');assert.equal(done.operation.status,'completed');assert.equal(done.operation.total_attempts,12);
 await call('operation.retry',{operation_id});await cron();assert.equal((await call('storage.get')).cleanup_bytes,baseline.cleanup_bytes);
});

test('160 MiB native checksum upload stays below 16 MiB Wasm memory',async()=>{
 const chunk=Buffer.alloc(64*1024,0xa5),count=2560;const hash=createHash('sha256');for(let i=0;i<count;i++)hash.update(chunk);
 const form=multipart(Buffer.alloc(0),{size_bytes:chunk.length*count,sha256:hash.digest('hex')});
 const trailer=Buffer.from('\r\n--formal-boundary--\r\n'),prefix=form.body.subarray(0,form.body.length-trailer.length);let sent=-1;
 form.body=new ReadableStream({pull(c){if(sent===-1)c.enqueue(prefix);else if(sent<count)c.enqueue(chunk);else{c.enqueue(trailer);c.close();}sent++;}});
 let memory=0;onR2Stored=event=>{memory=Math.max(memory,event.memory)};
 try{const {token}=await call('session.create');const response=await upload(token,form);assert.equal(response.status,201,await response.clone().text());const result=await response.json();assert.equal(result.resource.size_bytes,160*1024*1024);assert(memory<16*1024*1024,`Wasm memory ${memory}`);console.log('160MiB stream memory:',memory);await call('resource.delete',{resource_id:result.resource.id});}finally{onR2Stored=undefined;}
});

test('cached pending snapshot never hides a newly published file when KV publishing fails',async()=>{
 const a=await uploaded(Buffer.from('visible'));
 const mapping=JSON.parse(await kv.get(a.resource.id));await kv.put(a.resource.id,JSON.stringify({...mapping,state:'pending'}));
 failPut=true;try{const response=await request('/r/'+a.resource.id);assert.equal(response.status,200);assert.equal(await response.text(),'visible');}finally{failPut=false;}
});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
function heartbeatControl(){
 let entered=deferred();const queue=[];
 onHeartbeat=()=>{const reply=deferred();queue.push(reply);entered.resolve();return reply.promise;};
 return {
  async ready(){if(!queue.length)await entered.promise;},
  async tick(){await this.ready();const reply=queue.shift();entered=deferred();clockOffset+=30000;reply.resolve({tick:true,offset:clockOffset});await entered.promise;},
  close(){onHeartbeat=undefined;for(const reply of queue)reply.resolve({tick:false});}
 };
}

test('independent heartbeat protects stalled file headers and paused R2 put beyond the original lease', {timeout:15000},async()=>{
 for(const mode of ['file-header','r2-put']){
  const heartbeat=heartbeatControl();const release=deferred();
  const {token}=await call('session.create');const form=multipart(Buffer.from('heartbeat'));let controller;
  if(mode==='file-header'){
   const cut=form.body.indexOf(Buffer.from('Content-Disposition: form-data; name="file"'));
   const original=form.body;
   form.body=new ReadableStream({start(c){controller=c;c.enqueue(original.subarray(0,cut));release.promise.then(()=>{c.enqueue(original.subarray(cut));c.close();});}});
  }else{onR2Put=async event=>{if(event.options.customMetadata.role!=='fence')await release.promise;};}
  const uploading=upload(token,form);
  try{
   await heartbeat.ready();
   for(let tick=0;tick<5;tick++)await heartbeat.tick();
   await cron();
   const pending=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(pending.operation.steps.upload,'uploading');assert.equal(pending.resource.accounting,'reserved');
   assert.equal((await upload(token,multipart(Buffer.from('heartbeat'),form.metadata))).status,409);
   release.resolve();const response=await uploading;assert.equal(response.status,201,await response.clone().text());
  }finally{release.resolve();await uploading;heartbeat.close();onR2Put=undefined;clockOffset=0;}
 }
});

test('lost heartbeat fences a delayed writer; same-operation retry uses another key and cannot be overwritten', {timeout:15000},async()=>{
 const heartbeat=heartbeatControl(),release=deferred(),entered=deferred();let blockedKey;
 onR2Put=async event=>{if(event.options.customMetadata.role!=='fence' && !blockedKey){blockedKey=event.key;entered.resolve();await release.promise;}};
 const {token}=await call('session.create');const form=multipart(Buffer.from('fenced writer'));const uploading=upload(token,form);
 try{
  await entered.promise;await heartbeat.ready();
  await db.exec("CREATE TRIGGER fail_heartbeat BEFORE UPDATE OF lease_until ON operations WHEN NEW.upload_state='uploading' AND NEW.lease_until>OLD.lease_until BEGIN SELECT RAISE(ABORT,'heartbeat failed'); END");
  // Deliver one virtual timer; failure intentionally prevents scheduling the next.
  onHeartbeat=undefined;
  const pendingTimer=heartbeat; // ready barrier already proves timer registration.
  // tick() waits for the next timer, so independently observe the operation transition.
  void pendingTimer.tick();
  const response=await uploading;assert.equal(response.status,422,await response.clone().text());
  await db.exec('DROP TRIGGER fail_heartbeat');
  const fenced=await response.json();assert.equal(fenced.operation.steps.upload,'needs_reupload');assert.equal(fenced.resource.accounting,'released');
  const retry=await upload(token,form);assert.equal(retry.status,201,await retry.clone().text());const recovered=await retry.json();assert.notEqual(recovered.resource.file_key,blockedKey);assert.equal(recovered.resource.id,fenced.resource.id);
  release.resolve();
  const bucket=await mf.getR2Bucket('FILES');assert.equal((await bucket.head(blockedKey)).customMetadata.role,'fence');assert.equal(await (await request('/r/'+recovered.resource.id)).text(),'fenced writer');
 }finally{release.resolve();await uploading;await db.exec('DROP TRIGGER IF EXISTS fail_heartbeat');heartbeat.close();onR2Put=undefined;onR2Stored=undefined;clockOffset=0;}
});

test('logical deletion racing an accepted upload keeps reserved bytes until upload has ended', {timeout:10000},async()=>{
 const release=deferred(),entered=deferred();onR2Put=async event=>{if(event.options.customMetadata.role!=='fence'){entered.resolve();await release.promise;}};
 const {token}=await call('session.create');const form=multipart(Buffer.from('delete during upload'));const uploading=upload(token,form);
 try{
  await entered.promise;const pending=await call('operation.get',{operation_id:form.metadata.operation_id});
  const deletion=await call('resource.delete',{resource_id:pending.resource.id});assert.equal(deletion.resource.state,'deleted');assert.equal(deletion.resource.accounting,'reserved');assert.equal(deletion.operation.status,'retry_pending');
  release.resolve();await uploading;
  const result=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(result.resource.state,'deleted');assert.equal(result.resource.accounting,'released');assert.equal((await request('/r/'+result.resource.id)).status,404);
  await db.prepare('UPDATE operations SET next_retry_at=0 WHERE id=?').bind(deletion.operation.operation_id).run();await cron();assert.equal((await call('operation.get',{operation_id:deletion.operation.operation_id})).operation.status,'completed');
 }finally{release.resolve();await uploading;onR2Put=undefined;}
});

test('migration preserves deployed URL records, permanent IDs and original operation sequence',async()=>{
 const result=await call('resource.get',{resource_id:'LegacyUrl001'});assert.equal(result.resource.title,'legacy');assert.equal(result.operation.operation_id,'legacy-op');
 const response=await request('/r/LegacyUrl001',{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://example.com/legacy');
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});

test('body cache uses public 24h headers but never bypasses deleted or unavailable authoritative state',async()=>{
 const a=await uploaded(Buffer.from('cached body'));const path='/r/'+a.resource.id;const stored=deferred();const writes=[];
 onCachePut=event=>writes.push(event);onCacheStored=event=>{if(event.url.endsWith(path))stored.resolve()};
 try{
  assert.equal(await (await request(path)).text(),'cached body');await stored.promise;
  assert.equal(writes[0].status,200);assert.equal(writes[0].cacheControl,'public, max-age=86400');
  failR2Get=true;const hit=await request(path);assert.equal(hit.status,200);assert.equal(hit.headers.get('cache-control'),'private, max-age=31536000, immutable');assert.equal(await hit.text(),'cached body');
  await kv.delete(a.resource.id);await db.exec('ALTER TABLE resources RENAME TO resources_offline');
  try{assert.equal((await request(path)).status,503);}finally{await db.exec('ALTER TABLE resources_offline RENAME TO resources');}
  // Logical deletion without evicting the cache proves state validation precedes cache access.
  await db.prepare("UPDATE resources SET state='deleted',accounting='cleanup' WHERE id=?").bind(a.resource.id).run();await kv.delete(a.resource.id);
  assert.equal((await request(path)).status,404);
 }finally{failR2Get=false;onCachePut=undefined;onCacheStored=undefined;}
});

test('cache failures never turn successful R2 body reads into errors and partial responses are never cached',async()=>{
 const a=await uploaded(Buffer.from('cache fault'));const writes=[];onCachePut=event=>writes.push(event);failCacheRead=true;failCacheWrite=true;
 try{
  const response=await request('/r/'+a.resource.id);assert.equal(response.status,200);assert.equal(await response.text(),'cache fault');
  const partial=await request('/r/'+a.resource.id,{headers:{range:'bytes=1-3'}});assert.equal(partial.status,206);assert.equal(await partial.text(),'ach');
  assert(writes.every(event=>event.status===200));
 }finally{failCacheRead=false;failCacheWrite=false;onCachePut=undefined;}
});

test('ownership mismatch cannot publish a foreign object even with matching bytes and digest',async()=>{
 const {token}=await call('session.create');const data=Buffer.from('owned bytes'),form=multipart(data);const bucket=await mf.getR2Bucket('FILES');
 let once=true;onR2Put=async event=>{if(once && event.options.customMetadata.role!=='fence'){once=false;await bucket.put(event.key,data,{sha256:createHash('sha256').update(data).digest(),customMetadata:{upload_token:'foreign',operation_id:form.metadata.operation_id}});}};
 try{const response=await upload(token,form);assert.equal(response.status,422);const result=await response.json();assert.equal(result.resource.state,'pending');assert.equal(result.resource.accounting,'reserved');assert.equal(result.operation.status,'needs_attention');assert.equal(result.operation.last_error.code,'OBJECT_OWNERSHIP_MISMATCH');assert.equal(result.operation.last_error.retryable,false);}finally{onR2Put=undefined;}
});

test('expired old recovery cannot fence or release the next upload attempt', {timeout:10000},async()=>{
 const {token}=await call('session.create');const data=Buffer.from('next attempt'),form=multipart(data);const broken={...form,body:form.body.subarray(0,form.body.length-12)};
 assert.equal((await upload(token,broken)).status,422);const failed=await call('operation.get',{operation_id:form.metadata.operation_id});
 await call('operation.retry',{operation_id:form.metadata.operation_id});
 const entered=deferred(),release=deferred();onPut=async mapping=>{if(mapping.id===failed.resource.id && mapping.state==='pending'){entered.resolve();await release.promise;}};
 const recovering=cron();
 try{
  await entered.promise;
  assert.equal((await upload(token,form)).status,409); // valid recovery lease blocks admission
  await db.prepare('UPDATE operations SET lease_until=0 WHERE id=?').bind(form.metadata.operation_id).run();
  const response=await upload(token,form);assert.equal(response.status,201,await response.clone().text());const result=await response.json();assert.notEqual(result.resource.file_key,failed.resource.file_key);
  release.resolve();await recovering;
  const current=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(current.resource.accounting,'published');assert.equal(current.operation.status,'completed');assert.equal(await (await request('/r/'+current.resource.id)).text(),'next attempt');
 }finally{release.resolve();await recovering;onPut=undefined;}
});

test('KV failure does not hide successful file deletion and failed-upload deletion acknowledges prior cleanup',async()=>{
 const a=await uploaded(Buffer.from('delete independently'));failPut=true;let deletion;
 try{deletion=await call('resource.delete',{resource_id:a.resource.id});assert.equal(deletion.resource.accounting,'released');assert.equal(deletion.operation.steps.r2_cleanup,'completed');assert.equal(deletion.operation.steps.kv,'failed');assert.equal(deletion.operation.status,'retry_pending');}finally{failPut=false;}
 await call('operation.retry',{operation_id:deletion.operation.operation_id});await cron();assert.equal((await request('/r/'+a.resource.id)).status,404);
 const {token}=await call('session.create');const form=multipart(Buffer.from('bad hash'),{sha256:'0'.repeat(64)});const result=await (await upload(token,form)).json();
 const deleted=await call('resource.delete',{resource_id:result.resource.id});assert.equal(deleted.operation.status,'completed');assert.equal(deleted.operation.steps.r2_cleanup,'completed');
 const original=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(original.operation.steps.upload,'needs_reupload');assert.equal(original.operation.status,'needs_attention');assert.equal(original.resource.state,'deleted');
});

test('multipart extra fields, missing final delimiter and strict metadata never publish invalid content',async()=>{
 const {token}=await call('session.create');
 for(const tail of ['\r\nContent-Disposition: form-data; name="file"\r\n\r\nextra\r\n--formal-boundary--\r\n','-']){
  for(const data of [Buffer.from('valid'),Buffer.alloc(0)]){const form=multipart(data,{},tail);const response=await upload(token,form);assert.equal(response.status,422);assert.equal((await response.json()).resource.state,'pending');}
 }
 for(const changes of [{unknown:1},{size_bytes:1.5},{size_bytes:9007199254740992},{sha256:'A'.repeat(64)},{title:null},{tags:['a','a']},{filename:'bad\r\nfilename'},{content_type:'text/html; charset=utf8'}]){
  const response=await upload(token,multipart(Buffer.from('x'),changes));assert.equal(response.status,400,await response.clone().text());
 }
 const defaults=await call('storage.get');assert.equal(defaults.max_file_bytes,null);assert.equal(defaults.total_storage_bytes,null);
 limits={MAX_FILE_BYTES:0};try{assert.equal((await upload(token,multipart(Buffer.from('x')))).status,413);assert.equal((await upload(token,multipart(Buffer.alloc(0)))).status,201);}finally{limits={};}
});

test('execution nonces stay private and admission limits do not rewrite committed idempotent results',async()=>{
 const a=await uploaded(Buffer.from('stable result'));const internal=await db.prepare('SELECT upload_token FROM operations WHERE id=?').bind(a.form.metadata.operation_id).first();
 assert(!JSON.stringify(a).includes(internal.upload_token));assert(!a.resource.file_key.includes(internal.upload_token));
 limits={MAX_FILE_BYTES:0,TOTAL_STORAGE_BYTES:0};try{const response=await upload(a.token,a.form);assert.equal(response.status,200);assert.equal((await response.json()).resource.id,a.resource.id);}finally{limits={};}
});

test('request stream interruption keeps a recoverable unpublished operation', {timeout:10000},async()=>{
 const {token}=await call('session.create');const form=multipart(Buffer.alloc(64*1024));const entered=deferred();let controller;
 const prefix=form.body.subarray(0,form.body.length-32000);
 form.body=new ReadableStream({start(c){controller=c;c.enqueue(prefix);}});
 onR2Put=event=>{if(event.options.customMetadata.role!=='fence')entered.resolve();};
 const pending=upload(token,form);
 try{
  await entered.promise;controller.error(new Error('client connection aborted'));
  try{const response=await pending;assert.equal(response.status,422);}catch(error){assert.match(String(error),/client connection aborted|network|stream|fetch failed/i);}
  const result=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(result.resource.state,'pending');
  if(result.resource.accounting!=='released'){
   await db.prepare('UPDATE operations SET lease_until=0,next_retry_at=0 WHERE id=?').bind(form.metadata.operation_id).run();await cron();
  }
  const recovered=await call('operation.get',{operation_id:form.metadata.operation_id});assert.equal(recovered.resource.accounting,'released');assert.equal(recovered.operation.steps.upload,'needs_reupload');
 }finally{onR2Put=undefined;await pending.catch(()=>{});}
});
