// Local workerd boundary fault injection only; never included in Wrangler's production entrypoint.
import Worker from '../build/index.js';
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
    super(ctx, { ...env, MAPPINGS: mappings });
    this.faults = env.FAULTS;
  }
  async fetch(request) {
    const control = await (await this.faults.fetch('https://faults.test/request')).json();
    offset = control.offset;
    const { collide } = control;
    if (!collide) return super.fetch(request);
    const random = crypto.getRandomValues.bind(crypto);
    let remaining = 1;
    crypto.getRandomValues = bytes => bytes.length === 24 && remaining-- > 0 ? bytes.fill(0) : random(bytes);
    try { return await super.fetch(request); }
    finally { crypto.getRandomValues = random; }
  }
}
