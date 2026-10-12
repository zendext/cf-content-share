import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type CloudFetch,
  type InitializeOptions,
  initialize,
} from '../scripts/init-cloud.mts';

const account = 'a'.repeat(32);
const dbId = '00000000-0000-0000-0000-000000000001';
const kvId = 'b'.repeat(32);
const token = 'test-secret-never-print';
const config = {
  account_id: account,
  worker_name: 'share-test',
  resource_prefix: 'share-test',
  public_origin: 'https://s.example.com',
  zone_name: 'example.com',
  access_issuer: 'https://example.cloudflareaccess.com',
  access_aud: 'c'.repeat(64),
};

type CloudItem = {
  name?: string;
  uuid?: string;
  title?: string;
  id?: string;
  storage_class?: string;
};
function cloud() {
  const data: Record<'d1' | 'kv' | 'r2', CloudItem[]> = {
    d1: [],
    kv: [],
    r2: [],
  };
  const requests: {
    route: string;
    method: string | undefined;
    body: unknown;
    query: Record<string, string>;
  }[] = [];
  let failCreate: 'd1' | 'kv' | 'r2' | undefined;
  const fetch: CloudFetch = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    const u = new URL(url);
    const route = u.pathname.split(`/accounts/${account}/`)[1];
    const method = options.method;
    requests.push({
      route,
      method,
      body: options.body ? JSON.parse(options.body!) : undefined,
      query: Object.fromEntries(u.searchParams),
    });
    const kind = route.startsWith('d1/')
      ? 'd1'
      : route.startsWith('storage/')
        ? 'kv'
        : 'r2';
    if (method === 'GET' && /^r2\/buckets\/[^/]+$/.test(route))
      return Response.json({
        success: true,
        result: data.r2.find((item) => item.name === route.split('/')[2]),
      });
    if (route.endsWith('/domains/managed'))
      return Response.json({ success: true, result: { enabled: false } });
    if (route.endsWith('/domains/custom'))
      return Response.json({ success: true, result: { domains: [] } });
    if (method === 'POST') {
      const body = JSON.parse(options.body!);
      const item =
        kind === 'd1'
          ? { name: body.name, uuid: dbId }
          : kind === 'kv'
            ? { title: body.title, id: kvId }
            : { name: body.name, storage_class: body.storage_class };
      data[kind].push(item);
      if (failCreate === kind) {
        failCreate = undefined;
        throw new Error(`network ${token} other-body-password`);
      }
      return Response.json({ success: true, result: item });
    }
    assert.equal(method, 'GET');
    return Response.json({
      success: true,
      result: kind === 'r2' ? { buckets: data[kind] } : data[kind],
      result_info: { total_count: data[kind].length },
    });
  };
  return {
    data,
    requests,
    fetch,
    fail: (kind: 'd1' | 'kv' | 'r2') => {
      failCreate = kind;
    },
  };
}

async function fixture(
  t: TestContext,
  overrides: Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'share-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'deployment.local.json');
  const output = path.join(root, 'wrangler.cloud.json');
  await writeFile(input, JSON.stringify({ ...config, ...overrides }));
  const api = cloud();
  return {
    root,
    input,
    output,
    api,
    run: (options: Partial<InitializeOptions> = {}) =>
      initialize({
        configFile: input,
        outputFile: output,
        projectRoot: root,
        token,
        fetch: api.fetch,
        ...options,
      }),
  };
}

test('plan lists resources but creates no resource or local file', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(
    result.resources.map((item) => item.action),
    ['create', 'create', 'create'],
  );
  assert.ok(f.api.requests.every((request) => request.method === 'GET'));
  assert.deepEqual(await readdir(f.root), ['deployment.local.json']);
});

