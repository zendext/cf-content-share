import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
test('R2 create-only condition is checked when an open stream commits', async () => {
 const mf = new Miniflare(convertV4MiniflareOptions({workers:[{name:'fence',modules:true,script:`export default {async fetch(req,env){
 const {readable,writable}=new FixedLengthStream(2);
 const writer=writable.getWriter();
 const writing=env.FILES.put('race',readable,{onlyIf:{etagDoesNotMatch:'*'}});
 await writer.write(new Uint8Array([1]));
 const fence=await env.FILES.put('race','',{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{fence:'yes'}});
 await writer.write(new Uint8Array([2])); await writer.close();
 const result=await writing; const head=await env.FILES.head('race');
 return Response.json({fence:!!fence,writer:!!result,size:head.size,metadata:head.customMetadata});
}}`,r2Buckets:['FILES'],compatibilityDate:'2026-10-11'}]}));
 try {const result=await (await mf.dispatchFetch('https://test.test/')).json();console.log(result);assert.equal(result.fence,true);assert.equal(result.writer,false);assert.equal(result.size,0);} finally {await mf.dispose();}
});
