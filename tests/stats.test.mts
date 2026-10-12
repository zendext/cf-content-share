import { stripTypeScriptTypes } from 'node:module';
import type { ApiError, ResourceResult, Results, Descriptor, Catalog, Storage, Mapping, D1Event, R2Event, CacheEvent, Heartbeat, AnalyticsPoint } from './test-contracts.mts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = 'https://s.example.test';
const issuer = 'https://service-test.cloudflareaccess.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'service-key', alg: 'RS256', use: 'sig' };
function jwt(changes = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ iss: issuer, aud: ['service-aud'], sub: 'fixture-user', exp: now + 3600, nbf: now - 1, ...changes })}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>, kv: Awaited<ReturnType<Miniflare['getKVNamespace']>>, client: Client;
let sqlQueries: string[] = [], sqlRows: unknown = [], sqlStatus = 200, malformed = false, providerError = false, projectedOrderOnly = false;
const now = () => Math.floor(Date.now() / 1000);
const create = (extra = {}) => call('resource.create_url', { operation_id: randomUUID(), target_url: 'https://example.com/', ...extra });
const errorCall = async (operation: string, args: Record<string, unknown>, code: string) => {
  const result = await client.callTool({ name: 'invoke', arguments: { operation, arguments: args } });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { error: ApiError }).error.code, code, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes('secret-must-not-leak'), false);
  return (result.structuredContent as { error: ApiError }).error;
};
const request = (path: string, init?: Parameters<Miniflare['dispatchFetch']>[1]) => mf.dispatchFetch(origin + path, init);
const call = async <K extends keyof Results,>(operation: K, args: Record<string, unknown> = {}): Promise<Results[K]> => {
  const result = await client.callTool({ name: 'invoke', arguments: { operation, arguments: args } });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as Results[K];
};
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "service", modulesRoot: '.', modules: [
      { type: 'ESModule', path: 'tests/stats-fixture.mts', contents: stripTypeScriptTypes(await readFile('tests/stats-fixture.mts', 'utf8')) },
      { type: 'ESModule', path: 'build/index.js' },
      { type: 'CompiledWasm', path: 'build/index_bg.wasm' },
    ],
    compatibilityDate: '2026-10-11',
    bindings: { PUBLIC_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: 'service-aud', ANALYTICS_DATASET:'access_events', CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32), ANALYTICS_API_TOKEN:'secret-must-not-leak', DEFAULT_TIMEZONE:'Asia/Shanghai' },
    d1Databases: ['DB'], kvNamespaces: ['MAPPINGS'], r2Buckets: ['FILES'],
    outboundService: async req => {
      if(req.url.includes('/analytics_engine/sql')) {
        const sql = await req.text();
        sqlQueries.push(sql);
        if (projectedOrderOnly && /\b(?:blob|double)\d+\b/.test(sql.match(/ORDER BY (.*?) LIMIT/)?.[1] ?? '')) {
          return new Response('Input was invalid: unable to find type of column', {status:422});
        }
        assert.equal(req.headers.get('authorization'),'Bearer secret-must-not-leak');
        return new Response(malformed ? 'oops secret-must-not-leak' : JSON.stringify(providerError ? {error:{code:'secret-must-not-leak',message:'secret-must-not-leak'}} : {data:sqlRows}), {status:sqlStatus});
      }
      assert.equal(req.url, issuer + '/cdn-cgi/access/certs');
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
    },
  }] }));
  db = await mf.getD1Database('DB');
  kv = await mf.getKVNamespace('MAPPINGS');
  for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec((await readFile('migrations/' + file, 'utf8')).replace(/^--.*$/gm, '').replaceAll('\n', ' '));
  }
  client = new Client({ name: 'service-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    fetch: (url, init) => mf.dispatchFetch(String(url), init as Parameters<Miniflare['dispatchFetch']>[1]) as unknown as Promise<Response>,
    requestInit: { headers: { 'cf-access-jwt-assertion': jwt() } },
  });
  await client.connect(transport);
});
after(async () => { await client?.close(); await mf?.dispose(); });



