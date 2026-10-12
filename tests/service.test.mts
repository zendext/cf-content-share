import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type {
  ApiError,
  CacheEvent,
  Catalog,
  D1Event,
  Descriptor,
  Heartbeat,
  Mapping,
  R2Event,
  ResourceResult,
  Results,
  Storage,
} from './test-contracts.mts';

const origin = 'https://s.example.test';
const issuer = 'https://service-test.cloudflareaccess.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'service-key',
  alg: 'RS256',
  use: 'sig',
};
function jwt(changes = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ iss: issuer, aud: ['service-aud'], sub: 'fixture-user', exp: now + 3600, nbf: now - 1, ...changes })}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
let mf: Miniflare,
  db: Awaited<ReturnType<Miniflare['getD1Database']>>,
  kv: Awaited<ReturnType<Miniflare['getKVNamespace']>>,
  client: Client;
let failPut = false,
  failGet = false,
  collide = false;
type Hook<T> =
  | ((event: T) => boolean | void | Promise<boolean | void>)
  | undefined;
let onD1Before: Hook<D1Event>,
  onD1After: Hook<D1Event>,
  onD1Batch: Hook<D1Event>;
let onPut: Hook<Mapping>,
  onR2Put: Hook<R2Event>,
  onR2Stored: Hook<R2Event>,
  onR2Delete: Hook<R2Event>,
  onHeartbeat: (() => Promise<Heartbeat>) | undefined,
  onCachePut: Hook<CacheEvent>,
  onCacheStored: Hook<CacheEvent>;
let failCacheRead = false,
  failCacheWrite = false,
  failR2Get = false;
let limits: Record<string, number> = {};
let clockOffset = 0;
const now = () => Math.floor(Date.now() / 1000);
const create = (extra = {}) =>
  call('resource.create_url', {
    operation_id: randomUUID(),
    target_url: 'https://example.com/',
    ...extra,
  });
const errorCall = async (
  operation: string,
  args: Record<string, unknown>,
  code: string,
) => {
  const result = await client.callTool({
    name: 'invoke',
    arguments: { operation, arguments: args },
  });
  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: ApiError }).error.code,
    code,
    JSON.stringify(result),
  );
  assert.equal(JSON.stringify(result).includes('secret-must-not-leak'), false);
  assert.match(
    (result.structuredContent as { error: ApiError }).error.message,
    /^[\x20-\x7e]+$/,
    'Diagnostic messages must use English ASCII text',
  );
  return (result.structuredContent as { error: ApiError }).error;
};
const cron = async () =>
  (await mf.getWorker()).scheduled({
    cron: '*/5 * * * *',
    scheduledTime: new Date(),
  });
const request = (
  path: string,
  init?: Parameters<Miniflare['dispatchFetch']>[1],
) => mf.dispatchFetch(origin + path, init);
const rpc = (body: unknown, token = jwt(), headers = {}) =>
  request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'cf-access-jwt-assertion': token,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const call = async <K extends keyof Results>(
  operation: K,
  args: Record<string, unknown> = {},
): Promise<Results[K]> => {
  const result = await client.callTool({
    name: 'invoke',
    arguments: { operation, arguments: args },
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as Results[K];
};
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'service',
          modulesRoot: '.',
          modules: [
            {
              type: 'ESModule',
              path: 'tests/worker-fixture.mts',
              contents: stripTypeScriptTypes(
                await readFile('tests/worker-fixture.mts', 'utf8'),
              ),
            },
            { type: 'ESModule', path: 'build/index.js' },
            { type: 'CompiledWasm', path: 'build/index_bg.wasm' },
          ],
          compatibilityDate: '2026-10-11',
          bindings: {
            PUBLIC_ORIGIN: origin,
            ACCESS_ISSUER: issuer,
            ACCESS_AUD: 'service-aud',
          },
          d1Databases: ['DB'],
          kvNamespaces: ['MAPPINGS'],
          r2Buckets: ['FILES'],
          serviceBindings: {
            FAULTS: async (req) => {
              const path = new URL(req.url).pathname;
              if (path.startsWith('/d1-')) {
                const handler =
                  path === '/d1-before'
                    ? onD1Before
                    : path === '/d1-after'
                      ? onD1After
                      : onD1Batch;
                if (
                  handler &&
                  (await handler((await req.json()) as D1Event)) === false
                )
                  return new Response('failed', { status: 503 });
              }
              if (path === '/request') {
                const result = Response.json({
                  collide,
                  offset: clockOffset,
                  limits,
                });
                collide = false;
                return result;
              }
              if (path === '/r2-get' && failR2Get)
                return new Response('failed', { status: 503 });
              if (path === '/cache-match' && failCacheRead)
                return new Response('failed', { status: 503 });
              if (path === '/cache-put') {
                if (onCachePut) onCachePut((await req.json()) as CacheEvent);
                if (failCacheWrite)
                  return new Response('failed', { status: 503 });
              }
              if (path === '/cache-stored' && onCacheStored)
                onCacheStored((await req.json()) as CacheEvent);
              if (path === '/heartbeat')
                return Response.json(
                  onHeartbeat ? await onHeartbeat() : { tick: false },
                );
              if (path === '/r2-put' && onR2Put) {
                const result = await onR2Put((await req.json()) as R2Event);
                if (result === false)
                  return new Response('failed', { status: 503 });
              }
              if (path === '/r2-stored' && onR2Stored)
                await onR2Stored((await req.json()) as R2Event);
              if (path === '/r2-delete' && onR2Delete) {
                const result = await onR2Delete((await req.json()) as R2Event);
                if (result === false)
                  return new Response('failed', { status: 503 });
              }
              if (path === '/kv-put') {
                if (onPut) await onPut((await req.json()) as Mapping);
                if (failPut) return new Response('failure', { status: 503 });
              }
              if (path === '/kv-get' && failGet)
                return new Response('failure', { status: 503 });
              return Response.json({ offset: clockOffset });
            },
          },
          outboundService: async (req) => {
            assert.equal(req.url, `${issuer}/cdn-cgi/access/certs`);
            return new Response(JSON.stringify({ keys: [jwk] }), {
              headers: { 'content-type': 'application/json' },
            });
          },
        },
      ],
    }),
  );
  db = await mf.getD1Database('DB');
  kv = await mf.getKVNamespace('MAPPINGS');
  await db.exec(
    (await readFile('migrations/0001_resources.sql', 'utf8')).replaceAll(
      '\n',
      ' ',
    ),
  );
  await db.exec(
    "INSERT INTO resources(id,kind,state,target_url,title,created_at) VALUES('LegacyUrl001','url','published','https://example.com/legacy','legacy',1); INSERT INTO operations(id,type,resource_id,fingerprint,created_at,updated_at,next_retry_at) VALUES('legacy-op','resource.create_url','LegacyUrl001','legacy-fingerprint',1,1,0)",
  );
  await db.exec(
    (await readFile('migrations/0002_files.sql', 'utf8'))
      .replace(/^--.*$/gm, '')
      .replaceAll('\n', ' '),
  );
  await db.exec(
    (await readFile('migrations/0003_expiration.sql', 'utf8'))
      .replace(/^--.*$/gm, '')
      .replaceAll('\n', ' '),
  );
  client = new Client({ name: 'service-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      fetch: (url, init) =>
        mf.dispatchFetch(
          String(url),
          init as Parameters<Miniflare['dispatchFetch']>[1],
        ) as unknown as Promise<Response>,
      requestInit: { headers: { 'cf-access-jwt-assertion': jwt() } },
    },
  );
  await client.connect(transport);
});
after(async () => {
  await client?.close();
  await mf?.dispose();
});

