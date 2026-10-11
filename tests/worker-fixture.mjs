// Local workerd boundary fault injection only; never included in Wrangler's production entrypoint.
let wasmMemory;
const NativeInstance=WebAssembly.Instance;
WebAssembly.Instance=class extends NativeInstance { constructor(...args){super(...args);wasmMemory=this.exports.memory;} };
const {default:Worker}=await import('../build/index.js');
let faults;
const cachePrototype=Object.getPrototypeOf(caches.default);
for(const name of ['match','put']){
 const original=cachePrototype[name];
 cachePrototype[name]=async function(...args){
  const response=await faults.fetch('https://faults.test/cache-'+name,{method:'POST',body:JSON.stringify({url:typeof args[0]==='string'?args[0]:args[0].url,status:args[1]?.status,cacheControl:args[1]?.headers?.get('cache-control')})});
  if(!response.ok)throw new Error('cache failure');
  const result=await original.apply(this,args);
  if(name==='put')await faults.fetch('https://faults.test/cache-stored',{method:'POST',body:JSON.stringify({url:typeof args[0]==='string'?args[0]:args[0].url})});
  return result;
 };
}
const nativeSetTimeout=globalThis.setTimeout;
const nativeClearTimeout=globalThis.clearTimeout;
const heartbeatTimers=new Map();let heartbeatSequence=1000000;
globalThis.setTimeout=(callback,ms,...args)=>{
 if(ms!==30000 || !faults)return nativeSetTimeout(callback,ms,...args);
 const id=heartbeatSequence++;
 heartbeatTimers.set(id,true);
 faults.fetch('https://faults.test/heartbeat').then(r=>r.json()).then(control=>{
  if(!heartbeatTimers.has(id))return;
  if(control.tick){offset=control.offset;heartbeatTimers.delete(id);callback(...args);}
  else {const timer=nativeSetTimeout(()=>{if(heartbeatTimers.has(id)){heartbeatTimers.delete(id);callback(...args);}},ms);heartbeatTimers.set(id,timer);}
 });
 return id;
};
globalThis.clearTimeout=id=>{if(heartbeatTimers.has(id)){const timer=heartbeatTimers.get(id);heartbeatTimers.delete(id);if(timer!==true)nativeClearTimeout(timer);}else nativeClearTimeout(id);};
const NativeDate = Date;
let offset = 0;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
  static now() { return NativeDate.now() + offset; }
};

export default class extends Worker {
  constructor(ctx, env) {
    const mappings = new Proxy(env.MAPPINGS, {
      get(target, key) {
        if (key === 'put') return async (...args) => {
          const response = await env.FAULTS.fetch('https://faults.test/kv-put', { method: 'POST', body: String(args[1]) });
          if (!response.ok) throw new Error('injected KV fault: secret-must-not-leak');
          offset = (await response.json()).offset;
          return target.put(...args);
        };
        if (key === 'get') return async (...args) => {
          const response = await env.FAULTS.fetch('https://faults.test/kv-get');
          if (!response.ok) throw new Error('injected KV read fault');
          return target.get(...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const files=new Proxy(env.FILES,{get(target,key){
      if(key==='constructor')return target.constructor;
      if(key==='put')return async (...args)=>{
        const response=await env.FAULTS.fetch('https://faults.test/r2-put',{method:'POST',body:JSON.stringify({key:args[0],options:args[2]})});
        if(!response.ok)throw new Error('injected R2 put failure');
        const result=await target.put(...args);
        await env.FAULTS.fetch('https://faults.test/r2-stored',{method:'POST',body:JSON.stringify({key:args[0],options:args[2],memory:wasmMemory.buffer.byteLength,stored:!!result})});
        return result;
      };
      if(key==='get')return async(...args)=>{const response=await env.FAULTS.fetch('https://faults.test/r2-get');if(!response.ok)throw new Error('R2 unavailable');return target.get(...args);};
      if(key==='delete')return async(...args)=>{const response=await env.FAULTS.fetch('https://faults.test/r2-delete',{method:'POST',body:JSON.stringify({key:args[0]})});if(!response.ok)throw new Error('injected delete failure');return target.delete(...args);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const wrapped={...env,MAPPINGS:mappings,FILES:files};
    super(ctx, wrapped);
    this.testEnv=wrapped;
    faults=env.FAULTS;
    this.faults = env.FAULTS;
  }
  async fetch(request) {
    const control = await (await this.faults.fetch('https://faults.test/request')).json();
    offset = control.offset;
    for(const name of ['TOTAL_STORAGE_BYTES','MAX_FILE_BYTES']){if(control.limits?.[name]!==undefined)this.testEnv[name]=String(control.limits[name]);else delete this.testEnv[name];}
    const { collide } = control;
    if (!collide) return super.fetch(request);
    const random = crypto.getRandomValues.bind(crypto);
    let remaining = 1;
    crypto.getRandomValues = bytes => bytes.length === 24 && remaining-- > 0 ? bytes.fill(0) : random(bytes);
    try { return await super.fetch(request); }
    finally { crypto.getRandomValues = random; }
  }
}