test('apply creates only missing resources, writes private config and reuses all IDs on rerun', async (t) => {
  const f = await fixture(t, {
    max_file_bytes: '1000000',
    total_storage_bytes: '9000000',
  });
  f.api.data.d1.push({
    name: 'other-db',
    uuid: '11111111-1111-1111-1111-111111111111',
  });
  f.api.data.r2.push({ name: 'unrelated-public' });
  await f.run({ apply: true });
  const first = await readFile(f.output, 'utf8');
  const settings = JSON.parse(first);
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  assert.equal(settings.d1_databases[0].database_id, dbId);
  assert.equal(settings.kv_namespaces[0].id, kvId);
  assert.deepEqual(settings.routes, [
    { pattern: 's.example.com/*', zone_name: 'example.com' },
  ]);
  assert.equal(settings.workers_dev, false);
  assert.equal(settings.preview_urls, false);
  assert.equal(settings.main, 'build/index.js');
  assert.equal(settings.build.cwd, undefined);
  assert.equal(settings.vars.DEFAULT_TIMEZONE, 'Asia/Shanghai');
  assert.equal(settings.vars.MAX_FILE_BYTES, '1000000');
  assert.equal(settings.vars.TOTAL_STORAGE_BYTES, '9000000');
  assert.equal(settings.vars.ANALYTICS_DATASET, 'share_test');
  assert.equal(settings.analytics_engine_datasets[0].binding, 'ANALYTICS');
  assert.equal(settings.r2_buckets[0].binding, 'FILES');
  assert.deepEqual(settings.triggers.crons, ['*/5 * * * *']);
  assert.ok(!first.includes(token));
  assert.ok(!first.includes('ANALYTICS_API_TOKEN'));
  const second = await f.run({ apply: true });
  assert.deepEqual(
    second.resources.map((item) => item.action),
    ['reuse', 'reuse', 'reuse'],
  );
  assert.equal(await readFile(f.output, 'utf8'), first);
  assert.equal(
    f.api.requests.filter((item) => item.method === 'POST').length,
    3,
  );
  assert.ok(
    f.api.requests.every((item) => ['GET', 'POST'].includes(item.method!)),
  );
  assert.ok(
    !f.api.requests.some((item) => item.route.includes('unrelated-public/')),
  );
  assert.equal(f.api.data.d1.length, 2);
});

test('output in a subdirectory uses paths relative to the config, with no imposed capacity limit', async (t) => {
  const f = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(f.root, 'deploy'));
  const outputFile = path.join(f.root, 'deploy', 'cloud.json');
  await f.run({ apply: true, outputFile });
  const settings = JSON.parse(await readFile(outputFile, 'utf8'));
  assert.equal(settings.main, '../build/index.js');
  assert.equal(settings.build.cwd, undefined);
  assert.equal(settings.d1_databases[0].migrations_dir, '../migrations');
  assert.equal(settings.vars.MAX_FILE_BYTES, undefined);
  assert.equal(settings.vars.TOTAL_STORAGE_BYTES, undefined);
});

test('all pages are searched and exact names win over prefix matches', async (t) => {
  const f = await fixture(t);
  const seen: URL[] = [];
  const fetch: CloudFetch = async (url, options) => {
    assert.equal(options.method, 'GET');
    const u = new URL(url);
    seen.push(u);
    if (u.pathname.endsWith('/r2/buckets/share-test'))
      return Response.json({
        success: true,
        result: { name: 'share-test', storage_class: 'Standard' },
      });
    if (u.pathname.endsWith('/managed'))
      return Response.json({ success: true, result: { enabled: false } });
    if (u.pathname.endsWith('/custom'))
      return Response.json({ success: true, result: { domains: [] } });
    if (u.pathname.endsWith('/r2/buckets'))
      return Response.json({
        success: true,
        result: {
          buckets: [
            {
              name: u.searchParams.has('cursor')
                ? 'share-test'
                : 'share-test-extra',
            },
          ],
        },
        result_info: u.searchParams.has('cursor')
          ? {}
          : { cursor: 'next-page' },
      });
    const kv = u.pathname.includes('/storage/');
    return Response.json({
      success: true,
      result: [
        {
          [kv ? 'title' : 'name']:
            u.searchParams.get('page') === '1'
              ? 'share-test-extra'
              : kv
                ? 'share-test-mappings'
                : 'share-test',
          [kv ? 'id' : 'uuid']: kv ? kvId : dbId,
        },
      ],
      result_info: { per_page: 1, total_count: 2 },
    });
  };
  const result = await f.run({ fetch });
  assert.deepEqual(
    result.resources.map((item) => item.action),
    ['reuse', 'reuse', 'reuse'],
  );
  assert.equal(
    seen.filter((u) => u.searchParams.get('page') === '2').length,
    2,
  );
  assert.equal(
    seen.filter((u) => u.searchParams.get('cursor') === 'next-page').length,
    1,
  );
});