test('formal URL create is idempotent and anonymously redirects with a 12-character ID', async () => {
  const args = {
    operation_id: randomUUID(),
    target_url: 'https://example.com/a?b=1',
    title: '测试',
    tags: ['docs'],
  };
  const created = await call('resource.create_url', args);
  assert.match(created.resource.id, /^[A-Za-z0-9]{12}$/);
  assert.equal(created.resource.state, 'published');
  assert.equal(created.operation.status, 'completed');
  assert.equal(created.operation.steps.kv, 'accepted');
  assert.equal(
    (await call('resource.create_url', args)).resource.id,
    created.resource.id,
  );
  const response = await request(`/r/${created.resource.id}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), args.target_url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Access assertion verification, origin checks and MCP protocol boundaries', async () => {
  assert.equal((await request('/mcp')).status, 401);
  for (const token of [
    jwt({ aud: ['other'] }),
    jwt({ iss: 'https://evil.test' }),
    jwt({ exp: 1 }),
    jwt({ nbf: 9999999999 }),
    jwt({}, { alg: 'none' }),
    jwt({}, { kid: 'unknown' }),
    `${jwt().slice(0, -12)}aaaaaaaaaaaa`,
  ]) {
    assert.equal(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, token)).status,
      401,
    );
  }
  assert.equal(
    (
      await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), {
        origin: 'https://evil.test',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), {
        'mcp-protocol-version': 'bad',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, jwt(), {
        accept: 'application/json',
      })
    ).status,
    406,
  );
  assert.equal(
    (await request('/mcp', { headers: { 'cf-access-jwt-assertion': jwt() } }))
      .status,
    405,
  );
  assert.equal(
    (await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status,
    202,
  );
  assert.equal(
    (
      await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        extra: 'x'.repeat(66000),
      })
    ).status,
    413,
  );
  const unknown = await rpc({ jsonrpc: '2.0', id: 3, method: 'missing' });
  assert.equal(
    ((await unknown.json()) as { error: { code: number } }).error.code,
    -32601,
  );
  assert.equal(
    (await request('/r/invalid')).headers.get('cache-control'),
    'no-store',
  );
  assert.equal(
    await (await request('/r/invalid', { method: 'HEAD' })).text(),
    '',
  );
  assert.equal((await request('/upload', { method: 'POST' })).status, 401);
});

test('MCP negotiates supported versions and rejects unsupported HTTP version headers', async () => {
  const initialize = (protocolVersion: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'version-test', version: '1.0.0' },
    },
  });
  for (const version of ['2025-11-25', '2025-06-18']) {
    const headers = { 'mcp-protocol-version': version };
    for (const requestHeaders of [headers, {}]) {
      const response = await rpc(initialize(version), jwt(), requestHeaders);
      assert.equal(response.status, 200, version);
      assert.equal(
        ((await response.json()) as { result: { protocolVersion: string } })
          .result.protocolVersion,
        version,
      );
    }
    assert.equal(
      (
        await rpc(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          jwt(),
          headers,
        )
      ).status,
      202,
    );
    const listed = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      jwt(),
      headers,
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (
        (await listed.json()) as { result: { tools: { name: string }[] } }
      ).result.tools.map((tool) => tool.name),
      ['describe', 'invoke'],
    );
    const called = await rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'describe',
          arguments: { operation: 'storage.get' },
        },
      },
      jwt(),
      headers,
    );
    const result = (
      (await called.json()) as {
        result: { isError: boolean; structuredContent: Descriptor };
      }
    ).result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.name, 'storage.get');
  }
  const fallback = await rpc(initialize('2099-01-01'));
  assert.equal(
    ((await fallback.json()) as { result: { protocolVersion: string } }).result
      .protocolVersion,
    '2025-11-25',
  );
  for (const method of [
    'initialize',
    'tools/list',
    'notifications/initialized',
  ]) {
    const response = await rpc({ ...initialize('2099-01-01'), method }, jwt(), {
      'mcp-protocol-version': '2099-01-01',
    });
    assert.equal(response.status, 400);
  }
});

test('MCP SDK negotiates 2025-11-25 and uses it for subsequent tool calls', async (t) => {
  const requests: {
    body: { params: { protocolVersion: string }; method: string };
    version: string | null;
  }[] = [];
  const sdk = new Client({ name: 'new-version-test', version: '1.0.0' });
  t.after(() => sdk.close());
  await sdk.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { 'cf-access-jwt-assertion': jwt() } },
      fetch: (url, init) => {
        if (init?.method === 'POST')
          requests.push({
            body: JSON.parse(String(init.body)),
            version: new Headers(init.headers).get('mcp-protocol-version'),
          });
        return mf.dispatchFetch(
          String(url),
          init as Parameters<Miniflare['dispatchFetch']>[1],
        ) as unknown as Promise<Response>;
      },
    }),
  );
  assert.deepEqual(
    (await sdk.listTools()).tools.map((tool) => tool.name),
    ['describe', 'invoke'],
  );
  const result = await sdk.callTool({
    name: 'invoke',
    arguments: { operation: 'storage.get', arguments: {} },
  });
  assert.equal(result.isError, false);
  assert.equal(
    typeof (result.structuredContent as Storage).published_bytes,
    'number',
  );
  assert.equal(requests[0].body.params.protocolVersion, '2025-11-25');
  for (const request of requests.slice(1))
    assert.equal(request.version, '2025-11-25', request.body.method);
});

test('two tools discover strict operation schemas, results, side effects and valid examples', async () => {
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['describe', 'invoke'],
  );
  const catalog = await client.callTool({ name: 'describe', arguments: {} });
  assert.equal((catalog.structuredContent as Catalog).operations.length, 14);
  assert.equal(
    (catalog.structuredContent as Catalog).defaults.mapping_freshness_seconds,
    86400,
  );
  const invalidDescribe = await client.callTool({
    name: 'describe',
    arguments: { operation: null },
  });
  assert.equal(invalidDescribe.isError, true);
  for (const op of (catalog.structuredContent as Catalog).operations) {
    const detail = await client.callTool({
      name: 'describe',
      arguments: { operation: op.name },
    });
    assert.equal(detail.isError, false);
    assert.equal(
      (detail.structuredContent as Descriptor).inputSchema.additionalProperties,
      false,
    );
    assert(
      (detail.structuredContent as Descriptor).result &&
        (detail.structuredContent as Descriptor).side_effects,
    );
    await errorCall(
      op.name,
      {
        ...(detail.structuredContent as Descriptor).example,
        unknown_field: true,
      },
      'INVALID_ARGUMENTS',
    );
  }
  const base = {
    operation_id: randomUUID(),
    target_url: 'https://example.com/',
  };
  for (const changes of [
    { title: null },
    { tags: ['duplicate', 'duplicate'] },
    { tags: [7] },
    { title: 'x'.repeat(513) },
    { target_url: 'javascript:alert(1)' },
    { target_url: '/relative' },
    { target_url: 'https://example.com/\r\nset-cookie: bad' },
    { operation_id: '' },
  ]) {
    await errorCall(
      'resource.create_url',
      { ...base, ...changes },
      'INVALID_ARGUMENTS',
    );
  }
  for (const limit of [0, 101, 1.5, '20', null])
    await errorCall('resource.list', { limit }, 'INVALID_ARGUMENTS');
  await errorCall(
    'resource.get',
    { resource_id: '............' },
    'INVALID_ARGUMENTS',
  );
  await errorCall(
    'resource.list',
    { created_from: 10, created_to: 5 },
    'INVALID_TIME_RANGE',
  );
  await errorCall('unimplemented.operation', {}, 'UNKNOWN_OPERATION');
});

test('concurrent creates and response loss keep one resource; conflicts and D1 aborts leave no orphan', async () => {
  const args = {
    operation_id: randomUUID(),
    target_url: 'https://example.com/race',
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => call('resource.create_url', args)),
  );
  assert.equal(new Set(results.map((result) => result.resource.id)).size, 1);
  assert.equal(
    (await db
      .prepare('SELECT count(*) AS n FROM resources WHERE target_url=?')
      .bind(args.target_url)
      .first())!.n,
    1,
  );
  const recovered = await call('operation.get', {
    operation_id: args.operation_id,
  });
  assert.equal(recovered.resource.id, results[0].resource.id);
  await errorCall(
    'resource.create_url',
    { ...args, title: 'changed' },
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (
      await call('resource.create_url', {
        ...args,
        title: '',
        description: '',
        tags: [],
      })
    ).resource.id,
    recovered.resource.id,
  );
  const other = await create({ target_url: args.target_url });
  assert.notEqual(other.resource.id, recovered.resource.id);
  await db.exec(
    "CREATE TRIGGER abort_operation BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'injected transaction failure secret-must-not-leak'); END",
  );
  try {
    const failure = await errorCall(
      'resource.create_url',
      {
        operation_id: randomUUID(),
        target_url: 'https://example.com/rollback',
      },
      'STORAGE_UNAVAILABLE',
    );
    assert.equal(failure.retryable, true);
    assert.equal(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM resources WHERE target_url='https://example.com/rollback'",
        )
        .first())!.n,
      0,
    );
    await errorCall(
      'resource.update',
      { resource_id: other.resource.id, title: 'must rollback' },
      'STORAGE_UNAVAILABLE',
    );
    assert.equal(
      (await call('resource.get', { resource_id: other.resource.id })).resource
        .title,
      '',
    );
  } finally {
    await db.exec('DROP TRIGGER abort_operation');
  }
});

test('12-character ID collision retries without overwriting a retained tombstone', async () => {
  await db
    .prepare(
      "INSERT INTO resources(id,kind,state,title,created_at,deleted_at) VALUES('AAAAAAAAAAAA','url','deleted','reserved',?,?)",
    )
    .bind(now(), now())
    .run();
  collide = true;
  const result = await create();
  assert.notEqual(result.resource.id, 'AAAAAAAAAAAA');
  assert.match(result.resource.id, /^[A-Za-z0-9]{12}$/);
  assert.equal(
    (await call('resource.get', { resource_id: 'AAAAAAAAAAAA' })).resource
      .title,
    'reserved',
  );
});

test('updates redirect to current URL and deletion cannot be undone by replay or metadata edit', async () => {
  const args = {
    operation_id: randomUUID(),
    target_url: 'https://example.com/old',
    title: 'history',
  };
  const created = await call('resource.create_url', args);
  const resource_id = created.resource.id;
  const updated = await call('resource.update', {
    resource_id,
    target_url: 'https://example.com/new',
    title: 'new title',
    tags: ['a'],
  });
  assert.equal(updated.operation.type, 'resource.update');
  const response = await request(`/r/${resource_id}`, {
    method: 'HEAD',
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('location'), 'https://example.com/new');
  await errorCall('resource.update', { resource_id }, 'INVALID_ARGUMENTS');
  const deleted = await call('resource.delete', { resource_id });
  assert.equal(deleted.resource.state, 'deleted');
  assert.equal(deleted.resource.title, 'new title');
  assert.equal(deleted.resource.target_url, null);
  assert.equal((await request(`/r/${resource_id}`)).status, 404);
  assert.equal(
    (await call('resource.create_url', args)).resource.state,
    'deleted',
  );
  assert.equal(
    (await call('resource.delete', { resource_id })).resource.state,
    'deleted',
  );
  await errorCall(
    'resource.update',
    { resource_id, title: 'restore' },
    'RESOURCE_DELETED',
  );
  const listed = await call('operation.list', { resource_id });
  assert.equal(listed.items.length, 3);
  assert.equal(
    (await call('resource.list', { keyword: 'new title' })).items.length,
    0,
  );
});

test('literal keyword search, tag intersection, time bounds and filter-bound keyset pagination', async () => {
  const tag = randomUUID();
  const ids = [];
  for (const title of [
    '文档 ABC 100%_1',
    '文档 abc 100XX1',
    '文档 abc 100%_1 second',
    'unmatched',
  ]) {
    const item = await create({
      title,
      description: '中文描述',
      tags: title === 'unmatched' ? [tag] : [tag, 'docs'],
    });
    ids.push(item.resource.id);
  }
  const literal = await call('resource.list', {
    keyword: 'ABC 100%_1',
    tags: [tag, 'docs'],
  });
  assert.deepEqual(
    new Set(literal.items.map((row) => row.id)),
    new Set([ids[0], ids[2]]),
  );
  const filter = {
    keyword: '中文',
    tags: [tag],
    kind: 'url',
    created_from: now() - 60,
    created_to: now() + 60,
  };
  const all = [],
    seenCursors = new Set();
  let cursor: string | null | undefined;
  do {
    const page = await call('resource.list', {
      ...filter,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.items.map((row) => row.id));
    if (page.next_cursor) {
      assert(!seenCursors.has(page.next_cursor));
      seenCursors.add(page.next_cursor);
      await errorCall(
        'resource.list',
        { ...filter, keyword: 'different', cursor: page.next_cursor },
        'INVALID_CURSOR',
      );
    }
    assert.equal(page.has_more, Boolean(page.next_cursor));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(all.length, 4);
  assert.equal(new Set(all).size, 4);
  const expected = (
    await db
      .prepare(
        'SELECT id FROM resources WHERE id IN (?,?,?,?) ORDER BY created_at DESC,id DESC',
      )
      .bind(...ids)
      .all()
  ).results.map((row) => row.id);
  assert.deepEqual(all, expected);
  await errorCall(
    'resource.list',
    { cursor: 'not-a-cursor' },
    'INVALID_CURSOR',
  );
  const ops = await call('operation.list', { limit: 2 });
  assert.equal(ops.items.length, 2);
  assert.equal(ops.has_more, true);
  assert.equal(
    (
      await call('operation.list', { limit: 2, cursor: ops.next_cursor })
    ).items.some((row) =>
      ops.items.some((first) => first.operation_id === row.operation_id),
    ),
    false,
  );
});

test('KV failure preserves published state; public reads fall back to primary and faults are not 404', async () => {
  failPut = true;
  try {
    const result = await create();
    assert.equal(result.resource.state, 'published');
    assert.equal(result.operation.status, 'retry_pending');
    assert.equal(result.operation.steps.kv, 'failed');
    assert.equal(result.operation.last_error!.code, 'KV_SYNC_FAILED');
    assert.match(result.operation.last_error!.message, /^[\x20-\x7e]+$/);
    assert.equal(result.operation.retry_count, 0);
    assert.equal(result.operation.total_attempts, 1);
    assert(result.operation.next_retry_at! >= now() + 295);
    failGet = true;
    assert.equal(
      (await request(`/r/${result.resource.id}`, { redirect: 'manual' }))
        .status,
      302,
    );
    await db.exec('ALTER TABLE resources RENAME TO resources_offline');
    try {
      assert.equal((await request(`/r/${result.resource.id}`)).status, 503);
    } finally {
      await db.exec('ALTER TABLE resources_offline RENAME TO resources');
    }
  } finally {
    failGet = false;
    failPut = false;
  }
});

test('KV absolute freshness rejects expired/malformed/negative entries and does not extend on cache hit', async () => {
  const result = await create();
  const id = result.resource.id;
  const original = JSON.parse((await kv.get(id))!);
  assert.equal(original.valid_until - original.observed_at, 86400);
  await request(`/r/${id}`, { redirect: 'manual' });
  assert.deepEqual(JSON.parse((await kv.get(id))!), original);
  for (const value of [
    JSON.stringify({
      ...original,
      observed_at: now() - 86401,
      valid_until: now() - 1,
      target_url: 'https://example.com/stale',
    }),
    'bad-json',
    JSON.stringify({ ...original, state: 'missing' }),
    JSON.stringify({ ...original, valid_until: now() + 600 }),
    JSON.stringify({ ...original, target_url: 'javascript:alert(1)' }),
  ]) {
    await kv.put(id, value);
    const response = await request(`/r/${id}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), result.resource.target_url);
  }
  failGet = true;
  try {
    assert.equal((await request('/r/ZZZZZZZZZZZZ')).status, 404);
  } finally {
    failGet = false;
  }
});

