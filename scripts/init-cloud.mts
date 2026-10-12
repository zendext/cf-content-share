#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type CloudFetch = (
  url: string,
  init: RequestInit & { headers: Record<string, string>; body?: string },
) => Promise<Response>;
type DeploymentConfig = {
  account_id: string;
  worker_name: string;
  resource_prefix: string;
  public_origin: string;
  zone_name: string;
  access_issuer: string;
  access_aud: string;
  default_timezone?: string;
  max_file_bytes?: string;
  total_storage_bytes?: string;
  d1_name?: string;
  kv_name?: string;
  r2_name?: string;
  analytics_dataset?: string;
};
type ResourceKind = 'd1' | 'kv' | 'r2';
type CloudResource = {
  name?: string;
  title?: string;
  uuid?: string;
  id?: string;
  storage_class?: string;
};
type PlannedResource = {
  kind: ResourceKind;
  name: string;
  id: string | undefined;
  action: string;
  route: string;
};
type ApiResponse<T> = {
  success: boolean;
  result: T;
  errors?: { code?: number }[];
  result_info?: {
    cursor?: string;
    total_pages?: number;
    total_count?: number;
    per_page?: number;
  };
};
export type InitializeOptions = {
  configFile: string;
  outputFile: string;
  apply?: boolean;
  token: string;
  fetch?: CloudFetch;
  projectRoot?: string;
};

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const hexId = /^[a-f0-9]{32}$/;
const databaseId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const namePattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function validateConfig(config: DeploymentConfig) {
  const fields = [
    'account_id',
    'worker_name',
    'resource_prefix',
    'public_origin',
    'zone_name',
    'access_issuer',
    'access_aud',
    'default_timezone',
    'max_file_bytes',
    'total_storage_bytes',
    'd1_name',
    'kv_name',
    'r2_name',
    'analytics_dataset',
  ];
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !fields.includes(key))
  )
    throw new Error(
      'Deployment configuration contains unknown fields. Supply credentials only through an environment variable or --token-file.',
    );
  if (!hexId.test(config.account_id ?? ''))
    throw new Error(
      'account_id must be a 32-character lowercase hexadecimal account ID.',
    );
  for (const key of ['worker_name', 'resource_prefix'] as const) {
    if (typeof config[key] !== 'string' || !namePattern.test(config[key]))
      throw new Error(
        `${key} must contain 3-63 lowercase letters, digits, or hyphens and cannot start or end with a hyphen.`,
      );
  }
  const names = {
    d1: config.d1_name ?? config.resource_prefix,
    kv: config.kv_name ?? `${config.resource_prefix}-mappings`,
    r2: config.r2_name ?? config.resource_prefix,
    analytics:
      config.analytics_dataset ?? config.resource_prefix.replaceAll('-', '_'),
  };
  for (const kind of ['d1', 'kv', 'r2'] as const) {
    if (typeof names[kind] !== 'string' || !namePattern.test(names[kind]))
      throw new Error(
        `The ${kind} resource name must contain 3-63 lowercase letters, digits, or hyphens.`,
      );
  }
  if (
    typeof names.analytics !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(names.analytics)
  )
    throw new Error(
      'analytics_dataset must contain 1-64 letters, digits, or underscores and start with a letter.',
    );
  let origin: URL;
  let issuer: URL;
  try {
    origin = new URL(config.public_origin);
    issuer = new URL(config.access_issuer);
  } catch {
    throw new Error('public_origin and access_issuer must be HTTPS origins.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== config.public_origin ||
    origin.port ||
    issuer.protocol !== 'https:' ||
    issuer.origin !== config.access_issuer ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) ||
    issuer.port
  )
    throw new Error(
      'public_origin must be an HTTPS origin without a port. access_issuer must be the team HTTPS origin under cloudflareaccess.com.',
    );
  if (
    typeof config.zone_name !== 'string' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(
      config.zone_name,
    ) ||
    (origin.hostname !== config.zone_name &&
      !origin.hostname.endsWith(`.${config.zone_name}`))
  )
    throw new Error('zone_name must be the DNS zone containing public_origin.');
  if (
    typeof config.access_aud !== 'string' ||
    !/^[a-f0-9]{64}$/.test(config.access_aud)
  )
    throw new Error(
      'access_aud must be a 64-character lowercase hexadecimal Access application audience.',
    );
  const timezone = config.default_timezone ?? 'Asia/Shanghai';
  try {
    if (typeof timezone !== 'string' || /^[+-]/.test(timezone))
      throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('default_timezone must be a valid timezone.');
  }
  for (const key of ['max_file_bytes', 'total_storage_bytes'] as const) {
    if (
      config[key] !== undefined &&
      (typeof config[key] !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(config[key]) ||
        BigInt(config[key]) > 9007199254740991n)
    )
      throw new Error(
        `${key} must be a non-negative integer string no greater than 9007199254740991. Omit it to disable the application capacity limit.`,
      );
  }
  return { ...config, names, timezone };
}

