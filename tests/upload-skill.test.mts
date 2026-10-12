import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, chmod, symlink, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { spawn } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { prepareUpload, sendUpload, type JsonObject, type UploadFetch } from '../skills/cf-content-share/scripts/upload.mts';

const script = path.resolve('skills/cf-content-share/scripts/upload.mts');
const token = 'a'.repeat(43);
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const saveJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
async function fixture(t: TestContext, origin = 'https://share.example.test') {
  const dir = await mkdtemp(path.join(tmpdir(), 'share-skill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '图片.svg'), stateFile = path.join(dir, 'upload.json'), sessionFile = path.join(dir, 'session.json');
  const metadataFile = path.join(dir, 'metadata.json'), contractFile = path.join(dir, 'contract.json');
  const bytes = Buffer.from('<svg>原始字节</svg>');
  const metadata: JsonObject = { filename: '图片.svg', content_type: 'image/svg+xml', title: '分享图片', tags: ['资料'] };
  const contract: JsonObject = { protocol_version: 1, url: origin + '/upload', method: 'POST', authorization: 'Bearer <token>', generated_fields: ['operation_id', 'size_bytes', 'sha256'], max_metadata_bytes: 16384, metadata_schema: { type: 'object' } };
  const session = { session_id: 'session', token, expires_at: Math.floor(Date.now() / 1000) + 3600, upload: { url: origin + '/upload', method: 'POST', protocol_version: 1 } };
  await writeFile(file, bytes);
  await saveJson(metadataFile, metadata); await saveJson(contractFile, contract); await saveJson(sessionFile, session);
  return { file, stateFile, sessionFile, metadataFile, contractFile, origin, bytes, metadata, contract, session };
}
function cli(args: string[], entry = script) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: path.dirname(entry) });
    let stdout = '', stderr = '';
    child.stdout.on('data', v => stdout += v); child.stderr.on('data', v => stderr += v);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
const prepareArgs = (f: Awaited<ReturnType<typeof fixture>>) => ['prepare', '--file', f.file, '--origin', f.origin, '--metadata-file', f.metadataFile, '--contract-file', f.contractFile, '--state-file', f.stateFile];

test('prepare persists a private immutable operation with real digest and dynamic metadata', async t => {
  const f = await fixture(t);
  const result = await prepareUpload(f);
  const before = await readFile(f.stateFile, 'utf8'), saved = JSON.parse(before);
  assert.equal(saved.version, 2); assert.equal(saved.origin, f.origin); assert.equal(saved.file, path.resolve(f.file));
  assert.equal(saved.protocol.protocol_version, 1); assert.match(saved.metadata.operation_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(saved.metadata, { ...f.metadata, operation_id: result.operation_id, size_bytes: f.bytes.length, sha256: sha(f.bytes) });
  if (process.platform !== 'win32') assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600);
  await assert.rejects(prepareUpload(f), { code: 'STATE_EXISTS' }); assert.equal(await readFile(f.stateFile, 'utf8'), before);
});

test('generic metadata preserves omitted/null/nested/numeric fields without business defaults or validation', async t => {
  const f = await fixture(t);
  for (const [index, metadata] of [{ future: { values: [null, 3.5, false], nested: { title: 'future' } } }, { retention_seconds: null }, { retention_seconds: -1, content_type: 'server-decides', filename: '' }].entries()) {
    await saveJson(f.metadataFile, metadata);
    const current = { ...f, stateFile: f.stateFile + index }; await prepareUpload(current);
    const saved = JSON.parse(await readFile(current.stateFile, 'utf8'));
    const { operation_id, size_bytes, sha256, ...actual } = saved.metadata;
    assert.deepEqual(actual, metadata);
    let sentMetadata;
    const result = await sendUpload(current, async (_url, init) => {
      const chunks: Uint8Array[] = []; for await (const chunk of init.body) chunks.push(chunk);
      sentMetadata = JSON.parse(Buffer.concat(chunks).toString().split('\r\n\r\n')[1].split('\r\n--')[0]);
      return Response.json({ resource: { state: 'future_state', expires_at: { format: 'changed' } } }, { status: 202 });
    });
    assert.deepEqual(sentMetadata, saved.metadata);
    assert.deepEqual(result, { exitCode: 0, result: { operation_id, transport_status: 'response_received', http_status: 202 } });
  }
});