test('Cron retries current state, enforces leases, exponential backoff and ten-attempt limit', async () => {
  failPut = true;
  let operation_id: string | undefined;
  try {
    const result = await create();
    operation_id = result.operation.operation_id;
    for (let retry = 1; retry <= 10; retry++) {
      await db
        .prepare('UPDATE operations SET next_retry_at=0 WHERE id=?')
        .bind(operation_id)
        .run();
      await cron();
      const op: ResourceResult['operation'] = (
        await call('operation.get', { operation_id })
      ).operation;
      assert.equal(op.retry_count, retry);
      assert.equal(op.total_attempts, retry + 1);
      assert.equal(
        op.status,
        retry === 10 ? 'needs_attention' : 'retry_pending',
      );
      if (retry < 10)
        assert(
          Math.abs(
            op.next_retry_at! - now() - Math.min(300 * 2 ** retry, 3600),
          ) <= 2,
        );
      else assert.equal(op.next_retry_at, null);
    }
    await cron();
    assert.equal(
      (await call('operation.get', { operation_id })).operation.total_attempts,
      11,
    );
  } finally {
    failPut = false;
  }
  const retried = await call('operation.retry', { operation_id });
  assert.equal(retried.operation.status, 'pending');
  assert.equal(retried.operation.retry_count, 0);
  assert.equal(retried.operation.total_attempts, 11);
  assert.equal(retried.operation.last_error!.code, 'KV_SYNC_FAILED');
  await db
    .prepare(
      "UPDATE operations SET status='running',lease_token='active',lease_until=?,next_retry_at=0 WHERE id=?",
    )
    .bind(now() + 3600, operation_id)
    .run();
  await cron();
  assert.equal(
    (await call('operation.retry', { operation_id })).operation.status,
    'running',
  );
  assert.equal(
    (await call('operation.get', { operation_id })).operation.total_attempts,
    11,
  );
  await db
    .prepare('UPDATE operations SET lease_until=0 WHERE id=?')
    .bind(operation_id)
    .run();
  await cron();
  assert.equal(
    (await call('operation.get', { operation_id })).operation.status,
    'completed',
  );
});

test('old sync tasks cannot resurrect deleted resources; interrupted D1 acknowledgment is recoverable', async () => {
  failPut = true;
  let result: ResourceResult;
  try {
    result = await create();
  } finally {
    failPut = false;
  }
  const operation_id = result.operation.operation_id;
  await call('resource.delete', { resource_id: result.resource.id });
  await call('operation.retry', { operation_id });
  await cron();
  assert.equal((await request(`/r/${result.resource.id}`)).status, 404);
  assert.equal(
    JSON.parse((await kv.get(result.resource.id))!).state,
    'deleted',
  );
  assert.equal(
    (await call('operation.get', { operation_id })).resource.state,
    'deleted',
  );
  await db.exec(
    "CREATE TRIGGER interrupt_ack BEFORE UPDATE ON operations WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'acknowledgment interrupted'); END",
  );
  let interrupted: ResourceResult;
  try {
    interrupted = await create();
  } finally {
    await db.exec('DROP TRIGGER interrupt_ack');
  }
  assert.equal(interrupted.operation.status, 'running');
  assert.equal(
    (await request(`/r/${interrupted.resource.id}`, { redirect: 'manual' }))
      .status,
    302,
  );
  await db
    .prepare('UPDATE operations SET next_retry_at=0,lease_until=0 WHERE id=?')
    .bind(interrupted.operation.operation_id)
    .run();
  await cron();
  assert.equal(
    (
      await call('operation.get', {
        operation_id: interrupted.operation.operation_id,
      })
    ).operation.status,
    'completed',
  );
});

test('cursors cannot be reused across resource and operation lists', async () => {
  await create();
  await create();
  const page = await call('operation.list', { limit: 1 });
  assert(page.next_cursor);
  await errorCall(
    'resource.list',
    { cursor: page.next_cursor, limit: 1 },
    'INVALID_CURSOR',
  );
});

test('resource detail returns most recently registered operation within the same second', async () => {
  const created = await create({ operation_id: '~'.repeat(128) });
  const updated = await call('resource.update', {
    resource_id: created.resource.id,
    title: 'latest',
  });
  await db
    .prepare('UPDATE operations SET created_at=123 WHERE resource_id=?')
    .bind(created.resource.id)
    .run();
  const result = await call('resource.get', {
    resource_id: created.resource.id,
  });
  assert.equal(result.operation.operation_id, updated.operation.operation_id);
});

test('delayed backfill competing with deletion cannot renew its old snapshot', {
  timeout: 10000,
}, async () => {
  const created = await create();
  const id = created.resource.id;
  await kv.delete(id);
  let release!: () => void, arrived!: () => void, snapshot!: Mapping;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  onPut = async (mapping) => {
    if (mapping.id === id && mapping.state === 'published') {
      snapshot = mapping;
      arrived();
      await blocked;
    }
  };
  const reading = request(`/r/${id}`, { redirect: 'manual' });
  try {
    await waiting;
    await call('resource.delete', { resource_id: id });
    clockOffset = 86401000;
    release();
    await reading;
    const stored = JSON.parse((await kv.get(id))!);
    assert.deepEqual(stored, snapshot);
    assert.equal(stored.valid_until, snapshot.observed_at + 86400);
    assert.equal((await request(`/r/${id}`)).status, 404);
    assert.equal(JSON.parse((await kv.get(id))!).state, 'deleted');
  } finally {
    release();
    await reading;
    onPut = undefined;
    clockOffset = 0;
  }
});

test('simultaneous Cron calls acquire one operation lease and stale holders cannot acknowledge it', {
  timeout: 10000,
}, async () => {
  failPut = true;
  let created: ResourceResult;
  try {
    created = await create();
  } finally {
    failPut = false;
  }
  const operation_id = created.operation.operation_id;
  await db
    .prepare('UPDATE operations SET next_retry_at=0 WHERE id=?')
    .bind(operation_id)
    .run();
  let release!: () => void,
    arrived!: () => void,
    writes = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  onPut = async (mapping) => {
    if (mapping.id === created.resource.id) {
      writes++;
      arrived();
      await blocked;
    }
  };
  const running = cron();
  try {
    await waiting;
    await cron();
    assert.equal(writes, 1);
    await db
      .prepare(
        "UPDATE operations SET lease_token='replacement',status='running' WHERE id=?",
      )
      .bind(operation_id)
      .run();
    release();
    await running;
    const op: ResourceResult['operation'] = (
      await call('operation.get', { operation_id })
    ).operation;
    assert.equal(op.status, 'running');
    assert.equal(op.total_attempts, 2);
  } finally {
    release();
    await running;
    onPut = undefined;
  }
  await db
    .prepare('UPDATE operations SET lease_until=0,next_retry_at=0 WHERE id=?')
    .bind(operation_id)
    .run();
  await cron();
  assert.equal(
    (await call('operation.get', { operation_id })).operation.status,
    'completed',
  );
});

test('the tenth interrupted automatic attempt stops until manually resumed', async () => {
  const created = await create();
  const operation_id = created.operation.operation_id;
  await db
    .prepare(
      "UPDATE operations SET status='running',retry_count=10,total_attempts=11,lease_token='crashed',lease_until=0,next_retry_at=0 WHERE id=?",
    )
    .bind(operation_id)
    .run();
  await cron();
  const op: ResourceResult['operation'] = (
    await call('operation.get', { operation_id })
  ).operation;
  assert.equal(op.status, 'needs_attention');
  assert.equal(op.total_attempts, 11);
  assert.equal(op.last_error!.code, 'EXECUTION_INTERRUPTED');
  await call('operation.retry', { operation_id });
  await cron();
  assert.equal(
    (await call('operation.get', { operation_id })).operation.status,
    'completed',
  );
});

