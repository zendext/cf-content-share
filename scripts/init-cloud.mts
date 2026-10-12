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
      '部署配置包含未知字段；凭据只能通过环境变量或 --token-file 提供。',
    );
  if (!hexId.test(config.account_id ?? ''))
    throw new Error('account_id 必须为 32 位小写十六进制账户 ID。');
  for (const key of ['worker_name', 'resource_prefix'] as const) {
    if (typeof config[key] !== 'string' || !namePattern.test(config[key]))
      throw new Error(
        `${key} 必须为 3–63 位小写字母、数字或连字符，首尾不能为连字符。`,
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
      throw new Error(`${kind} 资源名称必须为 3–63 位小写字母、数字或连字符。`);
  }
  if (
    typeof names.analytics !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(names.analytics)
  )
    throw new Error(
      'analytics_dataset 必须是字母开头的 1–64 位字母、数字或下划线。',
    );
  let origin: URL;
  let issuer: URL;
  try {
    origin = new URL(config.public_origin);
    issuer = new URL(config.access_issuer);
  } catch {
    throw new Error('public_origin 和 access_issuer 必须为 HTTPS origin。');
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
      'public_origin 必须为无端口 HTTPS origin；access_issuer 必须为团队的 cloudflareaccess.com HTTPS origin。',
    );
  if (
    typeof config.zone_name !== 'string' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(
      config.zone_name,
    ) ||
    (origin.hostname !== config.zone_name &&
      !origin.hostname.endsWith(`.${config.zone_name}`))
  )
    throw new Error('zone_name 必须是 public_origin 所属的 DNS 区域。');
  if (
    typeof config.access_aud !== 'string' ||
    !/^[a-f0-9]{64}$/.test(config.access_aud)
  )
    throw new Error(
      'access_aud 必须为 64 位小写十六进制 Access application audience。',
    );
  const timezone = config.default_timezone ?? 'Asia/Shanghai';
  try {
    if (typeof timezone !== 'string' || /^[+-]/.test(timezone))
      throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('default_timezone 必须为有效时区。');
  }
  for (const key of ['max_file_bytes', 'total_storage_bytes'] as const) {
    if (
      config[key] !== undefined &&
      (typeof config[key] !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(config[key]) ||
        BigInt(config[key]) > 9007199254740991n)
    )
      throw new Error(
        `${key} 必须为非负整数字符串，且不超过 9007199254740991；不设置表示无产品容量上限。`,
      );
  }
  return { ...config, names, timezone };
}

export async function readToken(tokenFile?: string, env = process.env) {
  if (!tokenFile) {
    if (!env.CLOUDFLARE_API_TOKEN?.trim())
      throw new Error('请设置 CLOUDFLARE_API_TOKEN 或使用 --token-file。');
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
      '无法读取 Token 文件：须为当前用户可读的普通文件、权限 0600，内容仅为 Token。',
    );
  } finally {
    await file?.close();
  }
}

async function readOutput(filename: string) {
  try {
    const info = await lstat(filename);
    if (!info.isFile())
      throw new Error('输出必须为普通文件，不能是链接或目录。');
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw new Error('无法安全读取输出配置；检查文件类型和权限。');
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
    throw new Error('已有输出不是有效 JSON，拒绝覆盖。');
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
      '已有输出含未知嵌套配置或自定义构建；拒绝覆盖。请将用户配置移出生成文件后人工合并。',
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
      '已有输出的账户、Worker 或资源标识不匹配（或含未知配置）；拒绝覆盖或重建。核对配置及云端资源后再处理。',
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
    throw new Error('无法读取部署配置 JSON；检查文件和语法。');
  }
  const config = validateConfig(raw);
  if (typeof token !== 'string' || !token || /\s/.test(token))
    throw new Error('Cloudflare API Token 不能为空或包含空白。');
  const output = path.resolve(outputFile);
  if (output === path.resolve(configFile))
    throw new Error('输出文件不能覆盖输入部署配置。');
  let lock: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    if (apply) {
      try {
        lock = await open(`${output}.lock`, 'wx', 0o600);
      } catch {
        throw new Error(
          '无法锁定输出文件；检查父目录、权限或并行初始化进程。中断遗留的 .lock 仅在确认没有运行进程后手动移除。',
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
          `${method} ${route.split('?')[0]}：网络或响应解析失败。${method === 'POST' ? '创建结果未知，不自动重试；重新运行只读计划核对云端状态。' : '请检查网络后重试。'}`,
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
          `${method} ${route.split('?')[0]}：Cloudflare HTTP ${response.status}${codes ? `，错误码 ${codes}` : ''}。检查账户、API 权限、配额及 Cloudflare 状态；${method === 'POST' ? '创建可能已发生，重新运行只读计划核对，禁止盲目重复创建。' : '未修改资源。'}`,
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
            '资源分页超出安全边界；未创建资源，请检查 API 分页响应。',
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
          throw new Error('资源列表响应格式错误；拒绝推断资源不存在。');
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
            throw new Error('R2 分页游标重复或无效；未创建资源。');
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
          `${kind} 存在多个同名资源；请先人工核对，不会自动选择或删除。`,
        );
      const id =
        matches[0]?.[kind === 'd1' ? 'uuid' : kind === 'kv' ? 'id' : 'name'];
      if (
        matches.length &&
        !(
          kind === 'd1' ? databaseId : kind === 'kv' ? hexId : namePattern
        ).test(id ?? '')
      )
        throw new Error(`${kind} 的 API 资源标识无效；停止初始化。`);
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
          '目标 R2 桶未确认使用 Standard 存储类型；拒绝复用 InfrequentAccess 或未知类型，不会修改已有桶设置。',
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
          '目标 R2 桶未确认私有：r2.dev 或自定义域名已启用/状态未知。请核对目标桶；初始化不会修改公开设置。',
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
          `${resource.kind} 创建响应缺少有效标识；结果未知，重新运行只读计划核对。`,
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
        '输出配置在初始化期间被修改，拒绝覆盖。云端资源保留；核对后重新运行。',
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
        throw new Error('必须指定 --config；使用 --help 查看用法。');
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
        ? '参数无效；使用 --help 查看用法。不要通过命令行参数传递 Token。'
        : error instanceof Error
          ? error.message
          : '初始化失败。',
    );
    process.exitCode = 1;
  }
}