test('prepare rejects protected generated values and malformed, oversized or unsafe JSON', async t => {
  const f = await fixture(t);
  for (const metadata of [{ operation_id: 'chosen' }, { size_bytes: 1 }, { sha256: null }, [], null, { data: 'x'.repeat(16384) }]) {
    await saveJson(f.metadataFile, metadata); await assert.rejects(prepareUpload(f), { code: 'INVALID_METADATA' });
  }
  for (const raw of ['{', '{"number":1e999}', '{"number":9007199254740993}', '{"nested":' + '['.repeat(65) + 'null' + ']'.repeat(65) + '}']) {
    await writeFile(f.metadataFile, raw); await assert.rejects(prepareUpload(f), { code: 'INVALID_PRIVATE_JSON' });
  }
});

test('fixed transport contract checks reject unsafe protocol/method/origin/generated fields/limits', async t => {
  const f = await fixture(t);
  for (const changes of [{ protocol_version: 2 }, { method: 'GET' }, { url: 'https://foreign.test/upload' }, { authorization: 'Bearer secret' }, { generated_fields: ['operation_id', 'size_bytes'] }, { max_metadata_bytes: 128 * 1024 + 1 }, { max_metadata_bytes: 0 }, { max_metadata_bytes: 3.5 }]) {
    await saveJson(f.contractFile, { ...f.contract, ...changes }); await assert.rejects(prepareUpload(f), { code: 'INVALID_CONTRACT' });
  }
  await saveJson(f.contractFile, { ...f.contract, metadata_schema: { properties: { future: { type: 'unknown future dialect' } } } });
  await prepareUpload(f);
});

test('dynamic metadata limits and compact nested state round-trip within local safety bounds', async t => {
  const f = await fixture(t);
  let nested: JsonObject = { value: 'x'.repeat(17000) };
  for (let depth = 0; depth < 50; depth++) nested = { nested };
  await saveJson(f.metadataFile, nested);
  await saveJson(f.contractFile, { ...f.contract, max_metadata_bytes: 32768 });
  await prepareUpload(f);
  const saved = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.equal(saved.protocol.max_metadata_bytes, 32768);
  assert.deepEqual(saved.metadata.nested, nested.nested);
  assert.ok((await stat(f.stateFile)).size < 32768);
  assert.equal((await sendUpload(f, async () => new Response(''))).exitCode, 0);
});

test('prepare reserves JSON depth for its state envelope and generated state always reads back', async t => {
  const f = await fixture(t);
  let nested: JsonObject = { value: null };
  for (let depth = 0; depth < 62; depth++) nested = { nested };
  await saveJson(f.metadataFile, nested); await prepareUpload(f);
  assert.equal((await sendUpload(f, async () => new Response(''))).exitCode, 0);
  await saveJson(f.metadataFile, { nested });
  await assert.rejects(prepareUpload({ ...f, stateFile: f.stateFile + '.too-deep' }), { code: 'INVALID_METADATA' });
  await assert.rejects(stat(f.stateFile + '.too-deep'), { code: 'ENOENT' });
});

test('larger server metadata limit still emits at most 64KiB transport chunks', async t => {
  const f = await fixture(t);
  await saveJson(f.contractFile, { ...f.contract, max_metadata_bytes: 128 * 1024 });
  await saveJson(f.metadataFile, { future: 'x'.repeat(70000) }); await prepareUpload(f);
  const sent = await sendUpload(f, async (_url, init) => {
    for await (const chunk of init.body) assert.ok(chunk.length <= 65536);
    return new Response('');
  });
  assert.equal(sent.exitCode, 0);
});

