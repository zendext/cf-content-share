// Local workerd boundary instrumentation; never a production entrypoint.
import Worker from '../build/index.js';
let points = [];
const logs = [];
const originalError = console.error.bind(console);
console.error = (...args) => { logs.push(args.join(' ')); originalError(...args); };
let fail = false, failR2Get = false, failCacheDelete = false, r2Reads = 0;

// Wait for the actual platform cache write, without timing sleeps or faking a hit.
const stored = new Set(), cacheWaiters = new Map();
const cachePrototype = Object.getPrototypeOf(caches.default);
const nativePut = cachePrototype.put;
const nativeDelete = cachePrototype.delete;
cachePrototype.delete = async function(...args) {
  if (failCacheDelete) throw new Error('injected local cache eviction failure');
  return nativeDelete.apply(this, args);
};
cachePrototype.put = async function(key, response) {
  const result = await nativePut.call(this, key, response);
  const url = typeof key === 'string' ? key : key.url;
  stored.add(url);
  cacheWaiters.get(url)?.();
  cacheWaiters.delete(url);
  return result;
};

export default class extends Worker {
  constructor(ctx, env) {
    const files = new Proxy(env.FILES, {
      get(target, key) {
        if (key === 'constructor') return target.constructor;
        if (key === 'get') return async (...args) => {
          r2Reads++;
          if (failR2Get) throw new Error('injected R2 read failure');
          return target.get(...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, FILES: files, ANALYTICS: { writeDataPoint(point) {
      if (fail) throw new Error('secret-must-not-leak');
      points.push(point);
    } } });
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/test-logs') return Response.json(logs);
    if (url.pathname === '/test-points') {
      if (req.method === 'DELETE') points = [];
      return Response.json(points);
    }
    if (url.pathname === '/test-fail') {
      fail = url.searchParams.get('value') === '1';
      return new Response('ok');
    }
    if (url.pathname === '/test-r2') {
      if (url.searchParams.has('fail')) failR2Get = url.searchParams.get('fail') === '1';
      return Response.json({ reads: r2Reads });
    }
    if (url.pathname === '/test-cache-delete') {
      failCacheDelete = url.searchParams.get('fail') === '1';
      return new Response('ok');
    }
    if (url.pathname === '/test-cache-wait') {
      const key = url.searchParams.get('url');
      if (!stored.has(key)) await new Promise(resolve => cacheWaiters.set(key, resolve));
      return new Response('stored');
    }
    return super.fetch(req);
  }
}