function multipart(
  data: Buffer,
  changes: Record<string, unknown> = {},
  tail = '',
) {
  const boundary = 'formal-boundary';
  const metadata = {
    operation_id: randomUUID(),
    filename: 'fixture.bin',
    content_type: 'application/octet-stream',
    size_bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    ...changes,
  };
  return {
    metadata,
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}${tail || '--\r\n'}`),
    ]),
  };
}
type Multipart = Omit<ReturnType<typeof multipart>, 'body'> & {
  body: Buffer | ReadableStream<Uint8Array>;
};
const upload = (token: string, form: Multipart) =>
  request('/upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': form.contentType,
    },
    body: form.body,
    duplex: 'half',
  });
async function uploaded(data: Buffer, changes: Record<string, unknown> = {}) {
  const { token } = await call('session.create');
  const form = multipart(data, changes);
  const response = await upload(token, form);
  assert.equal(response.status, 201, await response.clone().text());
  return { ...((await response.json()) as ResourceResult), token, form };
}

test('upload discovery is read-only, credential-free and identical to the created session contract', async () => {
  const before = await db
    .prepare('SELECT count(*) AS n FROM upload_sessions')
    .first();
  const statements: D1Event[] = [];
  onD1Before = (event) => {
    statements.push(event);
  };
  let detail: Descriptor;
  try {
    detail = (
      await client.callTool({
        name: 'describe',
        arguments: { operation: 'session.create' },
      })
    ).structuredContent as Descriptor;
  } finally {
    onD1Before = undefined;
  }
  assert.deepEqual(statements, []);
  assert.deepEqual(
    await db.prepare('SELECT count(*) AS n FROM upload_sessions').first(),
    before,
  );
  assert(
    detail.upload,
    'describe(session.create) must expose the upload contract without creating a session',
  );
  assert.equal(detail.token, undefined);
  assert.equal(detail.session_id, undefined);
  assert.equal(detail.upload.protocol_version, 1);
  assert.equal(detail.upload.url, `${origin}/upload`);
  assert.equal(detail.upload.method, 'POST');
  assert.equal(detail.upload.authorization, 'Bearer <token>');
  assert.equal(detail.upload.max_metadata_bytes, 16384);
  assert.deepEqual(detail.upload.generated_fields, [
    'operation_id',
    'size_bytes',
    'sha256',
  ]);
  const session = await call('session.create');
  assert.deepEqual(session.upload, detail.upload);
  assert(!JSON.stringify(detail).includes(session.token));
  const operationDetail = (
    await client.callTool({
      name: 'describe',
      arguments: { operation: 'operation.get' },
    })
  ).structuredContent as Descriptor;
  assert.deepEqual(detail.upload.result_schema, operationDetail.resultSchema);
  assert.deepEqual(
    detail.upload.result_semantics,
    operationDetail.result_semantics,
  );
  for (const field of [
    'filename',
    'content_type',
    'title',
    'description',
    'tags',
    'retention_seconds',
  ]) {
    assert(detail.upload.metadata_schema.properties[field].description, field);
  }
  assert.equal(
    detail.upload.metadata_schema.properties.retention_seconds.default,
    2592000,
  );
  const urlDetail = (
    await client.callTool({
      name: 'describe',
      arguments: { operation: 'resource.create_url' },
    })
  ).structuredContent as Descriptor;
  assert.deepEqual(
    urlDetail.inputSchema.properties.retention_seconds,
    detail.upload.metadata_schema.properties.retention_seconds,
  );
  for (const operation of [
    'resource.create_url',
    'resource.get',
    'resource.update',
    'resource.delete',
  ]) {
    const resourceDetail = (
      await client.callTool({ name: 'describe', arguments: { operation } })
    ).structuredContent as Descriptor;
    assert.deepEqual(
      resourceDetail.result_semantics,
      detail.upload.result_semantics,
    );
    if (operation === 'resource.get')
      assert.equal(resourceDetail.resultSchema, undefined);
    if (operation === 'resource.update')
      assert(resourceDetail.inputSchema.properties.expires_at.description);
  }

  assert.match(detail.upload.recovery, /operation.get/);
  assert.match(detail.upload.recovery, /NOT_FOUND/);
  assert.match(detail.upload.recovery, /needs_reupload/);
});

test('discovered upload metadata examples and constraints match authoritative runtime validation', async () => {
  const detail = (
    await client.callTool({
      name: 'describe',
      arguments: { operation: 'session.create' },
    })
  ).structuredContent as Descriptor;
  assert(detail.upload, 'missing discovered upload contract');
  const { token } = await call('session.create');
  const example = detail.upload.metadata_schema.examples[0];
  // The published example describes an empty file, including its actual checksum.
  const valid = multipart(Buffer.alloc(0), {
    ...example,
    operation_id: randomUUID(),
  });
  assert.equal((await upload(token, valid)).status, 201);
  const result = await call('operation.get', {
    operation_id: valid.metadata.operation_id,
  });
  const validateResult = new AjvJsonSchemaValidator().getValidator(
    detail.upload.result_schema,
  );
  const assertResult = (value: unknown) => {
    const checked = validateResult(value);
    assert.equal(checked.valid, true, checked.errorMessage);
  };
  assertResult(result);
  assertResult({ ...result, future_field: true });
  assert.equal(validateResult({ resource: result.resource }).valid, false);
  const missing = await errorCall(
    'operation.get',
    { operation_id: randomUUID() },
    'NOT_FOUND',
  );
  assertResult({ error: missing });
  const pendingForm = multipart(Buffer.from('bad checksum'), {
    sha256: '0'.repeat(64),
    retention_seconds: null,
  });
  const pending = (await (
    await upload(token, pendingForm)
  ).json()) as ResourceResult;
  assertResult(pending);
  assert.equal(pending.resource.accessible, false);
  assert.equal(pending.resource.expires_at, null);
  assert.equal(pending.operation.steps.upload, 'needs_reupload');
  await call('resource.delete', { resource_id: pending.resource.id });
  assertResult(
    await call('operation.get', {
      operation_id: pendingForm.metadata.operation_id,
    }),
  );
  assert.equal(result.resource.accessible, true);
  assert.equal(
    result.resource.expires_at! - result.resource.published_at!,
    2592000,
  );
  for (const changes of [
    { unknown_field: true },
    { filename: 'bad\nname' },
    { content_type: 'text/plain; charset=utf-8' },
    { sha256: 'A'.repeat(64) },
    { title: null },
    { tags: ['same', 'same'] },
    { retention_seconds: 0 },
  ]) {
    const form = multipart(Buffer.alloc(0), changes);
    assert.equal(
      (await upload(token, form)).status,
      400,
      JSON.stringify(changes),
    );
    assert.equal(
      await db
        .prepare('SELECT id FROM operations WHERE id=?')
        .bind(form.metadata.operation_id)
        .first(),
      null,
    );
  }
  // These strings satisfy their character limits but their UTF-8 JSON exceeds the advertised byte limit.
  const tooLarge = multipart(Buffer.alloc(0), {
    description: '汉'.repeat(6000),
  });
  assert(
    Buffer.byteLength(JSON.stringify(tooLarge.metadata)) >
      detail.upload.max_metadata_bytes,
  );
  assert.equal((await upload(token, tooLarge)).status, 400);
});

test('session tokens are hash-only, valid for 24h, reusable, paginated and revocable', async () => {
  const session = await call('session.create', { client: 'file-test' });
  assert.equal(session.expires_at - session.created_at, 86400);
  const row = await db
    .prepare('SELECT * FROM upload_sessions WHERE id=?')
    .bind(session.session_id)
    .first();
  assert.equal(
    row!.token_hash,
    createHash('sha256').update(session.token).digest('hex'),
  );
  assert(!JSON.stringify(row).includes(session.token));
  assert(session.upload.metadata_schema.properties.sha256);
  for (const data of [Buffer.alloc(0), Buffer.from('second upload')]) {
    const form = multipart(data);
    const response = await upload(session.token, form);
    assert.equal(response.status, 201, await response.clone().text());
    const result = (await response.json()) as ResourceResult;
    assert.equal(result.resource.state, 'published');
    assert.match(result.resource.id, /^[A-Za-z0-9]{12}$/);
    assert.deepEqual(
      Buffer.from(
        await (await request(`/r/${result.resource.id}`)).arrayBuffer(),
      ),
      data,
    );
    assert.equal((await upload(session.token, form)).status, 200);
  }
  const page = await call('session.list', { limit: 1 });
  assert(!JSON.stringify(page).includes(session.token));
  await call('session.revoke', { session_id: session.session_id });
  assert.equal(
    (await upload(session.token, multipart(Buffer.from('revoked')))).status,
    401,
  );
  const expired = await call('session.create');
  await db
    .prepare('UPDATE upload_sessions SET expires_at=0 WHERE id=?')
    .bind(expired.session_id)
    .run();
  assert.equal(
    (await upload(expired.token, multipart(Buffer.alloc(0)))).status,
    401,
  );
});

test('same filename and same hash create independent resources; metadata is mutable, binary attributes are not', async () => {
  const tag = randomUUID();
  const data = Buffer.from('same');
  const a = await uploaded(data, {
    filename: '中文 ABC 100%_1.bin',
    title: 'file title',
    description: 'description',
    tags: [tag],
  });
  const b = await uploaded(data, { filename: a.resource.filename });
  assert.notEqual(a.resource.id, b.resource.id);
  const conflicting = multipart(data, { ...a.form.metadata, title: 'changed' });
  assert.equal((await upload(a.token, conflicting)).status, 409);
  assert.equal(
    (
      await call('resource.list', {
        keyword: 'abc 100%_1',
        tags: [tag],
        kind: 'file',
      })
    ).items[0].id,
    a.resource.id,
  );
  assert.equal(
    (await call('resource.list', { filename: a.resource.filename })).items
      .length,
    2,
  );
  await call('resource.update', {
    resource_id: a.resource.id,
    title: 'edited',
    tags: [],
  });
  await errorCall(
    'resource.update',
    { resource_id: a.resource.id, target_url: 'https://example.com/' },
    'IMMUTABLE_FILE',
  );
  await errorCall(
    'resource.update',
    { resource_id: a.resource.id, filename: 'changed' },
    'INVALID_ARGUMENTS',
  );
  assert.deepEqual(
    Buffer.from(await (await request(`/r/${a.resource.id}`)).arrayBuffer()),
    data,
  );
  const deleted = await call('resource.delete', { resource_id: a.resource.id });
  assert.equal(deleted.resource.state, 'deleted');
  assert.equal(deleted.operation.steps.r2_cleanup, 'completed');
  assert.equal((await request(`/r/${a.resource.id}`)).status, 404);
  assert.equal(
    ((await (await upload(a.token, a.form)).json()) as ResourceResult).resource
      .state,
    'deleted',
  );
});

test('file ranges, HEAD, RFC filename, raw SVG and browser cache headers', async () => {
  const data = Buffer.from('0123456789');
  const a = await uploaded(data, { filename: '中文 "x".txt' });
  const path = `/r/${a.resource.id}`;
  const response = await request(path);
  assert.equal(
    response.headers.get('cache-control'),
    'private, max-age=31536000, immutable',
  );
  assert.match(
    response.headers.get('content-disposition')!,
    /^attachment; filename="/,
  );
  assert(
    response.headers
      .get('content-disposition')!
      .includes("filename*=UTF-8''%E4%B8%AD%E6%96%87"),
  );
  await response.arrayBuffer();
  for (const [range, expected, header] of [
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=0-99', '0123456789', 'bytes 0-9/10'],
  ]) {
    const res = await request(path, { headers: { range } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), header);
    assert.equal(await res.text(), expected);
  }
  for (const range of ['bytes=10-', 'bytes=-0', 'bytes=4-2', 'bytes=0-1,4-5']) {
    const res = await request(path, { headers: { range } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  const head = await request(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
  );
  const image = await uploaded(svg, {
    content_type: 'image/svg+xml',
    filename: 'raw.svg',
  });
  assert.equal(image.resource.kind, 'image');
  const shown = await request(`/r/${image.resource.id}`);
  assert.equal(shown.headers.get('content-type'), 'image/svg+xml');
  assert.match(shown.headers.get('content-disposition')!, /^inline/);
  assert.equal(shown.headers.get('content-security-policy'), null);
  assert.equal(await shown.text(), svg.toString());
});

test('length/hash/framing failures release only fenced reservations and allow same-operation retransmit', async () => {
  const { token } = await call('session.create');
  const bucket = await mf.getR2Bucket('FILES');
  for (const changes of [
    { size_bytes: 1 },
    { size_bytes: 99 },
    { sha256: '0'.repeat(64) },
  ]) {
    const form = multipart(Buffer.from('wrong'), changes);
    const response = await upload(token, form);
    assert.equal(response.status, 422, await response.clone().text());
    const result = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    assert.equal(result.resource.state, 'pending');
    assert.equal(result.resource.accounting, 'released');
    assert.equal(result.operation.steps.upload, 'needs_reupload');
    assert.equal(result.operation.status, 'needs_attention');
    const fence = await bucket.head(result.resource.file_key!);
    assert.equal(fence!.size, 0);
    assert.equal(fence!.customMetadata!.role, 'fence');
    assert.equal((await request(`/r/${result.resource.id}`)).status, 404);
  }
  const data = Buffer.from('retransmit');
  const good = multipart(data);
  const bad = { ...good, body: good.body.subarray(0, good.body.length - 12) };
  assert.equal((await upload(token, bad)).status, 422);
  const old = await call('operation.get', {
    operation_id: good.metadata.operation_id,
  });
  const res = await upload(token, good);
  assert.equal(res.status, 201, await res.clone().text());
  const recovered = (await res.json()) as ResourceResult;
  assert.equal(recovered.resource.id, old.resource.id);
  assert.notEqual(recovered.resource.file_key, old.resource.file_key);
  assert.equal(
    recovered.operation.last_error!.code,
    old.operation.last_error!.code,
  );
  assert.equal(
    recovered.operation.total_attempts,
    old.operation.total_attempts + 1,
  );
});

test('complete owned object is recovered after D1 publication failure', async () => {
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('publish recovery'));
  await db.exec(
    "CREATE TRIGGER fail_publish BEFORE UPDATE ON resources WHEN NEW.state='published' AND OLD.state='pending' BEGIN SELECT RAISE(ABORT,'publish failed'); END",
  );
  let result: ResourceResult;
  try {
    const response = await upload(token, form);
    assert.equal(response.status, 202);
    result = (await response.json()) as ResourceResult;
    assert.equal(result.resource.accounting, 'reserved');
    assert.equal(result.resource.state, 'pending');
    assert.equal(result.resource.published_at, null);
    assert.equal(result.resource.expires_at, null);
  } finally {
    await db.exec('DROP TRIGGER fail_publish');
  }
  await db
    .prepare('UPDATE operations SET next_retry_at=0,lease_until=0 WHERE id=?')
    .bind(form.metadata.operation_id)
    .run();
  await cron();
  const recovered = await call('operation.get', {
    operation_id: form.metadata.operation_id,
  });
  assert.equal(recovered.resource.state, 'published');
  assert.equal(
    recovered.resource.expires_at! - recovered.resource.published_at!,
    2592000,
  );
  assert.equal(recovered.resource.id, result.resource.id);
  assert.equal(
    await (await request(`/r/${result.resource.id}`)).text(),
    'publish recovery',
  );
});

test('concurrent capacity admission and duplicate retries never overreserve or double count', async () => {
  const baseline = await call('storage.get');
  const used =
    baseline.published_bytes + baseline.reserved_bytes + baseline.cleanup_bytes;
  limits = { TOTAL_STORAGE_BYTES: used + 10, MAX_FILE_BYTES: 10 };
  try {
    const { token } = await call('session.create');
    assert.equal(
      (await upload(token, multipart(Buffer.alloc(11)))).status,
      413,
    );
    const forms = [multipart(Buffer.alloc(10)), multipart(Buffer.alloc(10))];
    const responses = await Promise.all(
      forms.map((form) => upload(token, form)),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 413]);
    const winner = (await responses
      .find((r) => r.status === 201)!
      .json()) as ResourceResult;
    const usage = await call('storage.get');
    assert.equal(usage.published_bytes, baseline.published_bytes + 10);
    assert.equal(usage.reserved_bytes, baseline.reserved_bytes);
    await call('resource.delete', { resource_id: winner.resource.id });
    const form = multipart(Buffer.alloc(10));
    const same = await Promise.all([upload(token, form), upload(token, form)]);
    assert.equal(same.filter((r) => r.status === 201).length, 1);
    assert(same.every((r) => [200, 201, 409].includes(r.status)));
    const result = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    await call('resource.delete', { resource_id: result.resource.id });
    const after = await call('storage.get');
    assert.equal(after.published_bytes, baseline.published_bytes);
    assert.equal(after.reserved_bytes, baseline.reserved_bytes);
  } finally {
    limits = {};
  }
});

test('R2 cleanup failure retains capacity through retry exhaustion, manual reset and eventual deletion', async () => {
  const a = await uploaded(Buffer.alloc(13));
  const baseline = await call('storage.get');
  onR2Delete = () => false;
  let operation_id: string | undefined;
  try {
    const deleted = await call('resource.delete', {
      resource_id: a.resource.id,
    });
    operation_id = deleted.operation.operation_id;
    assert.equal(deleted.resource.accounting, 'cleanup');
    assert.equal(deleted.operation.status, 'retry_pending');
    assert.equal(deleted.operation.steps.kv, 'accepted');
    assert.equal(deleted.operation.steps.r2_cleanup, 'failed');
    assert.equal((await request(`/r/${a.resource.id}`)).status, 404);
    for (let i = 1; i <= 10; i++) {
      await db
        .prepare('UPDATE operations SET next_retry_at=0 WHERE id=?')
        .bind(operation_id)
        .run();
      await cron();
    }
    const stopped = await call('operation.get', { operation_id });
    assert.equal(stopped.operation.status, 'needs_attention');
    assert.equal(stopped.operation.retry_count, 10);
    const usage = await call('storage.get');
    assert.equal(usage.published_bytes, baseline.published_bytes - 13);
    assert.equal(usage.cleanup_bytes, baseline.cleanup_bytes + 13);
  } finally {
    onR2Delete = undefined;
  }
  await call('operation.retry', { operation_id });
  await cron();
  const done = await call('operation.get', { operation_id });
  assert.equal(done.resource.accounting, 'released');
  assert.equal(done.operation.status, 'completed');
  assert.equal(done.operation.total_attempts, 12);
  await call('operation.retry', { operation_id });
  await cron();
  assert.equal(
    (await call('storage.get')).cleanup_bytes,
    baseline.cleanup_bytes,
  );
});

test('160 MiB native checksum upload stays below 16 MiB Wasm memory', async () => {
  const chunk = Buffer.alloc(64 * 1024, 0xa5),
    count = 2560;
  const hash = createHash('sha256');
  for (let i = 0; i < count; i++) hash.update(chunk);
  const form: Multipart = multipart(Buffer.alloc(0), {
    size_bytes: chunk.length * count,
    sha256: hash.digest('hex'),
  });
  assert(Buffer.isBuffer(form.body));
  const trailer = Buffer.from('\r\n--formal-boundary--\r\n'),
    prefix = form.body.subarray(0, form.body.length - trailer.length);
  let sent = -1;
  form.body = new ReadableStream({
    pull(c) {
      if (sent === -1) c.enqueue(prefix);
      else if (sent < count) c.enqueue(chunk);
      else {
        c.enqueue(trailer);
        c.close();
      }
      sent++;
    },
  });
  let memory = 0;
  onR2Stored = (event) => {
    memory = Math.max(memory, event.memory);
  };
  try {
    const { token } = await call('session.create');
    const response = await upload(token, form);
    assert.equal(response.status, 201, await response.clone().text());
    const result = (await response.json()) as ResourceResult;
    assert.equal(result.resource.size_bytes, 160 * 1024 * 1024);
    assert(memory < 16 * 1024 * 1024, `Wasm memory ${memory}`);
    console.log('160MiB stream memory:', memory);
    await call('resource.delete', { resource_id: result.resource.id });
  } finally {
    onR2Stored = undefined;
  }
});

test('cached pending snapshot never hides a newly published file when KV publishing fails', async () => {
  const a = await uploaded(Buffer.from('visible'));
  const mapping = JSON.parse((await kv.get(a.resource.id))!);
  await kv.put(a.resource.id, JSON.stringify({ ...mapping, state: 'pending' }));
  failPut = true;
  try {
    const response = await request(`/r/${a.resource.id}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'visible');
  } finally {
    failPut = false;
  }
});

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}
function heartbeatControl() {
  let entered = deferred();
  const queue: ReturnType<typeof deferred<Heartbeat>>[] = [];
  onHeartbeat = () => {
    const reply = deferred<Heartbeat>();
    queue.push(reply);
    entered.resolve();
    return reply.promise;
  };
  return {
    async ready() {
      if (!queue.length) await entered.promise;
    },
    async tick() {
      await this.ready();
      const reply = queue.shift()!;
      entered = deferred();
      clockOffset += 30000;
      reply.resolve({ tick: true, offset: clockOffset });
      await entered.promise;
    },
    close() {
      onHeartbeat = undefined;
      for (const reply of queue) reply.resolve({ tick: false });
    },
  };
}

