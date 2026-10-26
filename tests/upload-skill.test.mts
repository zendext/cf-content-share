import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

type JsonObject = { [key: string]: unknown };
const script = path.resolve('skills/cf-content-share/scripts/upload.py');
const sha = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const saveJson = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value), { mode: 0o600 });
// An explicit executable selector wins; otherwise discover a supported interpreter in PATH.
function pythonRuntime() {
  const selector = process.env.CF_CONTENT_SHARE_PYTHON;
  const candidates = selector
    ? [[selector]]
    : [
        ['python3'],
        ['python'],
        ...(process.platform === 'win32' ? [['py', '-3']] : []),
      ];
  for (const [executable, ...prefix] of candidates) {
    const result = spawnSync(
      executable,
      [
        ...prefix,
        '-c',
        'import sys, ssl, hashlib, http.client; sys.exit(0 if sys.version_info >= (3, 12) else 1)',
      ],
      { timeout: 3000 },
    );
    if (!result.error && result.status === 0) return { executable, prefix };
  }
  throw new Error(
    'Python 3.12+ is required. Set CF_CONTENT_SHARE_PYTHON to a supported interpreter executable.',
  );
}
const python = pythonRuntime();
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        python.executable,
        [...python.prefix, script, ...args],
        { cwd: path.dirname(script) },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (value) => (stdout += value));
      child.stderr.on('data', (value) => (stderr += value));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'share-skill-中文 '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '图片 文件.svg');
  return {
    file,
    stateFile: path.join(dir, 'upload.json'),
    authorizationFile: path.join(dir, 'authorization.json'),
    metadataFile: path.join(dir, 'metadata.json'),
    contractFile: path.join(dir, 'contract.json'),
    origin: 'https://share.example.test',
    metadata: {
      filename: '图片.svg',
      content_type: 'image/svg+xml',
      title: '分享图片',
      tags: ['资料'],
    },
  };
}
async function prepareUpload(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await cli([
    'prepare',
    '--file',
    f.file,
    '--origin',
    f.origin,
    '--metadata-file',
    f.metadataFile,
    '--contract-file',
    f.contractFile,
    '--state-file',
    f.stateFile,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    operation_id: string;
    sha256: string;
    size_bytes: number;
  };
}
async function sendUpload(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await cli([
    'send',
    '--state-file',
    f.stateFile,
    '--authorization-file',
    f.authorizationFile,
  ]);
  assert.equal(result.stderr, '', result.stderr);
  return { exitCode: result.code, result: JSON.parse(result.stdout) };
}

test('Python subprocess streams 16MiB over real HTTP to Rust/Wasm; MCP confirms policy, replay and JWT rejection', async (t) => {
  const f = await fixture(t),
    issuer = 'https://skill-test.cloudflareaccess.com';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'skill-key',
    alg: 'RS256',
    use: 'sig',
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, aud: ['skill-aud'], sub: 'fixture-user', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const jwt = `${claims}.${sign('RSA-SHA256', Buffer.from(claims), privateKey).toString('base64url')}`;
  const options: Parameters<typeof convertV4MiniflareOptions>[0] = {
    workers: [
      {
        name: 'upload-skill',
        modulesRoot: '.',
        modules: [
          {
            type: 'ESModule',
            path: 'tests/oauth-edge-fixture.mts',
            contents: `import Worker from '../build/index.js';
              export default class extends Worker {
                fetch(request) {
                  if (new URL(request.url).pathname !== '/mcp/upload') return super.fetch(request);
                  const headers = new Headers(request.headers);
                  headers.delete('Cf-Access-Jwt-Assertion');
                  const token = headers.get('Cf-Access-Token');
                  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
                  return super.fetch(new Request(request, {headers}));
                }
              }`,
          },
          { type: 'ESModule', path: 'build/index.js' },
          { type: 'CompiledWasm', path: 'build/index_bg.wasm' },
        ],
        compatibilityDate: '2026-10-11',
        bindings: {
          PUBLIC_ORIGIN: f.origin,
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: 'skill-aud',
        },
        d1Databases: ['DB'],
        kvNamespaces: ['MAPPINGS'],
        r2Buckets: ['FILES'],
        outboundService: async () => Response.json({ keys: [jwk] }),
      },
    ],
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(() => mf.dispose());
  const listener = await mf.ready;
  f.origin = listener.origin;
  options.port = Number(listener.port);
  assert(options.workers);
  options.workers[0].bindings = {
    ...options.workers[0].bindings,
    PUBLIC_ORIGIN: f.origin,
  };
  await mf.setOptions(convertV4MiniflareOptions(options));
  assert.equal((await mf.ready).origin, f.origin);
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations'))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    await db.exec(
      (await readFile(`migrations/${name}`, 'utf8'))
        .replace(/^--.*$/gm, '')
        .replaceAll('\n', ' '),
    );
  await db
    .prepare('INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)')
    .run();
  async function tool(name: string, args: JsonObject) {
    const response = await mf.dispatchFetch(`${f.origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'cf-access-jwt-assertion': jwt,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const data = (await response.json()) as {
      result: {
        isError: boolean;
        structuredContent: Record<string, JsonObject>;
      };
    };
    assert.equal(data.result.isError, false, JSON.stringify(data));
    return data.result.structuredContent;
  }
  const detail = await tool('describe', { operation: 'upload.authorization' });
  await saveJson(f.contractFile, detail.upload);
  const authorization = await tool('invoke', {
    operation: 'upload.authorization',
    arguments: {},
  });
  await saveJson(f.authorizationFile, authorization);
  for (const [index, retention] of [undefined, 3600, null].entries()) {
    const current = { ...f, stateFile: f.stateFile + index };
    const bytes =
      index === 0 ? Buffer.alloc(16 * 1024 * 1024, 0x5a) : Buffer.alloc(0);
    await writeFile(f.file, bytes);
    const metadata = {
      ...f.metadata,
      ...(retention === undefined ? {} : { retention_seconds: retention }),
    };
    await saveJson(f.metadataFile, metadata);
    if (index === 1)
      await writeFile(
        f.metadataFile,
        JSON.stringify(metadata).replace(
          '"retention_seconds":3600',
          '"retention_seconds":3600.0',
        ),
      );
    const prepared = await prepareUpload(current);
    assert.equal(prepared.sha256, sha(bytes));
    const result = await sendUpload(current);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(result.result, {
      operation_id: prepared.operation_id,
      transport_status: 'response_received',
      http_status: 201,
    });
    const recovered = await tool('invoke', {
      operation: 'operation.get',
      arguments: { operation_id: prepared.operation_id },
    });
    const resource = recovered.resource;
    assert.equal(resource.state, 'published');
    assert.equal(resource.accessible, true);
    assert.equal(
      resource.expires_at,
      retention === null
        ? null
        : Number(resource.published_at) + (retention ?? 2592000),
    );
    const stored = await db
      .prepare(
        'SELECT retention_seconds,published_at,expires_at FROM resources WHERE id=?',
      )
      .bind(resource.id)
      .first();
    assert.deepEqual(stored, {
      retention_seconds: retention === null ? null : (retention ?? 2592000),
      published_at: resource.published_at,
      expires_at: resource.expires_at,
    });
    const read = await mf.dispatchFetch(`${f.origin}/r/${resource.id}`);
    assert.equal(read.status, 200);
    assert.equal(sha(new Uint8Array(await read.arrayBuffer())), sha(bytes));
    const before = await readFile(current.stateFile, 'utf8');
    const repeat = await sendUpload(current);
    assert.equal(repeat.exitCode, 0, JSON.stringify(repeat));
    assert.equal(await readFile(current.stateFile, 'utf8'), before);
    assert.deepEqual(
      (
        await tool('invoke', {
          operation: 'operation.get',
          arguments: { operation_id: prepared.operation_id },
        })
      ).resource,
      resource,
    );
    if (index === 1) {
      const legacyStateFile = `${current.stateFile}-legacy`;
      const saved = JSON.parse(before);
      await writeFile(
        legacyStateFile,
        JSON.stringify({
          version: 1,
          origin: saved.origin,
          file: saved.file,
          metadata: saved.metadata,
        }).replace('"retention_seconds":3600', '"retention_seconds":3600.0'),
        { mode: 0o600 },
      );
      const legacyBefore = await readFile(legacyStateFile, 'utf8');
      const legacy = await sendUpload({
        ...current,
        stateFile: legacyStateFile,
      });
      assert.equal(legacy.exitCode, 0, JSON.stringify(legacy));
      assert.equal(legacy.result.operation_id, prepared.operation_id);
      assert.equal(await readFile(legacyStateFile, 'utf8'), legacyBefore);
    }
  }
  assert.equal(authorization.token, jwt);
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS n FROM resources')
        .first<{ n: number }>()
    )?.n,
    3,
  );
  const parts = jwt.split('.');
  parts[2] = 'invalidsignature';
  await saveJson(f.authorizationFile, {
    ...authorization,
    token: parts.join('.'),
  });
  await writeFile(f.file, Buffer.alloc(0));
  const rejected = await sendUpload({ ...f, stateFile: `${f.stateFile}2` });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.result.http_status, 401);
});
