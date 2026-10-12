#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
// Standalone native Node.js 24.12+ TypeScript. Business decisions stay with the Agent.
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
type Protocol = {
  protocol_version: 1;
  url: string;
  method: 'POST';
  max_metadata_bytes: number;
};
type Fingerprint = { size_bytes: number; sha256: string };
type Metadata = JsonObject & Fingerprint & { operation_id: string };
export type UploadRequest = {
  method: 'POST';
  redirect: 'manual';
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  duplex: 'half';
};
export type UploadFetch = (
  url: string,
  init: UploadRequest,
) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>;
type TransportResult = {
  operation_id: string;
  transport_status:
    | 'request_failed'
    | 'response_incomplete'
    | 'response_received';
  http_status?: number;
  error_code?: string;
};
const generatedFields = ['operation_id', 'size_bytes', 'sha256'];
const maxMetadataBytes = 128 * 1024;
const maxPrivateBytes = 256 * 1024;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_ORIGIN');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('INVALID_ORIGIN');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !(url.protocol === 'https:' || (local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    fail('INVALID_ORIGIN');
  return url.origin;
}
function endpoint(value: unknown, origin: string, code: string): string {
  if (typeof value !== 'string') fail(code);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (url.origin !== origin || url.username || url.password || url.hash)
    fail(code);
  return url.href;
}
function safeJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number')
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  if (Array.isArray(value))
    return value.every((item) => safeJson(item, depth + 1));
  return (
    isObject(value) &&
    Object.values(value).every((item) => safeJson(item, depth + 1))
  );
}
async function privateJson(filename: string): Promise<JsonValue> {
  let file: FileHandle | undefined;
  try {
    file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > maxPrivateBytes ||
      (process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      fail('UNSAFE_PRIVATE_FILE');
    const bytes = await file.readFile();
    if (bytes.length > maxPrivateBytes) fail('UNSAFE_PRIVATE_FILE');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!safeJson(value)) fail('INVALID_PRIVATE_JSON');
    return value;
  } catch (error) {
    if (['UNSAFE_PRIVATE_FILE', 'ELOOP'].includes(errorCode(error) ?? ''))
      fail('UNSAFE_PRIVATE_FILE');
    return fail('INVALID_PRIVATE_JSON');
  } finally {
    await file?.close();
  }
}
async function inspectFile(file: FileHandle): Promise<Fingerprint> {
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    fail('INVALID_FILE');
  const hash = createHash('sha256');
  for await (const chunk of file.createReadStream({
    start: 0,
    autoClose: false,
    highWaterMark: 65536,
  }))
    hash.update(chunk);
  const after = await file.stat({ bigint: true });
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    fail('FILE_CHANGED');
  return { size_bytes: Number(after.size), sha256: hash.digest('hex') };
}
function validMetadata(metadata: unknown, limit: number): metadata is Metadata {
  return (
    isObject(metadata) &&
    typeof metadata.operation_id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(metadata.operation_id) &&
    typeof metadata.size_bytes === 'number' &&
    Number.isSafeInteger(metadata.size_bytes) &&
    metadata.size_bytes >= 0 &&
    typeof metadata.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(metadata.sha256) &&
    Buffer.byteLength(JSON.stringify(metadata)) <= limit
  );
}
function protocol(value: unknown, origin: string): Protocol {
  if (
    !isObject(value) ||
    value.protocol_version !== 1 ||
    value.method !== 'POST' ||
    typeof value.max_metadata_bytes !== 'number' ||
    !Number.isSafeInteger(value.max_metadata_bytes) ||
    value.max_metadata_bytes < 1 ||
    value.max_metadata_bytes > maxMetadataBytes
  )
    fail('INVALID_CONTRACT');
  return {
    protocol_version: 1,
    method: 'POST',
    url: endpoint(value.url, origin, 'INVALID_CONTRACT'),
    max_metadata_bytes: value.max_metadata_bytes,
  };
}