test('duplicate exact names fail before any create', async (t) => {
  const f = await fixture(t);
  f.api.data.d1.push(
    { name: 'share-test', uuid: dbId },
    { name: 'share-test', uuid: dbId },
  );
  await assert.rejects(f.run({ apply: true }), /多个同名资源/);
  assert.ok(f.api.requests.every((item) => item.method === 'GET'));
  assert.deepEqual(await readdir(f.root), ['deployment.local.json']);
});

test('unknown create outcome stops, redacts errors and reuses partial creation on next run', async (t) => {
  const f = await fixture(t);
  f.api.fail('kv');
  await assert.rejects(f.run({ apply: true }), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /创建结果未知/);
    assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes('other-body-password'));
    return true;
  });
  assert.equal(f.api.data.d1.length, 1);
  assert.equal(f.api.data.kv.length, 1);
  assert.equal(f.api.data.r2.length, 0);
  assert.deepEqual(await readdir(f.root), ['deployment.local.json']);
  const retry = await f.run({ apply: true });
  assert.deepEqual(
    retry.resources.map((item) => item.action),
    ['reuse', 'reuse', 'create'],
  );
  assert.equal(
    f.api.requests.filter((item) => item.method === 'POST').length,
    3,
  );
});

test('API errors expose only status and numeric codes, never server messages or credentials', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      fetch: async () =>
        Response.json(
          {
            success: false,
            errors: [
              { code: 10000, message: `${token} password=unrelated-secret` },
            ],
          },
          { status: 403 },
        ),
    }),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /HTTP 403，错误码 10000/);
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes('unrelated-secret'));
      return true;
    },
  );
});

test('existing resource IDs cannot be replaced, even if the resource disappeared', async (t) => {
  const f = await fixture(t);
  await f.run({ apply: true });
  const before = await readFile(f.output, 'utf8');
  const count = f.api.requests.filter((item) => item.method === 'POST').length;
  f.api.data.d1.length = 0;
  await assert.rejects(f.run({ apply: true }), /拒绝覆盖或重建/);
  assert.equal(await readFile(f.output, 'utf8'), before);
  assert.equal(
    f.api.requests.filter((item) => item.method === 'POST').length,
    count,
  );
});

test('private R2 check refuses public buckets before creating other resources', async (t) => {
  const f = await fixture(t);
  f.api.data.r2.push({ name: 'share-test', storage_class: 'Standard' });
  for (const exposed of ['managed', 'custom']) {
    await assert.rejects(
      f.run({
        apply: true,
        fetch: async (url, options) => {
          if (url.endsWith(`/domains/${exposed}`))
            return Response.json({
              success: true,
              result:
                exposed === 'managed'
                  ? { enabled: true }
                  : { domains: [{ enabled: true }] },
            });
          return f.api.fetch(url, options);
        },
      }),
      /目标 R2 桶未确认私有/,
    );
  }
  assert.ok(f.api.requests.every((item) => item.method === 'GET'));
});

test('invalid input identifiers and secret-bearing fields fail without API calls', async (t) => {
  const invalid = [
    { account_id: 'bad' },
    { worker_name: '../bad' },
    { resource_prefix: 'BAD' },
    { public_origin: 'https://s.example.com/mcp' },
    { zone_name: 'unrelated.com' },
    { access_issuer: 'https://evil.example.com' },
    { access_aud: 'bad' },
    { analytics_dataset: 'DROP TABLE x;' },
    { max_file_bytes: 1 },
    { total_storage_bytes: '9007199254740992' },
    { default_timezone: '+08:00' },
    { api_token: token },
  ];
  for (const patch of invalid) {
    const f = await fixture(t, patch);
    await assert.rejects(f.run({ apply: true }));
    assert.equal(f.api.requests.length, 0);
  }
});