test('independent heartbeat protects stalled file headers and paused R2 put beyond the original lease', {
  timeout: 15000,
}, async () => {
  for (const mode of ['file-header', 'r2-put']) {
    const heartbeat = heartbeatControl();
    const release = deferred();
    const { token } = await call('session.create');
    const form: Multipart = multipart(Buffer.from('heartbeat'));
    assert(Buffer.isBuffer(form.body));
    if (mode === 'file-header') {
      const cut = form.body.indexOf(
        Buffer.from('Content-Disposition: form-data; name="file"'),
      );
      const original = form.body;
      form.body = new ReadableStream({
        start(c) {
          c.enqueue(original.subarray(0, cut));
          release.promise.then(() => {
            c.enqueue(original.subarray(cut));
            c.close();
          });
        },
      });
    } else {
      onR2Put = async (event) => {
        if (event.options.customMetadata.role !== 'fence')
          await release.promise;
      };
    }
    const uploading = upload(token, form);
    try {
      await heartbeat.ready();
      for (let tick = 0; tick < 5; tick++) await heartbeat.tick();
      await cron();
      const pending = await call('operation.get', {
        operation_id: form.metadata.operation_id,
      });
      assert.equal(pending.operation.steps.upload, 'uploading');
      assert.equal(pending.resource.accounting, 'reserved');
      assert.equal(
        (
          await upload(
            token,
            multipart(Buffer.from('heartbeat'), form.metadata),
          )
        ).status,
        409,
      );
      release.resolve();
      const response = await uploading;
      assert.equal(response.status, 201, await response.clone().text());
    } finally {
      release.resolve();
      await uploading;
      heartbeat.close();
      onR2Put = undefined;
      clockOffset = 0;
    }
  }
});