test('send rejects changed files, foreign/expired/unsupported sessions and unsafe origins before HTTP', async t => {
  const f = await fixture(t); await prepareUpload(f); let requests = 0;
  const network: UploadFetch = async () => { requests++; throw new Error('must not send'); };
  await writeFile(f.file, Buffer.alloc(f.bytes.length, 0));
  await assert.rejects(sendUpload(f, network), { code: 'FILE_CHANGED' }); await writeFile(f.file, f.bytes);
  for (const [session, code] of [
    [{ ...f.session, upload: { ...f.session.upload, url: 'https://other.example/upload' } }, 'SESSION_ORIGIN_MISMATCH'],
    [{ ...f.session, expires_at: 1 }, 'SESSION_EXPIRED'],
    [{ ...f.session, token: 'invalid' }, 'INVALID_SESSION'],
    [{ ...f.session, upload: { ...f.session.upload, method: 'GET' } }, 'INVALID_SESSION'],
    [{ ...f.session, upload: { ...f.session.upload, protocol_version: 2 } }, 'INVALID_SESSION'],
    [{ ...f.session, upload: { url: f.origin + '/upload', method: 'POST' } }, 'INVALID_SESSION'],
  ] as const) {
    await saveJson(f.sessionFile, session); await assert.rejects(sendUpload(f, network), { code });
  }
  for (const origin of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path']) await assert.rejects(prepareUpload({ ...f, origin }), { code: 'INVALID_ORIGIN' });
  assert.equal(requests, 0);
});

test('legacy v1 state sends unchanged with legacy or version1 session, rejects explicit future versions', async t => {
  const f = await fixture(t);
  const metadata = { ...f.metadata, operation_id: 'legacy-operation', size_bytes: f.bytes.length, sha256: sha(f.bytes), future: { retained: null } };
  await saveJson(f.stateFile, { version: 1, origin: f.origin, file: f.file, metadata });
  const before = await readFile(f.stateFile, 'utf8');
  for (const upload of [{ url: f.origin + '/upload', method: 'POST', authorization: 'Bearer <token>', body: 'multipart/form-data: metadata JSON first, then exactly one file part', metadata_schema: { type: 'object', properties: { filename: { type: 'string' } } }, recovery: 'Save operation_id and parameters before upload. Query operation.get after an unknown result. Retransmit identical parameters only when steps.upload=needs_reupload.' }, { url: f.origin + '/upload', method: 'POST' }, f.session.upload]) {
    await saveJson(f.sessionFile, { ...f.session, upload });
    const result = await sendUpload(f, async (_url, init) => {
      const chunks: Uint8Array[] = []; for await (const chunk of init.body) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString().split('\r\n\r\n')[1].split('\r\n--')[0]), metadata);
      return new Response('');
    });
    assert.equal(result.exitCode, 0); assert.equal(result.result.operation_id, metadata.operation_id);
    assert.equal(await readFile(f.stateFile, 'utf8'), before);
  }
  await saveJson(f.sessionFile, { ...f.session, upload: { ...f.session.upload, protocol_version: 2 } });
  await assert.rejects(sendUpload(f), { code: 'INVALID_SESSION' });
});

test('private input files reject symlinks, directories and permissive permissions', async t => {
  const f = await fixture(t); await prepareUpload(f);
  for (const name of ['sessionFile', 'stateFile', 'metadataFile', 'contractFile'] as const) {
    const link = f[name] + '.link'; await symlink(f[name], link);
    await assert.rejects(name === 'sessionFile' || name === 'stateFile' ? sendUpload({ ...f, [name]: link }) : prepareUpload({ ...f, [name]: link }), { code: 'UNSAFE_PRIVATE_FILE' });
    if (process.platform !== 'win32') {
      await chmod(f[name], 0o644);
      await assert.rejects(name === 'sessionFile' || name === 'stateFile' ? sendUpload(f) : prepareUpload(f), { code: 'UNSAFE_PRIVATE_FILE' });
      await chmod(f[name], 0o600);
    }
  }
  await assert.rejects(sendUpload({ ...f, sessionFile: path.dirname(f.sessionFile) }), { code: 'UNSAFE_PRIVATE_FILE' });
});

