#!/usr/bin/env node
// Standalone Node.js 22+ helper. OAuth and recovery decisions stay with the MCP client.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function fail(code) { throw Object.assign(new Error(code), {code}); }
function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ORIGIN'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_ORIGIN');
  return url.origin;
}
async function privateJson(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 256*1024 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) fail('UNSAFE_PRIVATE_FILE');
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error.code === 'UNSAFE_PRIVATE_FILE' || error.code === 'ELOOP') fail('UNSAFE_PRIVATE_FILE');
    fail('INVALID_PRIVATE_JSON');
  } finally { await file?.close(); }
}
async function inspectFile(file) {
  const before = await file.stat({bigint:true});
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FILE');
  const hash = createHash('sha256');
  for await (const chunk of file.createReadStream({start:0,autoClose:false,highWaterMark:65536})) hash.update(chunk);
  const after = await file.stat({bigint:true});
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('FILE_CHANGED');
  return {size_bytes:Number(after.size),sha256:hash.digest('hex')};
}
function validMetadata(metadata) {
  return metadata && typeof metadata.operation_id === 'string' && metadata.operation_id.length > 0 && metadata.operation_id.length <= 128 &&
    typeof metadata.filename === 'string' && metadata.filename.length > 0 && !/[\x00-\x1f\x7f]/.test(metadata.filename) &&
    typeof metadata.content_type === 'string' && /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/.test(metadata.content_type) &&
    Number.isSafeInteger(metadata.size_bytes) && metadata.size_bytes >= 0 && /^[a-f0-9]{64}$/.test(metadata.sha256) &&
    Buffer.byteLength(JSON.stringify(metadata)) <= 16384;
}

export async function prepareUpload({file,origin,stateFile,contentType,filename,title,description,tags}) {
  origin = normalizeOrigin(origin);
  if (!file || !stateFile) fail('INVALID_ARGUMENTS');
  const source = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let metadata;
  try {
    metadata = {operation_id:randomUUID(),filename:filename ?? path.basename(file),content_type:contentType,...await inspectFile(source)};
  } finally { await source.close(); }
  for (const [key,value] of Object.entries({title,description,tags})) if (value !== undefined) metadata[key] = value;
  if (!validMetadata(metadata)) fail('INVALID_METADATA');
  let output;
  try { output = await open(stateFile,'wx',0o600); }
  catch(error) { if(error.code==='EEXIST') fail('STATE_EXISTS'); throw error; }
  try {
    await output.writeFile(JSON.stringify({version:1,origin,file:path.resolve(file),metadata},null,2)+'\n');
    await output.sync();
  } finally { await output.close(); }
  return {operation_id:metadata.operation_id,size_bytes:metadata.size_bytes,sha256:metadata.sha256,state_file:path.resolve(stateFile)};
}