export async function prepareUpload({
  file,
  origin,
  stateFile,
  metadataFile,
  contractFile,
}: {
  file: string;
  origin: string;
  stateFile: string;
  metadataFile: string;
  contractFile: string;
}) {
  origin = normalizeOrigin(origin);
  const contract = await privateJson(contractFile);
  const upload = protocol(contract, origin);
  if (
    !isObject(contract) ||
    contract.authorization !== 'Bearer <token>' ||
    !Array.isArray(contract.generated_fields) ||
    contract.generated_fields.length !== generatedFields.length ||
    !generatedFields.every((field) =>
      (contract.generated_fields as JsonValue[]).includes(field),
    )
  )
    fail('INVALID_CONTRACT');
  const input = await privateJson(metadataFile);
  if (
    !isObject(input) ||
    generatedFields.some((field) => Object.hasOwn(input, field))
  )
    fail('INVALID_METADATA');
  const source = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let metadata: Metadata;
  try {
    metadata = {
      ...input,
      operation_id: randomUUID(),
      ...(await inspectFile(source)),
    };
  } finally {
    await source.close();
  }
  if (!validMetadata(metadata, upload.max_metadata_bytes))
    fail('INVALID_METADATA');
  const state = {
    version: 2,
    origin,
    file: path.resolve(file),
    protocol: upload,
    metadata,
  };
  if (!safeJson(state)) fail('INVALID_METADATA');
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized) > maxPrivateBytes) fail('INVALID_STATE');
  let output: FileHandle;
  try {
    output = await open(stateFile, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') fail('STATE_EXISTS');
    throw error;
  }
  try {
    await output.writeFile(serialized);
    await output.sync();
  } finally {
    await output.close();
  }
  return {
    operation_id: metadata.operation_id,
    size_bytes: metadata.size_bytes,
    sha256: metadata.sha256,
    state_file: path.resolve(stateFile),
  };
}

export async function sendUpload(
  { stateFile, sessionFile }: { stateFile: string; sessionFile: string },
  fetch: UploadFetch = (url, init) =>
    globalThis.fetch(url, { ...init, body: init.body as unknown as BodyInit }),
) {
  const state = await privateJson(stateFile);
  if (
    !isObject(state) ||
    (state.version !== 1 && state.version !== 2) ||
    typeof state.file !== 'string' ||
    !path.isAbsolute(state.file) ||
    normalizeOrigin(state.origin) !== state.origin
  )
    fail('INVALID_STATE');
  const origin = state.origin as string;
  const upload =
    state.version === 2 ? protocol(state.protocol, origin) : undefined;
  if (
    !validMetadata(
      state.metadata,
      upload?.max_metadata_bytes ?? maxMetadataBytes,
    )
  )
    fail('INVALID_STATE');
  const metadata = state.metadata;
  const source = await open(
    state.file,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const fingerprint = await inspectFile(source);
    if (
      fingerprint.size_bytes !== metadata.size_bytes ||
      fingerprint.sha256 !== metadata.sha256
    )
      fail('FILE_CHANGED');
    const session = await privateJson(sessionFile);
    if (
      !isObject(session) ||
      typeof session.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(session.token) ||
      typeof session.expires_at !== 'number' ||
      !Number.isSafeInteger(session.expires_at) ||
      !isObject(session.upload) ||
      session.upload.method !== 'POST'
    )
      fail('INVALID_SESSION');
    const sessionUpload = session.upload;
    if (
      sessionUpload.protocol_version !== 1 &&
      !(
        state.version === 1 &&
        !Object.hasOwn(sessionUpload, 'protocol_version') &&
        Object.keys(sessionUpload).every((key) =>
          [
            'url',
            'method',
            'authorization',
            'body',
            'metadata_schema',
            'recovery',
          ].includes(key),
        )
      )
    )
      fail('INVALID_SESSION');
    if (session.expires_at <= Math.floor(Date.now() / 1000))
      fail('SESSION_EXPIRED');
    const url = endpoint(sessionUpload.url, origin, 'SESSION_ORIGIN_MISMATCH');
    if (upload && url !== upload.url) fail('INVALID_SESSION');
    const boundary = `cf-share-${randomUUID()}`;
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const length = prefix.length + metadata.size_bytes + suffix.length;
    if (!Number.isSafeInteger(length)) fail('INVALID_FILE');
    async function* body(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < prefix.length; offset += 65536)
        yield prefix.subarray(offset, offset + 65536);
      if (metadata.size_bytes)
        yield* source.createReadStream({
          start: 0,
          end: metadata.size_bytes - 1,
          autoClose: false,
          highWaterMark: 65536,
        });
      yield suffix;
    }
    const result: TransportResult = {
      operation_id: metadata.operation_id,
      transport_status: 'request_failed',
    };
    let response: Awaited<ReturnType<UploadFetch>>;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        duplex: 'half',
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(length),
        },
        body: body(),
      });
    } catch {
      return { exitCode: 2, result };
    }
    result.http_status = response.status;
    result.transport_status = 'response_incomplete';
    const chunks: Uint8Array[] = [];
    try {
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 256 * 1024) throw new Error('response too large');
          chunks.push(chunk);
        }
    } catch {
      return { exitCode: 2, result };
    }
    result.transport_status = 'response_received';
    // JSON is optional: never interpret resource/result fields or print provider bodies.
    try {
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        isObject(data) &&
        isObject(data.error) &&
        typeof data.error.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(data.error.code) &&
        !data.error.code.includes(session.token)
      )
        result.error_code = data.error.code;
    } catch {
      /* A complete non-JSON response still has a known HTTP status. */
    }
    return {
      exitCode: response.status >= 200 && response.status < 300 ? 0 : 1,
      result,
    };
  } finally {
    await source.close();
  }
}