test('HTTP CLI sends metadata first, fixed length and same operation; refuses redirects and token arguments', async t => {
  const requests: { url: string | undefined; headers: IncomingHttpHeaders; body: Buffer }[] = []; let redirect = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (redirect) { res.writeHead(307, { location: '/leak' }); res.end(token); return; }
    res.end(JSON.stringify({ resource: { id: 'AbCdEf123456', state: 'deleted' }, token }));
  });
  const f = await fixture(t, await listen(t, server));
  const prepared = await cli(prepareArgs(f)); assert.equal(prepared.code, 0, prepared.stderr);
  const id = JSON.parse(prepared.stdout).operation_id;
  for (let n = 0; n < 2; n++) {
    const sent = await cli(['send', '--state-file', f.stateFile, '--session-file', f.sessionFile]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.deepEqual(JSON.parse(sent.stdout), { operation_id: id, transport_status: 'response_received', http_status: 200 });
    assert.ok(!sent.stdout.includes(token)); assert.ok(!sent.stderr.includes(token));
  }
  for (const req of requests) {
    assert.equal(req.headers.authorization, 'Bearer ' + token); assert.equal(Number(req.headers['content-length']), req.body.length);
    const text = req.body.toString(); assert.ok(text.indexOf('name="metadata"') < text.indexOf('name="file"'));
    assert.ok(text.includes(id)); assert.ok(req.body.includes(f.bytes));
  }
  redirect = true; const sent = await cli(['send', '--state-file', f.stateFile, '--session-file', f.sessionFile]);
  assert.equal(sent.code, 1); assert.equal(requests.length, 3); assert.equal(requests.at(-1)?.url, '/upload');
  assert.equal(JSON.parse(sent.stdout).transport_status, 'response_received'); assert.ok(!sent.stdout.includes(token));
  const invalid = await cli(['send', '--token', token]); assert.equal(invalid.code, 1); assert.ok(!invalid.stderr.includes(token));
});

test('all complete HTTP responses classify only status, regardless of business fields or JSON syntax', async t => {
  const f = await fixture(t); const { operation_id } = await prepareUpload(f);
  for (const status of [200, 201, 202, 204, 307, 400, 401, 409, 422, 500, 503]) {
    for (const body of ['', token, JSON.stringify({ resource: { state: 'deleted', accessible: false, expires_at: -1 }, error: { code: 'FUTURE_CODE' } })]) {
      const response = await sendUpload(f, async () => new Response(status === 204 ? null : body, { status }));
      assert.equal(response.exitCode, status >= 200 && status < 300 ? 0 : 1);
      assert.equal(response.result.transport_status, 'response_received'); assert.equal(response.result.operation_id, operation_id);
      assert.deepEqual(Object.keys(response.result).filter(key => !['operation_id', 'transport_status', 'http_status', 'error_code'].includes(key)), []);
      assert.ok(!JSON.stringify(response).includes(token));
    }
  }
  const unsafe = await sendUpload(f, async () => Response.json({ error: { code: 'unsafe\n' + token }, token }));
  assert.equal(unsafe.result.error_code, undefined);
  const safe = await sendUpload(f, async () => Response.json({ error: { code: 'FUTURE_CODE' } }, { status: 503 }));
  assert.equal(safe.result.error_code, 'FUTURE_CODE');
});

test('request failures and incomplete bounded responses retain operation ID with no automatic retry', async t => {
  const f = await fixture(t); const { operation_id } = await prepareUpload(f); let requests = 0;
  const failed = await sendUpload(f, async () => { requests++; throw new Error(token); });
  assert.deepEqual(failed, { exitCode: 2, result: { operation_id, transport_status: 'request_failed' } });
  const interrupted = await sendUpload(f, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } }), { status: 401 }));
  assert.deepEqual(interrupted, { exitCode: 2, result: { operation_id, transport_status: 'response_incomplete', http_status: 401 } });
  const oversized = await sendUpload(f, async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 }));
  assert.equal(oversized.exitCode, 2); assert.equal(oversized.result.transport_status, 'response_incomplete');
  assert.ok(!JSON.stringify([failed, interrupted, oversized]).includes(token)); assert.equal(requests, 1);
});

test('copied native TypeScript skill runs outside repository with no dependencies', async t => {
  const f = await fixture(t), install = path.join(path.dirname(f.file), 'installed');
  await cp(path.resolve('skills/cf-content-share'), install, { recursive: true });
  const entry = path.join(install, 'scripts/upload.mts');
  const help = await cli(['--help'], entry); assert.equal(help.code, 0); assert.match(help.stdout, /Node.js 24.12\+/);
  const prepared = await cli(prepareArgs(f), entry); assert.equal(prepared.code, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).sha256, sha(f.bytes));
});

