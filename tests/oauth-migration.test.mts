import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

test('removing upload sessions preserves resources, pending uploads, leases and accounting', async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'migration',
          modules: true,
          script: 'export default {}',
          d1Databases: ['DB'],
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const name of [
    '0001_resources.sql',
    '0002_files.sql',
    '0003_expiration.sql',
  ]) {
    const statements = unstable_splitSqlQuery(
      await readFile(`migrations/${name}`, 'utf8'),
    );
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  await db.exec(
    "INSERT INTO upload_sessions(id,token_hash,created_at,expires_at) VALUES('obsolete','old-hash',1,9007199254740991); INSERT INTO resources(id,kind,state,target_url,created_at) VALUES('ExistingUrl1','url','published','https://example.com/',1); INSERT INTO resources(id,kind,state,file_key,filename,content_type,size_bytes,sha256,accounting,created_at) VALUES('PendingFile1','file','pending','objects/attempt','file.bin','application/octet-stream',42,'digest','reserved',1); INSERT INTO operations(id,type,resource_id,fingerprint,status,upload_state,upload_token,lease_token,lease_until,created_at,updated_at) VALUES('pending-op','resource.upload','PendingFile1','fingerprint','running','uploading','attempt-owner','lease-owner',9007199254740991,1,1)",
  );
  const tables = [
    'resources',
    'operations',
    'storage_usage',
    'expiration_activation',
  ];
  const before = await Promise.all(
    tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
  );
  const schema = await db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE name NOT IN ('upload_sessions','sqlite_autoindex_upload_sessions_1','sqlite_autoindex_upload_sessions_2','sessions_created') ORDER BY name",
    )
    .all();
  for (const sql of unstable_splitSqlQuery(
    await readFile('migrations/0004_remove_upload_sessions.sql', 'utf8'),
  ))
    await db.prepare(sql).run();
  for (const [i, table] of tables.entries())
    assert.deepEqual(
      (await db.prepare(`SELECT * FROM ${table}`).all()).results,
      before[i].results,
    );
  assert.equal(
    await db
      .prepare("SELECT name FROM sqlite_master WHERE name='upload_sessions'")
      .first(),
    null,
  );
  assert.deepEqual(
    (await db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all())
      .results,
    schema.results,
  );
});