const help = `Node.js 24.12+; native TypeScript, no npm install required.
prepare --file PATH --origin HTTPS_ORIGIN --metadata-file PRIVATE_JSON --contract-file PRIVATE_JSON --state-file NEW_JSON
send    --state-file PRIVATE_JSON --session-file PRIVATE_JSON

prepare preserves metadata, adds operation_id/size_bytes/sha256, and saves a new private state.
Use the credential-free upload object from describe(session.create) as the contract file.
send reads the session.create result, rechecks the file, and sends once.
HTTPS required except loopback HTTP. No redirects or automatic retries. Never pass a Token as an argument.
Exit 0: prepared or complete HTTP 2xx; 1: local input error or complete non-2xx; 2: request failed or response incomplete.
Always query operation.get after send and follow the discovered recovery rules, regardless of exit code.
`;
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean' },
        file: { type: 'string' },
        origin: { type: 'string' },
        'state-file': { type: 'string' },
        'session-file': { type: 'string' },
        'metadata-file': { type: 'string' },
        'contract-file': { type: 'string' },
      },
    });
    if (values.help) console.log(help);
    else {
      const command = positionals[0];
      const allowed =
        command === 'prepare'
          ? ['file', 'origin', 'state-file', 'metadata-file', 'contract-file']
          : ['state-file', 'session-file'];
      if (
        positionals.length !== 1 ||
        !['prepare', 'send'].includes(command ?? '') ||
        Object.keys(values).some((key) => !allowed.includes(key)) ||
        !values['state-file']
      )
        fail('INVALID_ARGUMENTS');
      if (command === 'prepare') {
        if (
          !values.file ||
          !values.origin ||
          !values['metadata-file'] ||
          !values['contract-file']
        )
          fail('INVALID_ARGUMENTS');
        console.log(
          JSON.stringify(
            await prepareUpload({
              file: values.file,
              origin: values.origin,
              stateFile: values['state-file'],
              metadataFile: values['metadata-file'],
              contractFile: values['contract-file'],
            }),
          ),
        );
      } else {
        if (!values['session-file']) fail('INVALID_ARGUMENTS');
        const { exitCode, result } = await sendUpload({
          stateFile: values['state-file'],
          sessionFile: values['session-file'],
        });
        console.log(JSON.stringify(result));
        process.exitCode = exitCode;
      }
    }
  } catch (error) {
    const safe = [
      'INVALID_ARGUMENTS',
      'INVALID_ORIGIN',
      'INVALID_FILE',
      'INVALID_METADATA',
      'INVALID_CONTRACT',
      'INVALID_STATE',
      'INVALID_SESSION',
      'INVALID_PRIVATE_JSON',
      'UNSAFE_PRIVATE_FILE',
      'STATE_EXISTS',
      'FILE_CHANGED',
      'SESSION_EXPIRED',
      'SESSION_ORIGIN_MISMATCH',
    ];
    const code = errorCode(error) ?? '';
    console.error(
      JSON.stringify({
        error_code: safe.includes(code) ? code : 'LOCAL_ERROR',
        hint: 'Use --help; no upload is retried automatically.',
      }),
    );
    process.exitCode = 1;
  }
}