export async function sendUpload({stateFile,sessionFile}, fetch = globalThis.fetch) {
  const state = await privateJson(stateFile);
  if (state?.version !== 1 || typeof state.file !== 'string' || !path.isAbsolute(state.file) || !validMetadata(state.metadata) || normalizeOrigin(state.origin) !== state.origin) fail('INVALID_STATE');
  const source = await open(state.file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const fingerprint = await inspectFile(source);
    if (fingerprint.size_bytes !== state.metadata.size_bytes || fingerprint.sha256 !== state.metadata.sha256) fail('FILE_CHANGED');
    const session = await privateJson(sessionFile);
    if (!session || typeof session.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.token) || !Number.isSafeInteger(session.expires_at) || session.upload?.method !== 'POST') fail('INVALID_SESSION');
    if (session.expires_at <= Math.floor(Date.now()/1000)) fail('SESSION_EXPIRED');
    let url;
    try { url = new URL(session.upload.url); } catch { fail('INVALID_SESSION'); }
    if (url.origin !== state.origin || url.username || url.password || url.hash) fail('SESSION_ORIGIN_MISMATCH');
    const boundary = 'cf-share-'+randomUUID();
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(state.metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const length = prefix.length+state.metadata.size_bytes+suffix.length;
    if (!Number.isSafeInteger(length)) fail('INVALID_FILE');
    async function* body() {
      yield prefix;
      if (state.metadata.size_bytes) yield* source.createReadStream({start:0,end:state.metadata.size_bytes-1,autoClose:false,highWaterMark:65536});
      yield suffix;
    }
    const result = {operation_id:state.metadata.operation_id,outcome:'unknown'};
    let response;
    try {
      response = await fetch(url.href,{method:'POST',redirect:'manual',duplex:'half',headers:{authorization:`Bearer ${session.token}`,'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(length)},body:body()});
    } catch { return {exitCode:2,result}; }
    result.http_status = response.status;
    // Never print provider bodies: even failures or unexpected JSON can echo credentials.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return {exitCode:1,result:{...result,outcome:'rejected',error:'REDIRECT_REFUSED'}};
    }
    let data;
    try {
      const chunks=[];let size=0;
      if(response.body) for await(const chunk of response.body) {
        size+=chunk.length;if(size>256*1024) throw new Error('response too large');chunks.push(chunk);
      }
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      const rejected = response.status >= 400 && response.status < 500 && ![409,422].includes(response.status);
      return {exitCode:rejected ? 1 : 2,result:{...result,outcome:rejected ? 'rejected' : 'unknown'}};
    }
    if (typeof data?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.error.code) && !data.error.code.includes(session.token)) result.error=data.error.code;
    if (typeof data?.resource?.id === 'string' && /^[A-Za-z0-9]{12}$/.test(data.resource.id)) {
      result.resource_id = data.resource.id;
      if (['published','pending','deleted'].includes(data.resource.state)) result.resource_state=data.resource.state;
    }
    if ((response.status===200 || response.status===201) && result.resource_state==='published') {
      return {exitCode:0,result:{...result,outcome:'published',url:state.origin+'/r/'+result.resource_id}};
    }
    if (result.resource_state==='deleted') return {exitCode:1,result:{...result,outcome:'deleted'}};
    if (response.status===202 || response.status===409 || response.status===422) return {exitCode:2,result:{...result,outcome:'pending'}};
    if (response.status>=400 && response.status<500) return {exitCode:1,result:{...result,outcome:'rejected'}};
    return {exitCode:2,result};
  } finally { await source.close(); }
}

const help = `Node.js 22+; no npm install required.
prepare --file PATH --origin HTTPS_ORIGIN --state-file NEW_JSON --content-type MIME
        [--filename NAME] [--title TEXT] [--description TEXT] [--tag TAG ...]
send    --state-file JSON --session-file PRIVATE_JSON

prepare saves a new operation_id and file digest; it never overwrites a state file.
send reads the session.create structured result, rechecks the file, and sends once.
HTTPS required except loopback HTTP for local development. No redirects or automatic retries.
Exit 0: published/prepared; 1: invalid input/rejected/deleted; 2: query operation.get.
Reuse the same state after checking MCP recovery status. Never pass a Token as an argument.
`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{help:{type:'boolean'},file:{type:'string'},origin:{type:'string'},'state-file':{type:'string'},'session-file':{type:'string'},'content-type':{type:'string'},filename:{type:'string'},title:{type:'string'},description:{type:'string'},tag:{type:'string',multiple:true}}});
    if(values.help) console.log(help);
    else {
      const command=positionals[0];
      const allowed=command==='prepare'?['file','origin','state-file','content-type','filename','title','description','tag']:['state-file','session-file'];
      if(positionals.length!==1 || !['prepare','send'].includes(command) || Object.keys(values).some(key=>!allowed.includes(key)) || !values['state-file']) fail('INVALID_ARGUMENTS');
      if(command==='prepare') {
        const result=await prepareUpload({file:values.file,origin:values.origin,stateFile:values['state-file'],contentType:values['content-type'],filename:values.filename,title:values.title,description:values.description,tags:values.tag});
        console.log(JSON.stringify(result));
      } else {
        if(!values['session-file']) fail('INVALID_ARGUMENTS');
        const {exitCode,result}=await sendUpload({stateFile:values['state-file'],sessionFile:values['session-file']});
        console.log(JSON.stringify(result));process.exitCode=exitCode;
      }
    }
  } catch(error) {
    // parseArgs and native I/O errors may include argument values; print only our codes.
    const safe=['INVALID_ARGUMENTS','INVALID_ORIGIN','INVALID_FILE','INVALID_METADATA','INVALID_STATE','INVALID_SESSION','INVALID_PRIVATE_JSON','UNSAFE_PRIVATE_FILE','STATE_EXISTS','FILE_CHANGED','SESSION_EXPIRED','SESSION_ORIGIN_MISMATCH'];
    console.error(JSON.stringify({error:safe.includes(error.code)?error.code:'LOCAL_ERROR',hint:'Use --help; no upload is retried automatically.'}));process.exitCode=1;
  }
}
