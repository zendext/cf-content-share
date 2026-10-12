export default {async fetch(req: Request,env: { FILES: R2Bucket }){
 const {readable,writable}=new FixedLengthStream(2);
 const writer=writable.getWriter();
 const writing=env.FILES.put('race',readable,{onlyIf:{etagDoesNotMatch:'*'}});
 await writer.write(new Uint8Array([1]));
 const fence=await env.FILES.put('race','',{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{fence:'yes'}});
 await writer.write(new Uint8Array([2])); await writer.close();
 const result=await writing; const head=await env.FILES.head('race');
 return Response.json({fence:!!fence,writer:!!result,size:head!.size,metadata:head!.customMetadata});
}};
