import type { Heartbeat } from './test-contracts.mts';

// Local workerd boundary fault injection only; never included in Wrangler's production entrypoint.
let wasmMemory: WebAssembly.Memory;
const NativeInstance = WebAssembly.Instance;
WebAssembly.Instance = class extends NativeInstance {
  constructor(...args: ConstructorParameters<typeof NativeInstance>) {
    super(...args);
    wasmMemory = this.exports.memory as WebAssembly.Memory;
  }
};
const { default: Worker } = await import('../build/index.js');
let faults: Fetcher;
const cachePrototype = Object.getPrototypeOf(caches.default) as Record<
  'match' | 'put',
  (
    this: Cache,
    key: RequestInfo,
    response?: Response,
  ) => Promise<Response | void>
>;
for (const name of ['match', 'put'] as const) {
  const original = cachePrototype[name];
  cachePrototype[name] = async function (
    this: Cache,
    ...args: [RequestInfo, Response?]
  ) {
    const response = await faults.fetch(`https://faults.test/cache-${name}`, {
      method: 'POST',
      body: JSON.stringify({
        url: typeof args[0] === 'string' ? args[0] : args[0].url,
        status: args[1]?.status,
        cacheControl: args[1]?.headers?.get('cache-control'),
      }),
    });
    if (!response.ok) throw new Error('cache failure');
    const result = await original.apply(this, args);
    if (name === 'put')
      await faults.fetch('https://faults.test/cache-stored', {
        method: 'POST',
        body: JSON.stringify({
          url: typeof args[0] === 'string' ? args[0] : args[0].url,
        }),
      });
    return result;
  };
}
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const heartbeatTimers = new Map<number, true | number>();
let heartbeatSequence = 1000000;
globalThis.setTimeout = (
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) => {
  if (ms !== 30000 || !faults) return nativeSetTimeout(callback, ms, ...args);
  const id = heartbeatSequence++;
  heartbeatTimers.set(id, true);
  faults
    .fetch('https://faults.test/heartbeat')
    .then((r) => r.json<Heartbeat>())
    .then((control) => {
      if (!heartbeatTimers.has(id)) return;
      if (control.tick) {
        offset = control.offset!;
        heartbeatTimers.delete(id);
        callback(...args);
      } else {
        const timer = nativeSetTimeout(() => {
          if (heartbeatTimers.has(id)) {
            heartbeatTimers.delete(id);
            callback(...args);
          }
        }, ms);
        heartbeatTimers.set(id, timer);
      }
    });
  return id;
};
globalThis.clearTimeout = (id) => {
  if (id === null) return nativeClearTimeout(id);
  if (heartbeatTimers.has(id)) {
    const timer = heartbeatTimers.get(id);
    heartbeatTimers.delete(id);
    if (timer !== true) nativeClearTimeout(timer!);
  } else nativeClearTimeout(id);
};
const NativeDate = Date;
let offset = 0;
globalThis.Date = class extends NativeDate {
  constructor(...args: [] | [string | number] | [number, number, ...number[]]) {
    super(
      ...((args.length ? args : [NativeDate.now() + offset]) as [
        number,
        number,
      ]),
    );
  }
  static now() {
    return NativeDate.now() + offset;
  }
} as DateConstructor;