test('script streams 16MiB to workerd; discovery metadata and operation recovery confirm default/custom/permanent policy', async t => {
  const f = await fixture(t), issuer = 'https://skill-test.cloudflareaccess.com';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'skill-key', alg: 'RS256', use: 'sig' };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, aud: ['skill-aud'], sub: 'fixture-user', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const jwt = `${claims}.${sign('RSA-SHA256', Buffer.from(claims), privateKey).toString('base64url')}`;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'upload-skill', modulesRoot: '.', modules: [{ type: 'ESModule', path: 'build/index.js' }, { type: 'CompiledWasm', path: 'build/index_bg.wasm' }], compatibilityDate: '2026-10-11', bindings: { PUBLIC_ORIGIN: f.origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'skill-aud' }, d1Databases: ['DB'], kvNamespaces: ['MAPPINGS'], r2Buckets: ['FILES'], outboundService: async () => Response.json({ keys: [jwk] }) }] }));
  t.after(() => mf.dispose()); const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter(x => x.endsWith('.sql')).sort()) await db.exec((await readFile('migrations/' + name, 'utf8')).replace(/^--.*$/gm, '').replaceAll('\n', ' '));
  await db.prepare('INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)').run();
  async function tool(name: string, args: JsonObject) {
    const response = await mf.dispatchFetch(f.origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-access-jwt-assertion': jwt }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const data = await response.json() as { result: { isError: boolean; structuredContent: Record<string, JsonObject> } };
    assert.equal(data.result.isError, false, JSON.stringify(data)); return data.result.structuredContent;
  }
  const detail = await tool('describe', { operation: 'session.create' }); await saveJson(f.contractFile, detail.upload);
  const session = await tool('invoke', { operation: 'session.create', arguments: {} }); await saveJson(f.sessionFile, session);
  let maxChunk = 0, chunks = 0;
  const network: UploadFetch = async (url, init) => {
    async function* counted() { for await (const chunk of init.body) { chunks++; maxChunk = Math.max(maxChunk, chunk.length); yield chunk; } }
    return globalThis.fetch(new URL(new URL(url).pathname, await mf.ready), { ...init, body: counted() as unknown as BodyInit });
  };
  // Workerd may reset early responses to streamed duplicate requests. Buffer only
  // duplicate/revoked test adapters; the real first 16MiB upload remains streaming.
  const buffered: UploadFetch = async (url, init) => {
    const chunks: Uint8Array[] = []; for await (const chunk of init.body) chunks.push(chunk);
    return mf.dispatchFetch(url, { ...init, body: Buffer.concat(chunks) });
  };
  for (const [index, retention] of [undefined, 3600, null].entries()) {
    const current = { ...f, stateFile: f.stateFile + index };
    const bytes = index === 0 ? Buffer.alloc(16 * 1024 * 1024, 0x5a) : Buffer.alloc(0);
    await writeFile(f.file, bytes);
    const metadata = { ...f.metadata, ...(retention === undefined ? {} : { retention_seconds: retention }) };
    await saveJson(f.metadataFile, metadata); const prepared = await prepareUpload(current);
    const result = await sendUpload(current, network); assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(result.result, { operation_id: prepared.operation_id, transport_status: 'response_received', http_status: 201 });
    const recovered = await tool('invoke', { operation: 'operation.get', arguments: { operation_id: prepared.operation_id } });
    const resource = recovered.resource;
    assert.equal(resource.state, 'published'); assert.equal(resource.accessible, true);
    assert.equal(resource.expires_at, retention === null ? null : Number(resource.published_at) + (retention ?? 2592000));
    const stored = await db.prepare('SELECT retention_seconds,published_at,expires_at FROM resources WHERE id=?').bind(resource.id).first();
    assert.deepEqual(stored, { retention_seconds: retention === null ? null : retention ?? 2592000, published_at: resource.published_at, expires_at: resource.expires_at });
    const read = await mf.dispatchFetch(f.origin + '/r/' + resource.id); assert.equal(read.status, 200); assert.equal(sha(new Uint8Array(await read.arrayBuffer())), sha(bytes));
    const before = await readFile(current.stateFile, 'utf8');
    const repeat = await sendUpload(current, buffered); assert.equal(repeat.exitCode, 0, JSON.stringify(repeat));
    assert.equal(await readFile(current.stateFile, 'utf8'), before);
    assert.deepEqual((await tool('invoke', { operation: 'operation.get', arguments: { operation_id: prepared.operation_id } })).resource, resource);
  }
  assert.ok(chunks > 200); assert.ok(maxChunk <= 65536);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').first<{ n: number }>())?.n, 3);
  await db.prepare('UPDATE upload_sessions SET revoked=1').run();
  const rejected = await sendUpload({ ...f, stateFile: f.stateFile + '2' }, buffered); assert.equal(rejected.exitCode, 1); assert.equal(rejected.result.http_status, 401);
});