export async function readToken(tokenFile?: string, env = process.env) {
  if (!tokenFile) {
    if (!env.CLOUDFLARE_API_TOKEN?.trim())
      throw new Error('Set CLOUDFLARE_API_TOKEN or use --token-file.');
    return env.CLOUDFLARE_API_TOKEN.trim();
  }
  let file: FileHandle | undefined;
  try {
    file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error();
    const token = (await file.readFile('utf8')).trim();
    if (!token || /\s/.test(token)) throw new Error();
    return token;
  } catch {
    throw new Error(
      'Cannot read the token file. It must be a regular file readable by the current user, have mode 0600, and contain only the token.',
    );
  } finally {
    await file?.close();
  }
}

async function readOutput(filename: string) {
  try {
    const info = await lstat(filename);
    if (!info.isFile())
      throw new Error(
        'The output must be a regular file, not a symlink or directory.',
      );
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw new Error(
      'Cannot safely read the output configuration. Check its file type and permissions.',
    );
  }
}

function assertExisting(
  previous: string | null,
  config: ReturnType<typeof validateConfig>,
  resources: PlannedResource[],
) {
  if (previous === null) return;
  // biome-ignore lint/suspicious/noImplicitAnyLet: Parsed configuration is checked field by field below before reuse.
  let old;
  try {
    old = JSON.parse(previous);
  } catch {
    throw new Error(
      'The existing output is not valid JSON. Refusing to overwrite it.',
    );
  }
  const allowed = [
    'name',
    'account_id',
    'main',
    'compatibility_date',
    'workers_dev',
    'preview_urls',
    'routes',
    'build',
    'triggers',
    'vars',
    'd1_databases',
    'kv_namespaces',
    'r2_buckets',
    'analytics_engine_datasets',
  ];
  const d1 = old?.d1_databases?.[0];
  const kv = old?.kv_namespaces?.[0];
  const r2 = old?.r2_buckets?.[0];
  const ae = old?.analytics_engine_datasets?.[0];
  const sections = [
    [d1, ['binding', 'database_name', 'database_id', 'migrations_dir']],
    [kv, ['binding', 'id']],
    [r2, ['binding', 'bucket_name']],
    [ae, ['binding', 'dataset']],
    [old?.build, ['command']],
    [old?.triggers, ['crons']],
    [
      old?.vars,
      [
        'PUBLIC_ORIGIN',
        'ACCESS_ISSUER',
        'ACCESS_AUD',
        'CLOUDFLARE_ACCOUNT_ID',
        'ANALYTICS_DATASET',
        'DEFAULT_TIMEZONE',
        'MAX_FILE_BYTES',
        'TOTAL_STORAGE_BYTES',
      ],
    ],
    [old?.routes?.[0], ['pattern', 'zone_name']],
  ];
  const unknownNested = sections.some(
    ([section, keys]) =>
      !section ||
      typeof section !== 'object' ||
      Array.isArray(section) ||
      Object.keys(section).some((key) => !keys.includes(key)),
  );
  if (
    unknownNested ||
    old?.routes?.length !== 1 ||
    old?.build?.command !== 'npm run build'
  )
    throw new Error(
      'The existing output contains unknown nested configuration or a custom build. Refusing to overwrite it. Move custom configuration out of the generated file and merge it manually.',
    );
  if (
    !databaseId.test(d1.database_id ?? '') ||
    !hexId.test(kv.id ?? '') ||
    Object.keys(old).some((key) => !allowed.includes(key)) ||
    old.name !== config.worker_name ||
    old.account_id !== config.account_id ||
    old.d1_databases?.length !== 1 ||
    old.kv_namespaces?.length !== 1 ||
    old.r2_buckets?.length !== 1 ||
    old.analytics_engine_datasets?.length !== 1 ||
    d1.binding !== 'DB' ||
    kv.binding !== 'MAPPINGS' ||
    r2.binding !== 'FILES' ||
    ae.binding !== 'ANALYTICS' ||
    d1.database_name !== config.names.d1 ||
    d1.database_id !== resources[0].id ||
    kv.id !== resources[1].id ||
    r2.bucket_name !== resources[2].id ||
    ae.dataset !== config.names.analytics
  )
    throw new Error(
      'The existing output has mismatched account, Worker, or resource IDs, or unknown configuration. Refusing to overwrite or recreate it. Verify the configuration and cloud resources first.',
    );
}