test('stats summary uses weighted aggregate and explicit window', async () => {
 const end=now(), start=end-3600;
 sqlRows=[{visits:'17'}];
 const result=await call('stats.query',{view:'summary',start,end});
 assert.equal(result.items[0].visits,17);
 assert.equal(result.timezone,'Asia/Shanghai');
 assert.equal(result.completeness,'unknown');
 assert.match(sqlQueries.at(-1)!,/SUM\(_sample_interval\)/);
 assert.match(sqlQueries.at(-1)!,new RegExp(`double1 >= ${start} AND double1 < ${end}`));
});

test('one synchronous submission per successful GET including repeats, bots, preview and stale delete; HEAD/errors excluded', async()=>{
 await request('/test-points',{method:'DELETE'});
 const {resource}=await create();
 const ref='https://news.test/path?x=1&quoted=%22#section';
 for(const headers of [{referer:ref},{'user-agent':'ExampleBot'},{'purpose':'prefetch'},{}]) assert.equal((await request('/r/'+resource.id,{redirect:'manual',headers})).status,302);
 await request('/r/'+resource.id,{method:'HEAD',redirect:'manual'});
 await request('/r/NoSuchRes0000',{redirect:'manual'});
 const snapshot=await kv.get(resource.id);
 await call('resource.delete',{resource_id:resource.id});
 await kv.put(resource.id,snapshot!);
 assert.equal((await request('/r/'+resource.id,{redirect:'manual'})).status,302);
 const points=(await (await request('/test-points')).json() as AnalyticsPoint[]);
 assert.equal(points.length,5);
 assert.equal(new Set(points.map(x=>x.blobs[0])).size,5);
 for(const p of points){assert.deepEqual(p.indexes,[resource.id]);assert.equal(p.blobs[1],resource.id);assert.equal(p.blobs[2],'url');assert.equal(p.doubles[1],302);assert.equal(p.blobs.length,7);}
 assert.equal(points[0].blobs[3],ref);
 assert.equal(points[1].blobs[3],'');
});

test('collector failure and overlong UTF-8 field do not block redirects or truncate',async()=>{
 const {resource}=await create();
 await request('/test-points',{method:'DELETE'});
 await request('/test-fail?value=1');
 try {assert.equal((await request('/r/'+resource.id,{redirect:'manual'})).status,302);}finally{await request('/test-fail?value=0');}
 assert.equal(((await (await request('/test-points')).json() as AnalyticsPoint[])).length,0);
 assert.equal((await request('/r/'+resource.id,{redirect:'manual',headers:{referer:'https://e.test/'+ 'é'.repeat(9000)}})).status,302);
 assert.equal(((await (await request('/test-points')).json() as AnalyticsPoint[])).length,0);
 const logs=(await(await request('/test-logs')).json() as string[]);assert.ok(logs.some(x=>x.includes('ANALYTICS_EVENT_TOO_LARGE')));assert.ok(logs.some(x=>x.includes('ANALYTICS_COLLECTION_FAILED')));assert.ok(!JSON.stringify(logs).includes('secret-must-not-leak'));
});