export default class extends Worker {
  declare testEnv: TestWorkerEnv;
  declare faults: Fetcher;
  constructor(ctx: ExecutionContext, env: TestWorkerEnv) {
    const mappings = new Proxy(env.MAPPINGS, {
      get(target, key) {
        if (key === 'put')
          return async (...args: Parameters<KVNamespace['put']>) => {
            const response = await env.FAULTS.fetch(
              'https://faults.test/kv-put',
              { method: 'POST', body: String(args[1]) },
            );
            if (!response.ok)
              throw new Error('injected KV fault: secret-must-not-leak');
            offset = (await response.json<{ offset: number }>()).offset;
            return target.put(...args);
          };
        if (key === 'get')
          return async (...args: Parameters<KVNamespace['get']>) => {
            const response = await env.FAULTS.fetch(
              'https://faults.test/kv-get',
            );
            if (!response.ok) throw new Error('injected KV read fault');
            return target.get(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const files = new Proxy(env.FILES, {
      get(target, key) {
        if (key === 'constructor') return target.constructor;
        if (key === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            const response = await env.FAULTS.fetch(
              'https://faults.test/r2-put',
              {
                method: 'POST',
                body: JSON.stringify({ key: args[0], options: args[2] }),
              },
            );
            if (!response.ok) throw new Error('injected R2 put failure');
            const result = await target.put(...args);
            await env.FAULTS.fetch('https://faults.test/r2-stored', {
              method: 'POST',
              body: JSON.stringify({
                key: args[0],
                options: args[2],
                memory: wasmMemory.buffer.byteLength,
                stored: !!result,
              }),
            });
            return result;
          };
        if (key === 'get')
          return async (...args: Parameters<R2Bucket['get']>) => {
            const response = await env.FAULTS.fetch(
              'https://faults.test/r2-get',
            );
            if (!response.ok) throw new Error('R2 unavailable');
            return target.get(...args);
          };
        if (key === 'delete')
          return async (...args: Parameters<R2Bucket['delete']>) => {
            const response = await env.FAULTS.fetch(
              'https://faults.test/r2-delete',
              { method: 'POST', body: JSON.stringify({ key: args[0] }) },
            );
            if (!response.ok) throw new Error('injected delete failure');
            return target.delete(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const statements = new WeakMap<
      D1PreparedStatement,
      { statement: D1PreparedStatement; sql: string }
    >();
    const signal = async (
      phase: string,
      sql: string,
      bindings: unknown[] = [],
    ) => {
      const response = await env.FAULTS.fetch(
        `https://faults.test/d1-${phase}`,
        {
          method: 'POST',
          body: JSON.stringify({
            sql: sql.replace(/\s+/g, ' ').trim().replace(/,\s+/g, ','),
            bindings,
          }),
        },
      );
      if (!response.ok) throw new Error('injected D1 failure');
      offset = (await response.json<{ offset: number }>()).offset;
    };
    const wrap = (
      statement: D1PreparedStatement,
      sql: string,
      bindings: unknown[] = [],
    ): D1PreparedStatement => {
      const wrapped = new Proxy(statement, {
        get(target, key) {
          if (key === 'constructor') return target.constructor;
          if (key === 'bind')
            return (...args: unknown[]) =>
              wrap(target.bind(...args), sql, args);
          if (
            typeof key === 'string' &&
            ['first', 'all', 'run', 'raw'].includes(key)
          )
            return async (...args: unknown[]) => {
              await signal('before', sql, bindings);
              const result = await Reflect.apply(
                Reflect.get(target, key),
                target,
                args,
              );
              await signal('after', sql, bindings);
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      statements.set(wrapped, { statement, sql });
      return wrapped;
    };
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'constructor') return target.constructor;
        if (key === 'prepare')
          return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === 'batch')
          return async (entries: D1PreparedStatement[]) => {
            await signal(
              'batch',
              entries.map((entry) => statements.get(entry)!.sql).join(';'),
            );
            return target.batch(
              entries.map((entry) => statements.get(entry)!.statement),
            );
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const wrapped = { ...env, DB: database, MAPPINGS: mappings, FILES: files };
    super(ctx, wrapped);
    this.testEnv = wrapped;
    faults = env.FAULTS;
    this.faults = env.FAULTS;
  }
  async fetch(request: Request) {
    const control = await (
      await this.faults.fetch('https://faults.test/request')
    ).json<{
      offset: number;
      limits?: Record<string, number>;
      collide: boolean;
    }>();
    offset = control.offset;
    for (const name of ['TOTAL_STORAGE_BYTES', 'MAX_FILE_BYTES'] as const) {
      if (control.limits?.[name] !== undefined)
        this.testEnv[name] = String(control.limits[name]);
      else delete this.testEnv[name];
    }
    const { collide } = control;
    if (!collide) return super.fetch(request);
    const random = crypto.getRandomValues.bind(crypto);
    let remaining = 1;
    crypto.getRandomValues = (bytes) =>
      'length' in bytes && bytes.length === 24 && remaining-- > 0
        ? ((bytes as unknown as Uint8Array).fill(0) as typeof bytes)
        : random(bytes);
    try {
      return await super.fetch(request);
    } finally {
      crypto.getRandomValues = random;
    }
  }
}