test('lost heartbeat fences a delayed writer; same-operation retry uses another key and cannot be overwritten', {
  timeout: 15000,
}, async () => {
  const heartbeat = heartbeatControl(),
    release = deferred(),
    entered = deferred();
  let blockedKey: string | undefined;
  onR2Put = async (event) => {
    if (event.options.customMetadata.role !== 'fence' && !blockedKey) {
      blockedKey = event.key;
      entered.resolve();
      await release.promise;
    }
  };
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('fenced writer'));
  const uploading = upload(token, form);
  try {
    await entered.promise;
    await heartbeat.ready();
    await db.exec(
      "CREATE TRIGGER fail_heartbeat BEFORE UPDATE OF lease_until ON operations WHEN NEW.upload_state='uploading' AND NEW.lease_until>OLD.lease_until BEGIN SELECT RAISE(ABORT,'heartbeat failed'); END",
    );
    // Deliver one virtual timer; failure intentionally prevents scheduling the next.
    onHeartbeat = undefined;
    const pendingTimer = heartbeat; // ready barrier already proves timer registration.
    // tick() waits for the next timer, so independently observe the operation transition.
    void pendingTimer.tick();
    const response = await uploading;
    assert.equal(response.status, 422, await response.clone().text());
    await db.exec('DROP TRIGGER fail_heartbeat');
    const fenced = (await response.json()) as ResourceResult;
    assert.equal(fenced.operation.steps.upload, 'needs_reupload');
    assert.equal(fenced.resource.accounting, 'released');
    const retry = await upload(token, form);
    assert.equal(retry.status, 201, await retry.clone().text());
    const recovered = (await retry.json()) as ResourceResult;
    assert.notEqual(recovered.resource.file_key, blockedKey);
    assert.equal(recovered.resource.id, fenced.resource.id);
    release.resolve();
    const bucket = await mf.getR2Bucket('FILES');
    assert.equal(
      (await bucket.head(blockedKey!))!.customMetadata!.role,
      'fence',
    );
    assert.equal(
      await (await request(`/r/${recovered.resource.id}`)).text(),
      'fenced writer',
    );
  } finally {
    release.resolve();
    await uploading;
    await db.exec('DROP TRIGGER IF EXISTS fail_heartbeat');
    heartbeat.close();
    onR2Put = undefined;
    onR2Stored = undefined;
    clockOffset = 0;
  }
});

test('logical deletion racing an accepted upload keeps reserved bytes until upload has ended', {
  timeout: 10000,
}, async () => {
  const release = deferred(),
    entered = deferred();
  onR2Put = async (event) => {
    if (event.options.customMetadata.role !== 'fence') {
      entered.resolve();
      await release.promise;
    }
  };
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('delete during upload'));
  const uploading = upload(token, form);
  try {
    await entered.promise;
    const pending = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    const deletion = await call('resource.delete', {
      resource_id: pending.resource.id,
    });
    assert.equal(deletion.resource.state, 'deleted');
    assert.equal(deletion.resource.accounting, 'reserved');
    assert.equal(deletion.operation.status, 'retry_pending');
    release.resolve();
    await uploading;
    const result = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    assert.equal(result.resource.state, 'deleted');
    assert.equal(result.resource.accounting, 'released');
    assert.equal((await request(`/r/${result.resource.id}`)).status, 404);
    await db
      .prepare('UPDATE operations SET next_retry_at=0 WHERE id=?')
      .bind(deletion.operation.operation_id)
      .run();
    await cron();
    assert.equal(
      (
        await call('operation.get', {
          operation_id: deletion.operation.operation_id,
        })
      ).operation.status,
      'completed',
    );
  } finally {
    release.resolve();
    await uploading;
    onR2Put = undefined;
  }
});