test('token file requires 0600 and is never treated as config', async (t) => {
  const { readToken } = await import('../scripts/init-cloud.mts');
  const f = await fixture(t);
  const file = path.join(f.root, 'secret');
  await writeFile(file, token, { mode: 0o600 });
  assert.equal(await readToken(file, {}), token);
  await chmod(file, 0o644);
  await assert.rejects(readToken(file, {}), /0600/);
  await assert.rejects(readToken(undefined, {}), /CLOUDFLARE_API_TOKEN/);
});

test('zero is an explicit capacity cap and unknown nested settings are never overwritten', async (t) => {
  const f = await fixture(t, { max_file_bytes: '0', total_storage_bytes: '0' });
  await f.run({ apply: true });
  const settings = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(settings.vars.MAX_FILE_BYTES, '0');
  assert.equal(settings.vars.TOTAL_STORAGE_BYTES, '0');
  settings.vars.USER_OWNED = 'preserve me';
  const saved = JSON.stringify(settings);
  await writeFile(f.output, saved);
  await assert.rejects(f.run({ apply: true }), /未知嵌套配置/);
  assert.equal(await readFile(f.output, 'utf8'), saved);
});

test('malformed list responses and repeated cursors fail closed without creating resources', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      apply: true,
      fetch: async () => Response.json({ success: true, result: null }),
    }),
    /响应格式/,
  );
  await assert.rejects(
    f.run({
      apply: true,
      fetch: async (url, options) => {
        if (url.includes('/r2/buckets?'))
          return Response.json({
            success: true,
            result: { buckets: [] },
            result_info: { cursor: 'loop' },
          });
        return f.api.fetch(url, options);
      },
    }),
    /分页游标重复/,
  );
  assert.ok(f.api.requests.every((item) => item.method === 'GET'));
});

test('CLI rejects token command arguments without echoing them', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['scripts/init-cloud.mts', `--token=${token}`],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', env: {} },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /参数无效/);
  assert.ok(!result.stderr.includes(token));
  assert.equal(result.stdout, '');
});

test('output locks and symlinks cannot overwrite user files', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const f = await fixture(t);
  await writeFile(`${f.output}.lock`, 'owned by another process');
  await assert.rejects(f.run({ apply: true }), /无法锁定/);
  assert.equal(
    await readFile(`${f.output}.lock`, 'utf8'),
    'owned by another process',
  );
  await rm(`${f.output}.lock`);
  await symlink(f.input, f.output);
  const before = await readFile(f.input, 'utf8');
  await assert.rejects(f.run({ apply: true }), /无法安全读取/);
  assert.equal(await readFile(f.input, 'utf8'), before);
  assert.equal(f.api.requests.length, 0);
});

test('new R2 buckets explicitly use Standard storage', async (t) => {
  const f = await fixture(t);
  await f.run({ apply: true });
  assert.deepEqual(
    f.api.requests.find(
      (item) => item.route === 'r2/buckets' && item.method === 'POST',
    )!.body,
    { name: 'share-test', storage_class: 'Standard' },
  );
  assert.ok(
    f.api.requests.some(
      (item) => item.route === 'r2/buckets/share-test' && item.method === 'GET',
    ),
  );
});

test('existing InfrequentAccess and unknown R2 storage classes fail before any creation', async (t) => {
  for (const storage_class of ['InfrequentAccess', undefined]) {
    const f = await fixture(t);
    f.api.data.r2.push({ name: 'share-test', storage_class });
    await assert.rejects(f.run({ apply: true }), /Standard/);
    assert.ok(f.api.requests.every((item) => item.method === 'GET'));
    assert.deepEqual(await readdir(f.root), ['deployment.local.json']);
  }
});