// Inject fetch only at the API boundary; CLI always uses Cloudflare's fixed HTTPS endpoint.
export async function initialize({
  configFile,
  outputFile,
  apply = false,
  token,
  fetch = globalThis.fetch,
  projectRoot: root = projectRoot,
}: InitializeOptions) {
  let raw: DeploymentConfig;
  try {
    raw = JSON.parse(await readFile(configFile, 'utf8'));
  } catch {
    throw new Error(
      'Cannot read the deployment configuration JSON. Check the file and its syntax.',
    );
  }
  const config = validateConfig(raw);
  if (typeof token !== 'string' || !token || /\s/.test(token))
    throw new Error(
      'The Cloudflare API token must not be empty or contain whitespace.',
    );
  const output = path.resolve(outputFile);
  if (output === path.resolve(configFile))
    throw new Error(
      'The output file must not overwrite the input deployment configuration.',
    );
  let lock: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    if (apply) {
      try {
        lock = await open(`${output}.lock`, 'wx', 0o600);
      } catch {
        throw new Error(
          'Cannot lock the output file. Check its parent directory, permissions, and concurrent initialization processes. Remove a stale .lock file manually only after confirming that no process is running.',
        );
      }
    }
    const previous = await readOutput(output);
    const api = async <T,>(
      route: string,
      method = 'GET',
      body?: unknown,
    ): Promise<ApiResponse<T>> => {
      let response: Response;
      let payload: ApiResponse<T>;
      try {
        response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/${route}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
          },
        );
        payload = await response.json();
      } catch {
        throw new Error(
          `${method} ${route.split('?')[0]}: Network request or response parsing failed. ${method === 'POST' ? 'The creation result is unknown. No automatic retry was attempted. Run the read-only plan again to verify cloud state.' : 'Check the network before retrying.'}`,
        );
      }
      if (!response.ok || payload?.success !== true) {
        const codes = Array.isArray(payload?.errors)
          ? payload.errors
              .map((error) => error?.code)
              .filter(Number.isInteger)
              .join(',')
          : '';
        throw new Error(
          `${method} ${route.split('?')[0]}: Cloudflare HTTP ${response.status}${codes ? `, error codes ${codes}` : ''}. Check the account, API permissions, quotas, and Cloudflare status. ${method === 'POST' ? 'Creation may have succeeded. Run the read-only plan again to verify state before attempting another creation.' : 'No resources were modified.'}`,
        );
      }
      return payload;
    };
    const resources: PlannedResource[] = [];
    for (const kind of ['d1', 'kv', 'r2'] as const) {
      const route =
        kind === 'd1'
          ? 'd1/database'
          : kind === 'kv'
            ? 'storage/kv/namespaces'
            : 'r2/buckets';
      const matches = [];
      let cursor: string | undefined = '';
      const cursors = new Set();
      for (let page = 1; ; page++) {
        if (page > 10000)
          throw new Error(
            'Resource pagination exceeded the safety limit. No resources were created. Check the API pagination response.',
          );
        const query: URLSearchParams = new URLSearchParams({
          per_page: '100',
          ...(kind === 'r2'
            ? { ...(cursor ? { cursor } : {}) }
            : { page: String(page) }),
        });
        const payload = await api<
          CloudResource[] | { buckets: CloudResource[] }
        >(`${route}?${query}`);
        const items =
          kind === 'r2'
            ? (payload.result as { buckets?: CloudResource[] })?.buckets
            : payload.result;
        if (!Array.isArray(items))
          throw new Error(
            'Invalid resource list response format. Cannot determine whether resources exist.',
          );
        matches.push(
          ...items.filter(
            (item) =>
              item?.[kind === 'kv' ? 'title' : 'name'] === config.names[kind],
          ),
        );
        if (kind === 'r2') {
          cursor = payload.result_info?.cursor;
          if (!cursor) break;
          if (typeof cursor !== 'string' || cursors.has(cursor))
            throw new Error(
              'The R2 pagination cursor is repeated or invalid. No resources were created.',
            );
          cursors.add(cursor);
        } else {
          const info = payload.result_info;
          if (
            info?.total_pages !== undefined &&
            Number.isInteger(info.total_pages)
          ) {
            if (page >= info.total_pages) break;
          } else if (
            info?.total_count !== undefined &&
            Number.isInteger(info.total_count)
          ) {
            if (page * (info.per_page ?? 100) >= info.total_count) break;
          } else if (items.length < 100) break;
        }
      }
      if (matches.length > 1)
        throw new Error(
          `Multiple ${kind} resources share the same name. Verify them manually; none will be selected or deleted automatically.`,
        );
      const id =
        matches[0]?.[kind === 'd1' ? 'uuid' : kind === 'kv' ? 'id' : 'name'];
      if (
        matches.length &&
        !(
          kind === 'd1' ? databaseId : kind === 'kv' ? hexId : namePattern
        ).test(id ?? '')
      )
        throw new Error(
          `The ${kind} API resource ID is invalid. Initialization stopped.`,
        );
      resources.push({
        kind,
        name: config.names[kind],
        id,
        action: matches.length ? 'reuse' : 'create',
        route,
      });
    }
    assertExisting(previous, config, resources);
    const checkBucket = async () => {
      const bucket = await api<CloudResource>(`r2/buckets/${config.names.r2}`);
      if (
        bucket.result?.name !== config.names.r2 ||
        bucket.result?.storage_class !== 'Standard'
      )
        throw new Error(
          'The target R2 bucket is not confirmed to use Standard storage. Refusing to reuse InfrequentAccess or unknown storage classes. Existing bucket settings will not be changed.',
        );
      const route = `r2/buckets/${config.names.r2}/domains`;
      const managed = await api<{ enabled: boolean }>(`${route}/managed`);
      const custom = await api<{ domains: { enabled: boolean }[] }>(
        `${route}/custom`,
      );
      if (
        managed.result?.enabled !== false ||
        !Array.isArray(custom.result?.domains) ||
        custom.result.domains.some((domain) => domain.enabled !== false)
      )
        throw new Error(
          'The target R2 bucket is not confirmed private: r2.dev or custom domains are enabled or their status is unknown. Verify the bucket; initialization will not change public access settings.',
        );
    };
    if (resources[2].id) await checkBucket();
    if (!apply)
      return {
        mode: 'plan',
        resources,
        analytics: {
          dataset: config.names.analytics,
          action: 'created-on-first-write',
        },
      };
    for (const resource of resources) {
      if (resource.id) continue;
      const payload = await api<CloudResource>(
        resource.route,
        'POST',
        resource.kind === 'kv'
          ? { title: resource.name }
          : {
              name: resource.name,
              ...(resource.kind === 'r2' ? { storage_class: 'Standard' } : {}),
            },
      );
      resource.id =
        payload.result?.[
          resource.kind === 'd1'
            ? 'uuid'
            : resource.kind === 'kv'
              ? 'id'
              : 'name'
        ];
      if (
        !(
          resource.kind === 'd1'
            ? databaseId
            : resource.kind === 'kv'
              ? hexId
              : namePattern
        ).test(resource.id ?? '') ||
        payload.result?.[resource.kind === 'kv' ? 'title' : 'name'] !==
          resource.name
      )
        throw new Error(
          `The ${resource.kind} creation response lacks a valid ID. The result is unknown; run the read-only plan again to verify state.`,
        );
    }
    if (resources[2].action === 'create') await checkBucket();
    const relative = (target: string) =>
      path
        .relative(path.dirname(output), path.join(root, target))
        .split(path.sep)
        .join('/') || '.';
    const vars: Record<string, string> = {
      PUBLIC_ORIGIN: config.public_origin,
      ACCESS_ISSUER: config.access_issuer,
      ACCESS_AUD: config.access_aud,
      CLOUDFLARE_ACCOUNT_ID: config.account_id,
      ANALYTICS_DATASET: config.names.analytics,
      DEFAULT_TIMEZONE: config.timezone,
    };
    if (config.max_file_bytes !== undefined)
      vars.MAX_FILE_BYTES = config.max_file_bytes;
    if (config.total_storage_bytes !== undefined)
      vars.TOTAL_STORAGE_BYTES = config.total_storage_bytes;
    const wrangler = {
      name: config.worker_name,
      account_id: config.account_id,
      main: relative('build/index.js'),
      compatibility_date: '2026-10-11',
      workers_dev: false,
      preview_urls: false,
      routes: [
        {
          pattern: `${new URL(config.public_origin).hostname}/*`,
          zone_name: config.zone_name,
        },
      ],
      build: { command: 'npm run build' },
      triggers: { crons: ['*/5 * * * *'] },
      vars,
      d1_databases: [
        {
          binding: 'DB',
          database_name: config.names.d1,
          database_id: resources[0].id,
          migrations_dir: relative('migrations'),
        },
      ],
      kv_namespaces: [{ binding: 'MAPPINGS', id: resources[1].id }],
      r2_buckets: [{ binding: 'FILES', bucket_name: resources[2].id }],
      analytics_engine_datasets: [
        { binding: 'ANALYTICS', dataset: config.names.analytics },
      ],
    };
    if ((await readOutput(output)) !== previous)
      throw new Error(
        'The output configuration changed during initialization. Refusing to overwrite it. Cloud resources were retained; verify state before rerunning.',
      );
    temporary = `${output}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(wrangler, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, output);
    temporary = undefined;
    return {
      mode: 'apply',
      resources,
      analytics: {
        dataset: config.names.analytics,
        action: 'created-on-first-write',
      },
      output,
    };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) {
      await lock.close();
      await unlink(`${output}.lock`).catch(() => {});
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        output: { type: 'string' },
        'token-file': { type: 'string' },
        apply: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
    });
    if (values.help) {
      console.log(
        'node scripts/init-cloud.mts --config deployment.local.json [--output wrangler.cloud.json] [--token-file /path/to/token] [--apply]\n默认只读计划；--apply 才创建缺失资源并写入配置。初始化不会部署或迁移。',
      );
    } else {
      if (!values.config)
        throw new Error('--config is required. Use --help for usage.');
      const token = await readToken(values['token-file']);
      const result = await initialize({
        configFile: values.config,
        outputFile:
          values.output ?? path.join(projectRoot, 'wrangler.cloud.json'),
        apply: values.apply,
        token,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    // parseArgs errors can echo unknown arguments containing credentials.
    console.error(
      error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('ERR_PARSE_ARGS')
        ? 'Invalid arguments. Use --help for usage. Do not pass tokens as command-line arguments.'
        : error instanceof Error
          ? error.message
          : 'Initialization failed.',
    );
    process.exitCode = 1;
  }
}
