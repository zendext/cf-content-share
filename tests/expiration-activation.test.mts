import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  activateExpiration,
  activationSql,
} from '../scripts/activate-expiration.mts';
import type { CloudFetch } from '../scripts/init-cloud.mts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'expiration-activation-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'wrangler.jsonc');
  const account_id = 'a'.repeat(32),
    database_id = '11111111-1111-1111-1111-111111111111';
  await writeFile(
    configFile,
    JSON.stringify({
      account_id,
      d1_databases: [{ binding: 'DB', database_id, database_name: 'test' }],
      env: {
        staging: {
          d1_databases: [
            { binding: 'DB', database_id, database_name: 'stage' },
          ],
        },
      },
    }),
  );
  return { configFile, token: 'secret-must-not-leak' };
}
test('expiration activation previews read-only and applies once with a stable database T0', async (t) => {
  const config = await fixture(t);
  let activated_at: number | null = null;
  const queries: string[] = [];
  const fetch: CloudFetch = async (url, init) => {
    assert(url.endsWith('/query'));
    assert.equal(init.headers.authorization, 'Bearer secret-must-not-leak');
    const { sql } = JSON.parse(init.body!);
    queries.push(sql);
    if (sql === activationSql) activated_at ??= 1791763200;
    return Response.json({
      success: true,
      result: [
        {
          success: true,
          results: [
            {
              activated_at,
              migrated_count: activated_at === null ? null : 3,
              legacy_resources: 3,
              new_resources: 2,
            },
          ],
        },
      ],
    });
  };
  const preview = await activateExpiration({ ...config, fetch });
  assert.equal(preview.activated, false);
  assert.equal(queries.length, 1);
  assert(queries[0].startsWith('SELECT'));
  const result = await activateExpiration({ ...config, fetch, apply: true });
  assert.equal(result.activated_at, 1791763200);
  assert.equal(result.legacy_expires_at, 1794355200);
  assert.equal(result.migrated_count, 3);
  assert.equal(result.already_activated, false);
  const again = await activateExpiration({
    ...config,
    fetch,
    apply: true,
    environment: 'staging',
  });
  assert.equal(again.activated_at, result.activated_at);
  assert.equal(again.already_activated, true);
  assert.equal(again.database, 'stage');
});
test('expiration activation errors redact network and API bodies and reject invalid environments', async (t) => {
  const config = await fixture(t);
  for (const fetch of [
    async () => {
      throw new Error('secret-must-not-leak');
    },
    async () => new Response('secret-must-not-leak', { status: 502 }),
    async () =>
      Response.json(
        { success: false, errors: [{ message: 'secret-must-not-leak' }] },
        { status: 403 },
      ),
  ]) {
    await assert.rejects(
      activateExpiration({ ...config, fetch }),
      (error) =>
        error instanceof Error &&
        !error.message.includes('secret-must-not-leak'),
    );
  }
  await assert.rejects(
    activateExpiration({
      ...config,
      environment: 'missing',
      fetch: () => assert.fail('must not request'),
    }),
    /environment/,
  );
});