test('all fixed aggregate views use weights, common filters and bounded output',async()=>{
 const end=now(), start=end-3600;
 const {resource}=await create({title:'Deleted resource'});
 await call('resource.delete',{resource_id:resource.id});
 const args={start,end,resource_id:resource.id,kind:'url'};
 for(const [view,row] of [['summary',{visits:42}],['trend',{bucket_start:start,visits:42}],['referrers',{referer:'https://source.test/a',visits:42}],['regions',{country:'JP',region:'Tokyo',city:'',visits:42}],['top',{resource_id:resource.id,kind:'url',visits:42}]]){
  sqlRows=[row];
  const result=await call('stats.query',{...args,view,...(view==='trend'?{granularity:'hour',timezone:'America/New_York'}:{})});
  assert.equal(result.items[0].visits,42);
  const sql=sqlQueries.at(-1);
  assert.match(sql!,/SUM\(_sample_interval\)/);
  assert.ok(sql!.includes(`hex(index1) = '${Buffer.from(resource.id).toString('hex').toUpperCase()}'`));
  assert.ok(sql!.includes("hex(blob3) = '75726C'"));
  if(view==='top')assert.deepEqual(result.items[0].resource,{id:resource.id,title:'Deleted resource',state:'deleted',published_at:resource.published_at,expires_at:resource.expires_at,deleted_reason:'manual',accessible:false,unavailable_reason:'deleted'});
  if(view==='trend')assert.match(sql!,/INTERVAL '1' HOUR, 'America\/New_York'/);
  if(view==='regions')assert.equal(result.items[0].city,null);
 }
});

test('window, timezone and view arguments reject before network; no silent clipping',async()=>{
 const end=now(),start=end-3600, length=sqlQueries.length;
 for(const args of [{start:end,end},{start:end+1,end},{start:end-30*86400-5,end},{start,end:end+100}]) await errorCall('stats.query',{view:'summary',...args},'INVALID_TIME_RANGE');
 for(const timezone of ['Mars/Olympus','+08:00',"UTC'); DROP TABLE access_events --"]) await errorCall('stats.query',{view:'summary',start,end,timezone},'INVALID_TIMEZONE');
 await errorCall('stats.query',{view:'trend',start,end,granularity:'minute'},'INVALID_ARGUMENTS');
 await errorCall('stats.query',{view:'summary',start,end,granularity:'day'},'INVALID_ARGUMENTS');
 await errorCall('stats.query',{view:'top',start,end,limit:101},'INVALID_ARGUMENTS');
 assert.equal(sqlQueries.length,length);
});

test('samples preserve exact fields and weight, bind cursor filters/window/zone, and use strict time/event order',async()=>{
 const end=now(),start=end-3600;
 const {resource}=await create();
 const referer="https://source.test/a?x=' OR 1=1 --\\tail";
 const row={event_id:'zzzzzzzzzzzz',resource_id:resource.id,kind:'url',time:end-1,status:302,referer,country:'CN',region:'Beijing',city:'Beijing',_sample_interval:'8'};
 sqlRows=[row,{...row,event_id:'yyyyyyyyyyyy'}];
 const filters={start,end,referer,country:'CN',region:'Beijing',city:'Beijing',kind:'url',resource_id:resource.id};
 const page=await call('stats.samples',{...filters,limit:1});
 assert.equal(page.items[0]._sample_interval,8);assert.equal(page.items[0].referer,referer);assert.equal(page.has_more,true);assert.ok(page.next_cursor);
 assert.match(sqlQueries.at(-1)!,/ORDER BY time DESC, event_id DESC LIMIT 2/);
 assert.ok(sqlQueries.at(-1)!.includes(`hex(blob4) = '${Buffer.from(referer).toString('hex').toUpperCase()}'`));
 assert.ok(!sqlQueries.at(-1)!.includes('OR 1=1'));
 sqlRows=[{...row,event_id:'yyyyyyyyyyyy'}];
 const next=await call('stats.samples',{...filters,limit:1,cursor:page.next_cursor});
 assert.equal(next.has_more,false);assert.equal(next.next_cursor,null);
 assert.ok(sqlQueries.at(-1)!.includes(`double1 < ${end-1} OR (double1 = ${end-1} AND blob1 < 'zzzzzzzzzzzz')`));
 for(const changed of [{end:end-1},{referer:'other'},{country:'US'},{region:'x'},{city:'x'},{kind:'file'},{resource_id:'AAAAAAAAAAAA'},{timezone:'UTC'}]) await errorCall('stats.samples',{...filters,...changed,cursor:page.next_cursor},'INVALID_CURSOR');
 sqlRows=[]; await call('stats.samples',{start,end});assert.match(sqlQueries.at(-1)!,/LIMIT 21/);
 await call('stats.samples',{start,end,limit:100});assert.match(sqlQueries.at(-1)!,/LIMIT 101/);
});

