import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Wrangler parses expiration migration and D1 enforces publication guards atomically', async t => {
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'migration',modules:true,script:'export default {}',d1Databases:['DB']}]}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const name of ['0001_resources.sql','0002_files.sql','0003_expiration.sql']) {
  const statements=unstable_splitSqlQuery(await readFile('migrations/'+name,'utf8'));
  await db.batch(statements.map(statement=>db.prepare(statement)));
 }
 assert.equal(await db.prepare('SELECT * FROM expiration_activation').first(),null);
 await assert.rejects(db.exec("INSERT INTO resources(id,kind,state,target_url,created_at,expiration_policy_version,retention_seconds) VALUES('OverflowUrl1','url','published','https://example.com',1,1,9007199254740991)"),/RETENTION_OVERFLOW/);
 assert.equal(await db.prepare("SELECT id FROM resources WHERE id='OverflowUrl1'").first(),null);
 await db.exec("INSERT INTO resources(id,kind,state,target_url,created_at,expiration_policy_version,retention_seconds) VALUES('OverflowUrl2','url','pending','https://example.com',1,1,9007199254740991); INSERT INTO resources(id,kind,state,target_url,created_at,expires_at) VALUES('ExpiredPend1','url','pending','https://example.com',1,1)");
 await assert.rejects(db.exec("UPDATE resources SET state='published' WHERE id='OverflowUrl2'"),/RETENTION_OVERFLOW/);
 await assert.rejects(db.exec("UPDATE resources SET state='published' WHERE id='ExpiredPend1'"),/RESOURCE_EXPIRED/);
 assert.equal((await db.prepare("SELECT count(*) AS count FROM resources WHERE state='pending'").first()).count,2);
 await db.exec("INSERT INTO resources(id,kind,state,target_url,created_at,expiration_policy_version,retention_seconds) VALUES('Permanent001','url','published','https://example.com',1,1,NULL); INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)");
 const permanent=await db.prepare("SELECT expires_at,published_at FROM resources WHERE id='Permanent001'").first();
 assert.equal(permanent.expires_at,null);assert(Number.isSafeInteger(permanent.published_at));
});
