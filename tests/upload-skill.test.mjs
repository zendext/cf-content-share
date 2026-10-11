import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, chmod, symlink, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { prepareUpload, sendUpload } from '../skills/cf-content-share/scripts/upload.mjs';

const script = path.resolve('skills/cf-content-share/scripts/upload.mjs');
const token = 'a'.repeat(43);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, origin = 'https://share.example.test') {
  const dir = await mkdtemp(path.join(tmpdir(), 'share-skill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '图片.svg'), stateFile = path.join(dir, 'upload.json'), sessionFile = path.join(dir, 'session.json');
  const bytes = Buffer.from('<svg>原始字节</svg>');
  await writeFile(file, bytes);
  const session = { session_id: 'session', token, expires_at: Math.floor(Date.now()/1000)+3600, upload: {url:origin+'/upload',method:'POST'} };
  await writeFile(sessionFile, JSON.stringify(session), {mode:0o600});
  return {file,stateFile,sessionFile,origin,bytes,session};
}
const prepare = f => prepareUpload({...f, contentType:'image/svg+xml', title:'分享图片', tags:['资料']});
function cli(args, entry = script) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,[entry,...args]);
    let stdout='',stderr='';
    child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('prepare persists a private immutable operation with real digest and metadata', async t => {
  const f = await fixture(t);
  const result = await prepare(f);
  const saved = JSON.parse(await readFile(f.stateFile,'utf8'));
  assert.equal(saved.origin,f.origin);assert.equal(saved.file,path.resolve(f.file));
  assert.match(saved.metadata.operation_id,/^[0-9a-f-]{36}$/);
  assert.equal(saved.metadata.filename,'图片.svg');assert.equal(saved.metadata.sha256,sha(f.bytes));
  assert.equal(saved.metadata.size_bytes,f.bytes.length);assert.deepEqual(saved.metadata.tags,['资料']);
  assert.equal(result.operation_id,saved.metadata.operation_id);
  if(process.platform!=='win32')assert.equal((await stat(f.stateFile)).mode&0o777,0o600);
  await assert.rejects(prepare(f),{code:'STATE_EXISTS'});
  assert.equal(JSON.parse(await readFile(f.stateFile,'utf8')).metadata.operation_id,result.operation_id);
});

test('send rejects changed files, foreign or expired sessions and unsafe origins before HTTP',async t=>{
  const f=await fixture(t);await prepare(f);let requests=0;
  const network=()=>{requests++;throw new Error('must not send');};
  await writeFile(f.file,Buffer.alloc(f.bytes.length,0));
  await assert.rejects(sendUpload(f,network),{code:'FILE_CHANGED'});await writeFile(f.file,f.bytes);
  for(const [session,code] of [[{...f.session,upload:{url:'https://other.example/upload',method:'POST'}},'SESSION_ORIGIN_MISMATCH'],[{...f.session,expires_at:1},'SESSION_EXPIRED'],[{...f.session,upload:{url:f.origin+'/upload',method:'GET'}},'INVALID_SESSION']]){
    await writeFile(f.sessionFile,JSON.stringify(session));await assert.rejects(sendUpload(f,network),{code});
  }
  await assert.rejects(prepareUpload({...f,stateFile:f.stateFile+'2',origin:'http://example.com',contentType:'text/plain'}),{code:'INVALID_ORIGIN'});
  assert.equal(requests,0);
});

test('private JSON files reject symlinks and permissive POSIX permissions',async t=>{
  const f=await fixture(t);await prepare(f);
  const link=f.sessionFile+'.link';await symlink(f.sessionFile,link);
  await assert.rejects(sendUpload({...f,sessionFile:link}),{code:'UNSAFE_PRIVATE_FILE'});
  if(process.platform!=='win32'){
    await chmod(f.sessionFile,0o644);
    await assert.rejects(sendUpload(f),{code:'UNSAFE_PRIVATE_FILE'});
  }
});

test('HTTP CLI uses metadata first, fixed length, same operation on resend; never follows redirect or echoes token',async t=>{
  const requests=[];let redirect=false;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});
    if(redirect){res.writeHead(307,{location:'/leak'});res.end(token);return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({resource:{id:'AbCdEf123456',state:'published'},token}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const f=await fixture(t,`http://127.0.0.1:${server.address().port}`);
  const prepared=await cli(['prepare','--file',f.file,'--state-file',f.stateFile,'--origin',f.origin,'--content-type','image/svg+xml']);
  assert.equal(prepared.code,0,prepared.stderr);const id=JSON.parse(prepared.stdout).operation_id;
  for(let n=0;n<2;n++){
    const sent=await cli(['send','--state-file',f.stateFile,'--session-file',f.sessionFile]);
    assert.equal(sent.code,0,sent.stderr);const result=JSON.parse(sent.stdout);
    assert.equal(result.operation_id,id);assert.equal(result.url,f.origin+'/r/AbCdEf123456');
    assert.ok(!sent.stdout.includes(token));assert.ok(!sent.stderr.includes(token));
  }
  for(const req of requests){
    assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(Number(req.headers['content-length']),req.body.length);
    const text=req.body.toString();assert.ok(text.indexOf('name="metadata"')<text.indexOf('name="file"'));
    assert.ok(text.includes(id));assert.ok(req.body.includes(f.bytes));
  }
  redirect=true;const sent=await cli(['send','--state-file',f.stateFile,'--session-file',f.sessionFile]);
  assert.equal(sent.code,1);assert.equal(requests.length,3);assert.equal(requests.at(-1).url,'/upload');
  assert.ok(!sent.stdout.includes(token));assert.ok(!sent.stderr.includes(token));
  const invalid=await cli(['send','--token',token]);assert.equal(invalid.code,1);assert.ok(!invalid.stderr.includes(token));
});

test('ambiguous response and transport failure retain operation ID and never retry automatically',async t=>{
  const f=await fixture(t);const {operation_id}=await prepare(f);let requests=0;
  const unknown=await sendUpload(f,async()=>{requests++;throw new Error(token);});
  assert.equal(unknown.exitCode,2);assert.equal(unknown.result.operation_id,operation_id);assert.equal(unknown.result.outcome,'unknown');
  const invalid=await sendUpload(f,async()=>new Response(token,{status:200}));assert.equal(invalid.exitCode,2);
  const pending=await sendUpload(f,async()=>Response.json({resource:{id:'AbCdEf123456',state:'pending'}},{status:202}));
  assert.equal(pending.exitCode,2);assert.equal(pending.result.outcome,'pending');
  const denied=await sendUpload(f,async()=>new Response(token,{status:401}));assert.equal(denied.exitCode,1);assert.ok(!JSON.stringify(denied).includes(token));
  const oversized=await sendUpload(f,async()=>new Response('x'.repeat(256*1024+1),{status:200}));assert.equal(oversized.exitCode,2);
  assert.ok(!JSON.stringify([unknown,invalid,pending]).includes(token));assert.equal(requests,1);
});

test('script streams to real workerd, publishes identical bytes, reuses operation and respects revocation',async t=>{
  const f=await fixture(t);const bytes=Buffer.alloc(16*1024*1024,0x5a);await writeFile(f.file,bytes);
  const prepared=await prepare(f);
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'upload-skill',modulesRoot:'.',modules:[{type:'ESModule',path:'build/index.js'},{type:'CompiledWasm',path:'build/index_bg.wasm'}],compatibilityDate:'2026-10-11',bindings:{PUBLIC_ORIGIN:f.origin},d1Databases:['DB'],kvNamespaces:['MAPPINGS'],r2Buckets:['FILES']}]}));
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(x=>x.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+name,'utf8')).replace(/^--.*$/gm,'').replaceAll('\n',' '));
  await db.prepare('INSERT INTO upload_sessions(id,token_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,0)').bind('session',sha(token),1,f.session.expires_at).run();
  let maxChunk=0,chunks=0;
  const fetch=async(url,init)=>{
    const source=init.body;
    assert.equal(typeof source[Symbol.asyncIterator],'function');
    async function* counted(){for await(const chunk of source){chunks++;maxChunk=Math.max(maxChunk,chunk.length);yield chunk;}}
    return globalThis.fetch(new URL(new URL(url).pathname,await mf.ready),{...init,body:counted()});
  };
  const result=await sendUpload(f,fetch);assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.result.operation_id,prepared.operation_id);
  assert.ok(chunks>200);assert.ok(maxChunk<=65536);
  const read=await mf.dispatchFetch(result.result.url);assert.equal(read.status,200);assert.equal(sha(Buffer.from(await read.arrayBuffer())),sha(bytes));
  const retry=await sendUpload(f,fetch);assert.equal(retry.exitCode,0,JSON.stringify(retry));assert.equal(retry.result.resource_id,result.result.resource_id);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM resources').first()).n,1);
  const empty={...f,file:f.file+'.empty',stateFile:f.stateFile+'.empty'};await writeFile(empty.file,'');
  await prepareUpload({...empty,contentType:'application/octet-stream'});
  const emptyResult=await sendUpload(empty,fetch);assert.equal(emptyResult.exitCode,0);
  const emptyRead=await mf.dispatchFetch(emptyResult.result.url);assert.equal((await emptyRead.arrayBuffer()).byteLength,0);
  await db.prepare('UPDATE upload_sessions SET revoked=1').run();
  const rejected=await sendUpload(f,fetch);assert.equal(rejected.exitCode,1);assert.equal(rejected.result.http_status,401);
});

test('copied skill script runs outside the repository without npm dependencies',async t=>{
 const f=await fixture(t);const install=path.join(path.dirname(f.file),'installed');
 await cp(path.resolve('skills/cf-content-share'),install,{recursive:true});
 const entry=path.join(install,'scripts/upload.mjs');
 const help=await cli(['--help'],entry);assert.equal(help.code,0);assert.match(help.stdout,/prepare/);
 const prepared=await cli(['prepare','--file',f.file,'--origin',f.origin,'--state-file',f.stateFile,'--content-type','image/svg+xml'],entry);
 assert.equal(prepared.code,0,prepared.stderr);assert.equal(JSON.parse(prepared.stdout).sha256,sha(f.bytes));
});