test('query HTTP, JSON, shape and oversized response failures are explicit and scrubbed',async()=>{
 const args={start:now()-3600,end:now(),view:'summary'};
 providerError=true;try{await errorCall('stats.query',args,'ANALYTICS_QUERY_FAILED');}finally{providerError=false;}
 sqlStatus=503;try{await errorCall('stats.query',args,'ANALYTICS_QUERY_FAILED');}finally{sqlStatus=200;}
 malformed=true;try{await errorCall('stats.query',args,'ANALYTICS_RESPONSE_INVALID');}finally{malformed=false;}
 for(const rows of [[],[{visits:'NaN'}],[{visits:-1}],[{visits:2,evil:'x'.repeat(12*1024*1024)}]]) {sqlRows=rows;await errorCall('stats.query',args,'ANALYTICS_RESPONSE_INVALID');}
});

test('legal 100 long raw Referer samples fit the bounded response even with JSON escapes',async()=>{
 const end=now(),start=end-3600;
 const referer='\\'.repeat(16000);
 sqlRows=Array.from({length:101},(_,i)=>({event_id:String(1000-i).padStart(12,'0'),resource_id:'AAAAAAAAAAAA',kind:'url',time:end-1,status:302,referer,country:'',region:'',city:'',_sample_interval:1}));
 const result=await call('stats.samples',{start,end,limit:100});
 assert.equal(result.items.length,100);assert.equal(result.items[99].referer,referer);assert.equal(result.has_more,true);
});

test('collector copies only provided Cloudflare geographic fields',async()=>{
 const {resource}=await create();await request('/test-points',{method:'DELETE'});
 await request('/r/'+resource.id,{redirect:'manual',cf:{country:'CN',region:'Zhejiang',city:'Hangzhou'}});
 const points=(await(await request('/test-points')).json() as AnalyticsPoint[]);
 assert.deepEqual(points[0].blobs.slice(4),['CN','Zhejiang','Hangzhou']);
});

test('D1 metadata failure is reported without discarding weighted historical results',async()=>{
 const end=now(),start=end-3600;
 sqlRows=[{resource_id:'AAAAAAAAAAAA',kind:'url',visits:31}];
 await db.exec('ALTER TABLE resources RENAME TO resources_unavailable');
 try {
  const result=await call('stats.query',{start,end,view:'top'});
  assert.equal(result.items[0].visits,31);assert.equal(result.items[0].resource!.state,'unknown');
  assert.deepEqual(result.diagnostics,['RESOURCE_METADATA_UNAVAILABLE']);assert.equal(result.completeness,'unknown');
 } finally {await db.exec('ALTER TABLE resources_unavailable RENAME TO resources');}
});


async function uploadFile(bytes: Buffer, changes: Record<string, unknown> = {}) {
 const {token} = await call('session.create');
 const metadata = {operation_id:randomUUID(),filename:'stats.bin',content_type:'application/octet-stream',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...changes};
 const boundary = 'stats-upload-boundary';
 const body = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stats.bin"\r\n\r\n`),
  bytes,Buffer.from(`\r\n--${boundary}--\r\n`),
 ]);
 const response = await request('/upload',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':`multipart/form-data; boundary=${boundary}`},body});
 assert.equal(response.status,201,await response.clone().text());
 return ((await response.json() as ResourceResult)).resource;
}
const points = async () => await (await request('/test-points')).json() as AnalyticsPoint[];
const waitForCache = async (path: string) => {
 assert.equal((await request('/test-cache-wait?url='+encodeURIComponent(origin+path))).status,200);
};

