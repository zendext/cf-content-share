#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { experimental_readRawConfig } from 'wrangler';
import { type CloudFetch, readToken } from './init-cloud.mts';

type ActivationOptions = {
  configFile: string;
  environment?: string;
  apply?: boolean;
  token: string;
  fetch?: CloudFetch;
};
type ActivationRow = {
  activated_at: number | null;
  migrated_count: number | null;
  legacy_resources: number;
  new_resources: number;
};
type D1Response = {
  success: boolean;
  result: { success: boolean; results?: ActivationRow[] }[];
};

export const activationSql =
  'INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)';
const previewSql = `SELECT (SELECT activated_at FROM expiration_activation WHERE id=1) AS activated_at,
 (SELECT migrated_count FROM expiration_activation WHERE id=1) AS migrated_count,
 (SELECT count(*) FROM resources WHERE expiration_policy_version=0 AND state!='deleted') AS legacy_resources,
 (SELECT count(*) FROM resources WHERE expiration_policy_version=1) AS new_resources`;

// Only SQL at the D1 boundary is injected in tests. Preview never submits a write.
export async function activateExpiration({
  configFile,
  environment,
  apply = false,
  token,
  fetch = globalThis.fetch,
}: ActivationOptions) {
  let config: ReturnType<typeof experimental_readRawConfig>['rawConfig'];
  try {
    const { rawConfig } = experimental_readRawConfig({ config: configFile });
    if (environment && !rawConfig.env?.[environment]) throw new Error();
    config = environment
      ? {
          ...rawConfig,
          ...rawConfig.env?.[environment],
          d1_databases: rawConfig.env?.[environment].d1_databases,
        }
      : rawConfig;
  } catch {
    throw new Error('无法读取 Wrangler 配置或所选环境。');
  }
  const databases = config.d1_databases?.filter(
    (database: {
      binding: string;
      database_id?: string;
      database_name?: string;
    }) => database.binding === 'DB',
  );
  if (
    !/^[a-f0-9]{32}$/.test(config.account_id ?? '') ||
    databases?.length !== 1 ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      databases[0].database_id ?? '',
    )
  ) {
    throw new Error(
      'Wrangler 配置必须包含有效 account_id 和唯一 DB 数据库绑定。',
    );
  }
  const database = databases[0];
  async function query(sql: string) {
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/${database.database_id}/query`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ sql }),
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        },
      );
    } catch {
      throw new Error('D1 请求失败；结果可能未确认，请重新预览。');
    }
    let body: D1Response;
    try {
      body = await response.json();
    } catch {
      throw new Error(`D1 返回格式无效（HTTP ${response.status}）。`);
    }
    if (
      !response.ok ||
      body.success !== true ||
      !Array.isArray(body.result) ||
      body.result.some((item) => item.success !== true)
    ) {
      throw new Error(
        `D1 操作失败（HTTP ${response.status}）；检查权限和 0003 迁移状态，重新预览后再重试。`,
      );
    }
    return body.result;
  }
  const before = (await query(previewSql))[0]?.results?.[0];
  if (!before || !Number.isInteger(before.legacy_resources))
    throw new Error('D1 预览结果无效。');
  if (apply) await query(activationSql);
  const current = apply ? (await query(previewSql))[0]?.results?.[0] : before;
  if (!current || (apply && !Number.isSafeInteger(current.activated_at)))
    throw new Error('D1 激活结果尚未确认；请重新预览。');
  return {
    mode: apply ? 'apply' : 'preview',
    database: database.database_name,
    already_activated: before.activated_at !== null,
    activated: current.activated_at !== null,
    activated_at: current.activated_at,
    legacy_expires_at:
      current.activated_at === null ? null : current.activated_at + 2592000,
    migrated_count: current.migrated_count,
    legacy_resources: current.legacy_resources,
    new_resources: current.new_resources,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        env: { type: 'string' },
        'token-file': { type: 'string' },
        apply: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
    });
    if (values.help)
      console.log(
        'node scripts/activate-expiration.mts --config wrangler.cloud.json [--env NAME] [--token-file /private/token] [--apply]\n默认只读预览；新 Worker 成功部署后使用 --apply 一次性固定旧资源 T0。重复执行保留原 T0 和后续编辑。',
      );
    else {
      if (!values.config)
        throw new Error('必须指定 --config；使用 --help 查看用法。');
      const token = await readToken(values['token-file']);
      console.log(
        JSON.stringify(
          await activateExpiration({
            configFile: values.config,
            environment: values.env,
            apply: values.apply,
            token,
          }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code.startsWith('ERR_PARSE_ARGS')
        ? '参数无效；使用 --help 查看用法。不要通过命令行传递 Token。'
        : error instanceof Error
          ? error.message
          : '激活失败。',
    );
    process.exitCode = 1;
  }
}