test('migration preserves deployed URL records, permanent IDs and original operation sequence', async () => {
  const result = await call('resource.get', { resource_id: 'LegacyUrl001' });
  assert.equal(result.resource.title, 'legacy');
  assert.equal(result.operation.operation_id, 'legacy-op');
  const response = await request('/r/LegacyUrl001', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://example.com/legacy');
  assert.deepEqual(
    (await db.prepare('PRAGMA foreign_key_check').all()).results,
    [],
  );
});

test('body cache uses public 24h headers but never bypasses deleted or unavailable authoritative state', async () => {
  const a = await uploaded(Buffer.from('cached body'));
  const path = `/r/${a.resource.id}`;
  const stored = deferred();
  const writes: CacheEvent[] = [];
  onCachePut = (event) => {
    writes.push(event);
  };
  onCacheStored = (event) => {
    if (event.url.endsWith(path)) stored.resolve();
  };
  try {
    assert.equal(await (await request(path)).text(), 'cached body');
    await stored.promise;
    assert.equal(writes[0].status, 200);
    assert.equal(writes[0].cacheControl, 'public, max-age=86400');
    failR2Get = true;
    const hit = await request(path);
    assert.equal(hit.status, 200);
    assert.equal(
      hit.headers.get('cache-control'),
      'private, max-age=31536000, immutable',
    );
    assert.equal(await hit.text(), 'cached body');
    await kv.delete(a.resource.id);
    await db.exec('ALTER TABLE resources RENAME TO resources_offline');
    try {
      assert.equal((await request(path)).status, 503);
    } finally {
      await db.exec('ALTER TABLE resources_offline RENAME TO resources');
    }
    // Logical deletion without evicting the cache proves state validation precedes cache access.
    await db
      .prepare(
        "UPDATE resources SET state='deleted',accounting='cleanup' WHERE id=?",
      )
      .bind(a.resource.id)
      .run();
    await kv.delete(a.resource.id);
    assert.equal((await request(path)).status, 404);
  } finally {
    failR2Get = false;
    onCachePut = undefined;
    onCacheStored = undefined;
  }
});

test('cache failures never turn successful R2 body reads into errors and partial responses are never cached', async () => {
  const a = await uploaded(Buffer.from('cache fault'));
  const writes: CacheEvent[] = [];
  onCachePut = (event) => {
    writes.push(event);
  };
  failCacheRead = true;
  failCacheWrite = true;
  try {
    const response = await request(`/r/${a.resource.id}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'cache fault');
    const partial = await request(`/r/${a.resource.id}`, {
      headers: { range: 'bytes=1-3' },
    });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'ach');
    assert(writes.every((event) => event.status === 200));
  } finally {
    failCacheRead = false;
    failCacheWrite = false;
    onCachePut = undefined;
  }
});

test('ownership mismatch cannot publish a foreign object even with matching bytes and digest', async () => {
  const { token } = await call('session.create');
  const data = Buffer.from('owned bytes'),
    form = multipart(data);
  const bucket = await mf.getR2Bucket('FILES');
  let once = true;
  onR2Put = async (event) => {
    if (once && event.options.customMetadata.role !== 'fence') {
      once = false;
      await bucket.put(event.key, data, {
        sha256: createHash('sha256').update(data).digest(),
        customMetadata: {
          upload_token: 'foreign',
          operation_id: form.metadata.operation_id,
        },
      });
    }
  };
  try {
    const response = await upload(token, form);
    assert.equal(response.status, 422);
    const result = (await response.json()) as ResourceResult;
    assert.equal(result.resource.state, 'pending');
    assert.equal(result.resource.accounting, 'reserved');
    assert.equal(result.operation.status, 'needs_attention');
    assert.equal(
      result.operation.last_error!.code,
      'OBJECT_OWNERSHIP_MISMATCH',
    );
    assert.equal(result.operation.last_error!.retryable, false);
  } finally {
    onR2Put = undefined;
  }
});

test('expired old recovery cannot fence or release the next upload attempt', {
  timeout: 10000,
}, async () => {
  const { token } = await call('session.create');
  const data = Buffer.from('next attempt'),
    form = multipart(data);
  const broken = {
    ...form,
    body: form.body.subarray(0, form.body.length - 12),
  };
  assert.equal((await upload(token, broken)).status, 422);
  const failed = await call('operation.get', {
    operation_id: form.metadata.operation_id,
  });
  await call('operation.retry', { operation_id: form.metadata.operation_id });
  const entered = deferred(),
    release = deferred();
  let blocked = false;
  onD1Before = async ({ sql, bindings }) => {
    if (
      !blocked &&
      sql.startsWith('UPDATE operations SET kv_status=') &&
      bindings.includes(form.metadata.operation_id)
    ) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
  };
  const recovering = cron();
  try {
    await entered.promise;
    assert.equal((await upload(token, form)).status, 409); // valid recovery lease blocks admission
    await db
      .prepare('UPDATE operations SET lease_until=0 WHERE id=?')
      .bind(form.metadata.operation_id)
      .run();
    const response = await upload(token, form);
    assert.equal(response.status, 201, await response.clone().text());
    const result = (await response.json()) as ResourceResult;
    assert.notEqual(result.resource.file_key, failed.resource.file_key);
    release.resolve();
    await recovering;
    const current = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    assert.equal(current.resource.accounting, 'published');
    assert.equal(current.operation.status, 'completed');
    assert.equal(
      await (await request(`/r/${current.resource.id}`)).text(),
      'next attempt',
    );
  } finally {
    release.resolve();
    await recovering;
    onD1Before = undefined;
  }
});

test('KV failure does not hide successful file deletion and failed-upload deletion acknowledges prior cleanup', async () => {
  const a = await uploaded(Buffer.from('delete independently'));
  failPut = true;
  let deletion: ResourceResult;
  try {
    deletion = await call('resource.delete', { resource_id: a.resource.id });
    assert.equal(deletion.resource.accounting, 'released');
    assert.equal(deletion.operation.steps.r2_cleanup, 'completed');
    assert.equal(deletion.operation.steps.kv, 'failed');
    assert.equal(deletion.operation.status, 'retry_pending');
  } finally {
    failPut = false;
  }
  await call('operation.retry', {
    operation_id: deletion.operation.operation_id,
  });
  await cron();
  assert.equal((await request(`/r/${a.resource.id}`)).status, 404);
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('bad hash'), { sha256: '0'.repeat(64) });
  const result = (await (await upload(token, form)).json()) as ResourceResult;
  const deleted = await call('resource.delete', {
    resource_id: result.resource.id,
  });
  assert.equal(deleted.operation.status, 'completed');
  assert.equal(deleted.operation.steps.r2_cleanup, 'completed');
  const original = await call('operation.get', {
    operation_id: form.metadata.operation_id,
  });
  assert.equal(original.operation.steps.upload, 'needs_reupload');
  assert.equal(original.operation.status, 'needs_attention');
  assert.equal(original.resource.state, 'deleted');
});

test('multipart extra fields, missing final delimiter and strict metadata never publish invalid content', async () => {
  const { token } = await call('session.create');
  for (const tail of [
    '\r\nContent-Disposition: form-data; name="file"\r\n\r\nextra\r\n--formal-boundary--\r\n',
    '-',
  ]) {
    for (const data of [Buffer.from('valid'), Buffer.alloc(0)]) {
      const form = multipart(data, {}, tail);
      const response = await upload(token, form);
      assert.equal(response.status, 422);
      assert.equal(
        ((await response.json()) as ResourceResult).resource.state,
        'pending',
      );
    }
  }
  for (const changes of [
    { unknown: 1 },
    { size_bytes: 1.5 },
    { size_bytes: 9007199254740992 },
    { sha256: 'A'.repeat(64) },
    { title: null },
    { tags: ['a', 'a'] },
    { filename: 'bad\r\nfilename' },
    { content_type: 'text/html; charset=utf8' },
  ]) {
    const response = await upload(token, multipart(Buffer.from('x'), changes));
    assert.equal(response.status, 400, await response.clone().text());
  }
  const defaults = await call('storage.get');
  assert.equal(defaults.max_file_bytes, null);
  assert.equal(defaults.total_storage_bytes, null);
  limits = { MAX_FILE_BYTES: 0 };
  try {
    assert.equal(
      (await upload(token, multipart(Buffer.from('x')))).status,
      413,
    );
    assert.equal((await upload(token, multipart(Buffer.alloc(0)))).status, 201);
  } finally {
    limits = {};
  }
});

test('execution nonces stay private and admission limits do not rewrite committed idempotent results', async () => {
  const a = await uploaded(Buffer.from('stable result'));
  const internal = await db
    .prepare('SELECT upload_token FROM operations WHERE id=?')
    .bind(a.form.metadata.operation_id)
    .first<{ upload_token: string }>();
  assert(!JSON.stringify(a).includes(internal!.upload_token));
  assert(!a.resource.file_key!.includes(internal!.upload_token));
  limits = { MAX_FILE_BYTES: 0, TOTAL_STORAGE_BYTES: 0 };
  try {
    const response = await upload(a.token, a.form);
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as ResourceResult).resource.id,
      a.resource.id,
    );
  } finally {
    limits = {};
  }
});

test('request stream interruption keeps a recoverable unpublished operation', {
  timeout: 10000,
}, async () => {
  const { token } = await call('session.create');
  const form: Multipart = multipart(Buffer.alloc(64 * 1024));
  assert(Buffer.isBuffer(form.body));
  const entered = deferred();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const prefix = form.body.subarray(0, form.body.length - 32000);
  form.body = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(prefix);
    },
  });
  onR2Put = (event) => {
    if (event.options.customMetadata.role !== 'fence') entered.resolve();
  };
  const pending = upload(token, form);
  try {
    await entered.promise;
    controller.error(new Error('client connection aborted'));
    try {
      const response = await pending;
      assert.equal(response.status, 422);
    } catch (error) {
      assert.match(
        String(error),
        /client connection aborted|network|stream|fetch failed/i,
      );
    }
    const result = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    assert.equal(result.resource.state, 'pending');
    if (result.resource.accounting !== 'released') {
      await db
        .prepare(
          'UPDATE operations SET lease_until=0,next_retry_at=0 WHERE id=?',
        )
        .bind(form.metadata.operation_id)
        .run();
      await cron();
    }
    const recovered = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    assert.equal(recovered.resource.accounting, 'released');
    assert.equal(recovered.operation.steps.upload, 'needs_reupload');
  } finally {
    onR2Put = undefined;
    await pending.catch(() => {});
  }
});

test('expiration defaults to thirty days from first publication', async () => {
  const result = await create();
  assert.equal(typeof result.resource.published_at, 'number');
  assert.equal(
    result.resource.expires_at! - result.resource.published_at!,
    2592000,
  );
  assert.equal(result.resource.accessible, true);
  assert.equal(result.resource.unavailable_reason, null);
});

test('expiration policies validate, remain idempotent, and edits use absolute deadlines', async () => {
  for (const retention_seconds of [
    0,
    -1,
    1.5,
    '60',
    true,
    9007199254740991,
    9007199254740992,
  ]) {
    await errorCall(
      'resource.create_url',
      {
        operation_id: randomUUID(),
        target_url: 'https://example.com',
        retention_seconds,
      },
      'INVALID_ARGUMENTS',
    );
  }
  const args = {
    operation_id: randomUUID(),
    target_url: 'https://example.com',
    retention_seconds: 120,
  };
  const created = await call('resource.create_url', args);
  const id = created.resource.id;
  assert.equal(
    created.resource.expires_at! - created.resource.published_at!,
    120,
  );
  const deadline = now() + 900;
  const edited = await call('resource.update', {
    resource_id: id,
    expires_at: deadline,
  });
  assert.equal(edited.resource.expires_at, deadline);
  assert.equal(
    (await call('resource.update', { resource_id: id, expires_at: deadline }))
      .resource.expires_at,
    deadline,
  );
  assert.equal(
    (
      await call('resource.update', {
        resource_id: id,
        title: 'unchanged expiry',
      })
    ).resource.expires_at,
    deadline,
  );
  assert.equal(
    (await call('resource.create_url', args)).resource.expires_at,
    deadline,
  );
  await errorCall(
    'resource.create_url',
    { ...args, retention_seconds: 121 },
    'IDEMPOTENCY_CONFLICT',
  );
  for (const expires_at of [
    0,
    now(),
    now() - 1,
    1.5,
    '60',
    false,
    9007199254740992,
  ])
    await errorCall(
      'resource.update',
      { resource_id: id, expires_at },
      'INVALID_ARGUMENTS',
    );
  const madePermanent = await call('resource.update', {
    resource_id: id,
    expires_at: null,
  });
  assert.equal(madePermanent.resource.expires_at, null);
  assert.equal(madePermanent.resource.retention_seconds, 120); // Original creation policy does not change with the current deadline.
  const permanent = await create({ retention_seconds: null });
  assert.equal(permanent.resource.expires_at, null);
  assert.equal(typeof permanent.resource.published_at, 'number');
  const madeFinite = await call('resource.update', {
    resource_id: permanent.resource.id,
    expires_at: deadline,
  });
  assert.equal(madeFinite.resource.expires_at, deadline);
  assert.equal(madeFinite.resource.retention_seconds, null);
  const detail = (
    await client.callTool({
      name: 'describe',
      arguments: { operation: 'operation.get' },
    })
  ).structuredContent as Descriptor;
  const validateResult = new AjvJsonSchemaValidator().getValidator(
    detail.resultSchema,
  );
  for (const item of [madePermanent, madeFinite]) {
    const current = await call('operation.get', {
      operation_id: item.operation.operation_id,
    });
    const checked = validateResult(current);
    assert.equal(checked.valid, true, checked.errorMessage);
    assert.equal(current.resource.expires_at, item.resource.expires_at);
    assert.equal(
      current.resource.retention_seconds,
      item.resource.retention_seconds,
    );
  }

  const defaultArgs = {
    operation_id: randomUUID(),
    target_url: 'https://example.com',
  };
  const standard = await call('resource.create_url', defaultArgs);
  assert.equal(
    (
      await call('resource.create_url', {
        ...defaultArgs,
        retention_seconds: 2592000,
      })
    ).resource.id,
    standard.resource.id,
  );
});

test('expiration publication policies apply to files and images without restart on retry', async () => {
  for (const changes of [
    {},
    { retention_seconds: 75 },
    { retention_seconds: null, content_type: 'image/png' },
  ]) {
    const result = await uploaded(Buffer.from('policy'), changes);
    assert.equal(
      result.resource.expires_at,
      changes.retention_seconds === null
        ? null
        : result.resource.published_at! +
            (changes.retention_seconds ?? 2592000),
    );
    const retry = (await (
      await upload(result.token, result.form)
    ).json()) as ResourceResult;
    assert.equal(retry.resource.published_at, result.resource.published_at);
    assert.equal(retry.resource.expires_at, result.resource.expires_at);
  }
  const { token } = await call('session.create');
  for (const retention_seconds of [0, -1, 1.5, '60', true, 9007199254740991])
    assert.equal(
      (
        await upload(
          token,
          multipart(Buffer.from('invalid'), { retention_seconds }),
        )
      ).status,
      400,
    );
});

test('expiration denies uncached GET HEAD Range and excludes lists before Cron while preserving details', async () => {
  const item = await uploaded(Buffer.from('expiration body'));
  const id = item.resource.id;
  const path = `/r/${id}`;
  const initial = await request(path);
  assert.equal(initial.status, 200);
  assert.equal(
    initial.headers.get('cache-control'),
    'private, max-age=31536000, immutable',
  );
  await initial.arrayBuffer();
  await db
    .prepare('UPDATE resources SET expires_at=unixepoch()-1 WHERE id=?')
    .bind(id)
    .run();
  await kv.delete(id);
  for (const init of [
    {},
    { method: 'HEAD' },
    { headers: { range: 'bytes=0-2' } },
  ])
    assert.equal((await request(path, init)).status, 404);
  const detail = await call('resource.get', { resource_id: id });
  assert.equal(detail.resource.state, 'published');
  assert.equal(detail.resource.accessible, false);
  assert.equal(detail.resource.unavailable_reason, 'expired');
  assert(
    !(await call('resource.list')).items.some((resource) => resource.id === id),
  );
  await errorCall(
    'resource.update',
    { resource_id: id, expires_at: null },
    'RESOURCE_EXPIRED',
  );
  await errorCall(
    'resource.update',
    { resource_id: id, title: 'revive' },
    'RESOURCE_EXPIRED',
  );
  const marker = JSON.parse((await kv.get(id))!);
  assert.equal(marker.state, 'expired');
  onD1Before = () => false;
  try {
    assert.equal((await request(path)).status, 404);
  } finally {
    onD1Before = undefined;
  }
});

test('expiration cache hits avoid D1, old formats refresh, stale expiry verifies renewal, expired snapshots fail closed', async () => {
  const item = await create();
  const id = item.resource.id;
  const path = `/r/${id}`;
  const original = JSON.parse((await kv.get(id))!);
  onD1Before = () => false;
  try {
    assert.equal((await request(path, { redirect: 'manual' })).status, 302);
  } finally {
    onD1Before = undefined;
  }
  assert.deepEqual(JSON.parse((await kv.get(id))!), original);
  const legacy = { ...original };
  delete legacy.expires_at;
  await kv.put(id, JSON.stringify(legacy));
  let reads = 0;
  onD1Before = ({ sql }) => {
    if (sql === 'SELECT * FROM resources WHERE id=?') reads++;
  };
  try {
    assert.equal((await request(path, { redirect: 'manual' })).status, 302);
    assert.equal(reads, 1);
  } finally {
    onD1Before = undefined;
  }
  await kv.put(id, JSON.stringify({ ...original, expires_at: now() - 1 }));
  assert.equal((await request(path, { redirect: 'manual' })).status, 302);
  assert.equal(
    JSON.parse((await kv.get(id))!).expires_at,
    item.resource.expires_at,
  );
  await kv.put(
    id,
    JSON.stringify({
      ...original,
      observed_at: now() - 86400,
      valid_until: now(),
    }),
  );
  onD1Before = () => false;
  try {
    for (const init of [
      {},
      { method: 'HEAD' },
      { headers: { range: 'bytes=0-1' } },
    ])
      assert.equal((await request(path, init)).status, 503);
  } finally {
    onD1Before = undefined;
  }
});

test('expiration crossing a delayed D1 read rechecks a concurrent renewal before writing a denial', async () => {
  const item = await create({ retention_seconds: 100 });
  const id = item.resource.id;
  await kv.delete(id);
  let reads = 0;
  onD1After = async ({ sql }) => {
    if (sql === 'SELECT * FROM resources WHERE id=?' && ++reads === 1) {
      await db
        .prepare('UPDATE resources SET expires_at=? WHERE id=?')
        .bind(now() + 1000, id)
        .run();
      clockOffset = 101000;
    }
  };
  try {
    const response = await request(`/r/${id}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(reads, 2);
    assert.equal(JSON.parse((await kv.get(id))!).state, 'published');
  } finally {
    onD1After = undefined;
    clockOffset = 0;
  }
});

test('expiration edit and Cron eligibility are checked inside their write transaction', async () => {
  const item = await create();
  const id = item.resource.id;
  onD1Batch = async ({ sql }) => {
    if (sql.startsWith('UPDATE resources SET target_url=')) {
      onD1Batch = undefined;
      await db
        .prepare('UPDATE resources SET expires_at=unixepoch()-1 WHERE id=?')
        .bind(id)
        .run();
    }
  };
  try {
    await errorCall(
      'resource.update',
      { resource_id: id, expires_at: null },
      'RESOURCE_EXPIRED',
    );
  } finally {
    onD1Batch = undefined;
  }
  onD1Batch = async ({ sql }) => {
    if (
      sql.startsWith(
        "UPDATE resources SET state='deleted',deleted_reason='expired'",
      )
    ) {
      onD1Batch = undefined;
      await db
        .prepare('UPDATE resources SET expires_at=unixepoch()+1000 WHERE id=?')
        .bind(id)
        .run();
    }
  };
  try {
    await cron();
  } finally {
    onD1Batch = undefined;
  }
  assert.equal(
    (await call('resource.get', { resource_id: id })).resource.state,
    'published',
  );
  assert.equal(
    (await db
      .prepare(
        "SELECT count(*) AS count FROM operations WHERE resource_id=? AND type='resource.delete'",
      )
      .bind(id)
      .first())!.count,
    0,
  );
});

test('expiration Cron isolates a failed candidate and R2 cleanup, then retries without duplicate release', async () => {
  const blocked = await create();
  const item = await uploaded(Buffer.from('cleanup expiry'));
  const id = item.resource.id;
  await db
    .prepare('UPDATE resources SET expires_at=unixepoch()-1 WHERE id IN (?,?)')
    .bind(blocked.resource.id, id)
    .run();
  await db.exec(
    `CREATE TRIGGER reject_one_expiry BEFORE UPDATE OF state ON resources WHEN NEW.id='${blocked.resource.id}' AND NEW.state='deleted' BEGIN SELECT RAISE(ABORT,'fixture'); END`,
  );
  const usage = await call('storage.get');
  onR2Delete = () => false;
  try {
    await cron();
  } finally {
    onR2Delete = undefined;
    await db.exec('DROP TRIGGER reject_one_expiry');
  }
  const detail = await call('resource.get', { resource_id: id });
  assert.equal(detail.resource.state, 'deleted');
  assert.equal(detail.resource.deleted_reason, 'expired');
  assert.equal(detail.resource.accounting, 'cleanup');
  assert.equal(detail.operation.steps.kv, 'accepted');
  assert.equal((await request(`/r/${id}`)).status, 404);
  assert.equal(
    (await call('storage.get')).cleanup_bytes,
    usage.cleanup_bytes + item.resource.size_bytes!,
  );
  await db
    .prepare('UPDATE operations SET next_retry_at=0 WHERE resource_id=?')
    .bind(id)
    .run();
  await cron();
  await cron();
  assert.equal(
    (await call('resource.get', { resource_id: id })).resource.accounting,
    'released',
  );
  assert.equal(
    (await db
      .prepare(
        "SELECT count(*) AS count FROM operations WHERE resource_id=? AND type='resource.delete'",
      )
      .bind(id)
      .first())!.count,
    1,
  );
  assert.equal((await call('storage.get')).cleanup_bytes, usage.cleanup_bytes);
});

test('expiration activation is explicit, fixed, preserves permanent edits and old operation fingerprints', async () => {
  assert.equal(
    await db.prepare('SELECT * FROM expiration_activation').first(),
    null,
  );
  assert.equal(
    (await call('resource.get', { resource_id: 'LegacyUrl001' })).resource
      .expires_at,
    null,
  );
  const legacyArgs = {
    operation_id: 'legacy-expiration-retry',
    target_url: 'https://example.com/legacy-retry',
  };
  const payload = {
    description: '',
    tags: [],
    target_url: legacyArgs.target_url,
    title: '',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  await db
    .prepare(
      "INSERT INTO resources(id,kind,state,target_url,created_at) VALUES('LegacyUrl002','url','published',?,1)",
    )
    .bind(legacyArgs.target_url)
    .run();
  await db
    .prepare(
      "INSERT INTO operations(id,type,resource_id,fingerprint,created_at,updated_at,next_retry_at) VALUES(?,'resource.create_url','LegacyUrl002',?,1,1,0)",
    )
    .bind(legacyArgs.operation_id, fingerprint)
    .run();
  await db.exec(
    "INSERT INTO resources(id,kind,state,target_url,created_at) VALUES('LegacyGone01','url','deleted',NULL,1); INSERT INTO resources(id,kind,state,target_url,created_at) VALUES('LegacyPend01','url','pending','https://example.com/pending',1)",
  );
  await db.exec('INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)');
  const activation = await db
    .prepare('SELECT * FROM expiration_activation')
    .first<{ activated_at: number; migrated_count: number }>();
  assert(activation!.activated_at >= now() - 2);
  const old = (await call('resource.get', { resource_id: 'LegacyUrl002' }))
    .resource;
  assert.equal(old.expires_at, activation!.activated_at + 2592000);
  assert.equal(old.published_at, null);
  assert.equal(
    (await call('resource.create_url', legacyArgs)).resource.id,
    old.id,
  );
  await errorCall(
    'resource.create_url',
    { ...legacyArgs, retention_seconds: null },
    'IDEMPOTENCY_CONFLICT',
  );
  await call('resource.update', { resource_id: old.id, expires_at: null });
  await db.exec('INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)');
  assert.deepEqual(
    await db.prepare('SELECT * FROM expiration_activation').first(),
    activation,
  );
  assert.equal(
    (await call('resource.create_url', legacyArgs)).resource.expires_at,
    null,
  );
  await db.exec(
    "UPDATE resources SET state='published' WHERE id='LegacyPend01'; INSERT INTO resources(id,kind,state,target_url,created_at) VALUES('LegacyLate01','url','published','https://example.com/late',1)",
  );
  for (const id of ['LegacyPend01', 'LegacyLate01'])
    assert.equal(
      (await call('resource.get', { resource_id: id })).resource.expires_at,
      activation!.activated_at + 2592000,
    );
  const deleted = (await call('resource.get', { resource_id: 'LegacyGone01' }))
    .resource;
  assert.equal(deleted.state, 'deleted');
  assert.equal(deleted.expires_at, null);
});

test('expiration delayed snapshots retain absolute platform expiration and skip writes below sixty seconds', async () => {
  const item = await create();
  const id = item.resource.id;
  const original = JSON.parse((await kv.get(id))!);
  assert.equal(
    (await kv.list()).keys.find((key) => key.name === id)!.expiration,
    original.valid_until,
  );
  await kv.delete(id);
  let writes = 0;
  onPut = () => {
    writes++;
  };
  onD1After = ({ sql }) => {
    if (sql === 'SELECT * FROM resources WHERE id=?') clockOffset = 86350000;
  };
  try {
    assert.equal(
      (await request(`/r/${id}`, { redirect: 'manual' })).status,
      302,
    );
    assert.equal(writes, 0);
    assert.equal(await kv.get(id), null);
  } finally {
    onPut = undefined;
    onD1After = undefined;
    clockOffset = 0;
  }
});

test('expiration legacy pending upload never publishes after deadline and retains its active writer reservation', {
  timeout: 10000,
}, async () => {
  const release = deferred(),
    entered = deferred();
  onR2Put = async (event) => {
    if (event.options.customMetadata.role !== 'fence') {
      entered.resolve();
      await release.promise;
    }
  };
  const { token } = await call('session.create');
  const form = multipart(Buffer.from('expire during upload'));
  const uploading = upload(token, form);
  try {
    await entered.promise;
    const pending = await call('operation.get', {
      operation_id: form.metadata.operation_id,
    });
    const id = pending.resource.id;
    assert.equal(pending.resource.published_at, null);
    assert.equal(pending.resource.expires_at, null);
    await db
      .prepare(
        'UPDATE resources SET expiration_policy_version=0,expires_at=unixepoch()-1 WHERE id=?',
      )
      .bind(id)
      .run();
    await cron();
    const expired = await call('resource.get', { resource_id: id });
    assert.equal(expired.resource.state, 'deleted');
    assert.equal(expired.resource.deleted_reason, 'expired');
    assert.equal(expired.resource.accounting, 'reserved');
    assert.equal(expired.operation.last_error!.code, 'UPLOAD_ACTIVE');
    assert.equal((await request(`/r/${id}`)).status, 404);
    release.resolve();
    const response = await uploading;
    const completed = (await response.json()) as ResourceResult;
    assert.equal(completed.resource.state, 'deleted');
    assert.equal(completed.resource.published_at, null);
    assert.equal(completed.resource.accounting, 'released');
    assert.equal((await upload(token, form)).status, 200);
    assert.equal(
      (
        await call('operation.get', {
          operation_id: form.metadata.operation_id,
        })
      ).resource.state,
      'deleted',
    );
  } finally {
    release.resolve();
    await uploading;
    onR2Put = undefined;
  }
});

test('expiration retries keep a once-valid near-limit duration even when a later new creation would overflow', async () => {
  const args = {
    operation_id: randomUUID(),
    target_url: 'https://example.com',
    retention_seconds: Number.MAX_SAFE_INTEGER - now() - 10,
  };
  const created = await call('resource.create_url', args);
  clockOffset = 20000;
  try {
    const retry = await call('resource.create_url', args);
    assert.equal(retry.resource.id, created.resource.id);
    assert.equal(retry.resource.expires_at, created.resource.expires_at);
  } finally {
    clockOffset = 0;
  }
});

test('expiration old upload fingerprints survive migration edits and cannot override retained expiry', async () => {
  const item = await uploaded(Buffer.from('legacy upload retry'));
  const id = item.resource.id;
  const canonical: Record<string, unknown> = {
    ...item.form.metadata,
    title: '',
    description: '',
    tags: [],
  };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(canonical)
            .sort()
            .map((key) => [key, canonical[key]]),
        ),
      ),
    )
    .digest('hex');
  await db
    .prepare(
      'UPDATE operations SET fingerprint_version=0,fingerprint=? WHERE id=?',
    )
    .bind(fingerprint, item.form.metadata.operation_id)
    .run();
  await db
    .prepare(
      'UPDATE resources SET expiration_policy_version=0,published_at=NULL,expires_at=? WHERE id=?',
    )
    .bind(now() + 1000, id)
    .run();
  await call('resource.update', { resource_id: id, expires_at: null });
  const response = await upload(item.token, item.form);
  assert.equal(response.status, 200);
  const result = (await response.json()) as ResourceResult;
  assert.equal(result.resource.id, id);
  assert.equal(result.resource.expires_at, null);
  assert.equal(result.resource.published_at, null);
  assert.equal(
    (
      await upload(
        item.token,
        multipart(Buffer.from('legacy upload retry'), {
          ...item.form.metadata,
          retention_seconds: null,
        }),
      )
    ).status,
    409,
  );
});

test('expiration edit racing manual deletion reports the winning permanent deletion', async () => {
  const item = await create();
  const id = item.resource.id;
  onD1Batch = async ({ sql }) => {
    if (sql.startsWith('UPDATE resources SET target_url=')) {
      onD1Batch = undefined;
      await db
        .prepare(
          "UPDATE resources SET state='deleted',deleted_reason='manual',deleted_at=unixepoch() WHERE id=?",
        )
        .bind(id)
        .run();
    }
  };
  try {
    await errorCall(
      'resource.update',
      { resource_id: id, expires_at: null },
      'RESOURCE_DELETED',
    );
  } finally {
    onD1Batch = undefined;
  }
});