test('file R2/cache GET, range, retries, bots and preview each submit once; HEAD and errors never submit', {timeout:15000}, async()=>{
 const bytes = Buffer.from('0123456789'), resource = await uploadFile(bytes), path = '/r/'+resource.id;
 await request('/test-points',{method:'DELETE'});
 const before = ((await (await request('/test-r2')).json() as { reads: number })).reads;
 const first = await request(path,{headers:{referer:'https://docs.test/download?version=1'}});
 assert.equal(first.status,200);assert.deepEqual(Buffer.from(await first.arrayBuffer()),bytes);
 assert.equal(((await (await request('/test-r2')).json() as { reads: number })).reads,before+1);
 await waitForCache(path);
 await request('/test-r2?fail=1');
 try {
  // The cached response still succeeds while any R2 get would throw.
  for (const headers of [{},{'user-agent':'StatsBot'},{purpose:'prefetch'}]) {
   const cached = await request(path,{headers});assert.equal(cached.status,200);
   assert.deepEqual(Buffer.from(await cached.arrayBuffer()),bytes);
  }
  assert.equal(((await (await request('/test-r2')).json() as { reads: number })).reads,before+1);
  const rejected = await request(path,{headers:{range:'bytes=2-4'}});
  assert.equal(rejected.status,503);await rejected.text();
 } finally {await request('/test-r2?fail=0');}
 for (let i=0;i<2;i++) {
  const range = await request(path,{headers:{range:'bytes=2-4'}});
  assert.equal(range.status,206);assert.equal(await range.text(),'234');
 }
 const head = await request(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const invalid = await request(path,{headers:{range:'bytes=99-'}});assert.equal(invalid.status,416);await invalid.text();
 const missing = await request('/r/NoSuchFile000');assert.equal(missing.status,404);await missing.text();
 const events = await points();assert.equal(events.length,6);
 assert.deepEqual(events.map(event=>event.doubles[1]),[200,200,200,200,206,206]);
 assert.equal(new Set(events.map(event=>event.blobs[0])).size,6);
 for(const event of events){assert.equal(event.blobs[1],resource.id);assert.equal(event.blobs[2],'file');}
 assert.equal(events[0].blobs[3],'https://docs.test/download?version=1');
});

test('raw SVG cache and successful stale deletion propagation retain served image kind; tombstone blocks cached bytes without an event', {timeout:15000}, async()=>{
 const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>const original=1</script></svg>');
 const resource = await uploadFile(bytes,{filename:'raw.svg',content_type:'image/svg+xml'}), path='/r/'+resource.id;
 await request('/test-points',{method:'DELETE'});
 const shown=await request(path);assert.equal(shown.status,200);assert.equal(shown.headers.get('content-type'),'image/svg+xml');
 assert.match(shown.headers.get('content-disposition')!,/^inline/);assert.deepEqual(Buffer.from(await shown.arrayBuffer()),bytes);
 await waitForCache(path);
 const oldMapping = await kv.get(resource.id);
 await request('/test-cache-delete?fail=1');
 try {
  const deleted = await call('resource.delete',{resource_id:resource.id});assert.equal(deleted.resource.state,'deleted');
 } finally {await request('/test-cache-delete?fail=0');}
 const tombstone = await kv.get(resource.id);
 assert.equal(JSON.parse(tombstone!).state,'deleted');
 await kv.put(resource.id,oldMapping!);
 await request('/test-r2?fail=1');
 try {
  const before=((await(await request('/test-r2')).json() as { reads: number })).reads;
  // An unavailable resource table also proves collection uses the served mapping kind.
  await db.exec('ALTER TABLE resources RENAME TO resources_unavailable');
  try {
   const stale=await request(path);assert.equal(stale.status,200);assert.deepEqual(Buffer.from(await stale.arrayBuffer()),bytes);
  } finally {await db.exec('ALTER TABLE resources_unavailable RENAME TO resources');}
  assert.equal(((await(await request('/test-r2')).json() as { reads: number })).reads,before);
  const served=await points();assert.equal(served.length,2);
  for(const event of served){assert.equal(event.blobs[1],resource.id);assert.equal(event.blobs[2],'image');assert.equal(event.doubles[1],200);}
  await kv.put(resource.id,tombstone!);
  const rejected=await request(path);assert.equal(rejected.status,404);await rejected.text();
  assert.equal((await points()).length,2);
  assert.equal(((await(await request('/test-r2')).json() as { reads: number })).reads,before);
 } finally {await request('/test-r2?fail=0');await kv.put(resource.id,tombstone!);}
});

test('file collector failure preserves full and range response bytes',async()=>{
 const bytes=Buffer.from('collector failure file'),resource=await uploadFile(bytes),path='/r/'+resource.id;
 await request('/test-points',{method:'DELETE'});await request('/test-fail?value=1');
 try {
  const full=await request(path);assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  const part=await request(path,{headers:{range:'bytes=0-8'}});assert.equal(part.status,206);assert.equal(await part.text(),'collector');
  assert.equal((await points()).length,0);
 } finally {await request('/test-fail?value=0');}
 const logs=(await(await request('/test-logs')).json() as string[]);assert.ok(logs.some(value=>value.includes('ANALYTICS_COLLECTION_FAILED')));
 assert.ok(!JSON.stringify(logs).includes('secret-must-not-leak'));
});

test('conditional file request currently returns and counts 200; no reachable 304 response is claimed',async()=>{
 const bytes=Buffer.from('conditional bytes'),resource=await uploadFile(bytes),path='/r/'+resource.id;
 await request('/test-points',{method:'DELETE'});
 const response=await request(path,{headers:{'if-none-match':'*','if-modified-since':'Wed, 01 Jan 2031 00:00:00 GMT'}});
 assert.equal(response.status,200);assert.equal(response.headers.get('etag'),null);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 const events=await points();assert.equal(events.length,1);assert.equal(events[0].doubles[1],200);
});

// Real AE returns 422 for source names in ORDER BY after SELECT renamed them.
test('AE orders projected columns in every aliased statistics view',async()=>{
 const end=now(),start=end-60;
 const {resource}=await create();
 projectedOrderOnly=true;
 try {
  for(const [view,row] of [['referrers',{referer:'https://example.test/',visits:1}],['regions',{country:'US',region:'California',city:'',visits:1}],['top',{resource_id:resource.id,kind:'url',visits:1}]]) {
   sqlRows=[row];
   const result=await call('stats.query',{view,start,end});
   assert.equal(result.items[0].visits,1);
  }
  sqlRows=[{event_id:'ABCDEFGHIJKL',resource_id:resource.id,kind:'url',time:end-1,status:302,referer:'',country:'US',region:'',city:'',_sample_interval:1}];
  const samples=await call('stats.samples',{start,end});
  assert.equal(samples.items[0].event_id,'ABCDEFGHIJKL');
 } finally {projectedOrderOnly=false;}
});

test('expiration keeps historical weighted visits while exposing current unavailability before and after cleanup',async()=>{
 const {resource}=await create();const end=now(),start=end-3600;
 await db.prepare('UPDATE resources SET expires_at=unixepoch()-1 WHERE id=?').bind(resource.id).run();
 sqlRows=[{resource_id:resource.id,kind:'url',visits:17}];
 const before=await call('stats.query',{view:'top',start,end});
 assert.equal(before.items[0].visits,17);assert.equal(before.items[0].resource!.state,'published');assert.equal(before.items[0].resource!.accessible,false);assert.equal(before.items[0].resource!.unavailable_reason,'expired');
 await (await mf.getWorker()).scheduled({cron:'*/5 * * * *',scheduledTime:new Date()});
 const after=await call('stats.query',{view:'top',start,end});assert.equal(after.items[0].visits,17);assert.equal(after.items[0].resource!.state,'deleted');assert.equal(after.items[0].resource!.deleted_reason,'expired');assert.equal(after.items[0].resource!.unavailable_reason,'expired');
});
