// worker-build emits this Wasm glue at build time without TypeScript declarations.
// The test fixtures only wrap its constructor and fetch method.
interface TestWorkerEnv {
  DB: D1Database;
  MAPPINGS: KVNamespace;
  FILES: R2Bucket;
  FAULTS: Fetcher;
  ANALYTICS: Pick<AnalyticsEngineDataset, 'writeDataPoint'>;
  MAX_FILE_BYTES?: string;
  TOTAL_STORAGE_BYTES?: string;
}
declare module '*build/index.js' {
  export default class Worker {
    constructor(ctx: ExecutionContext, env: TestWorkerEnv);
    fetch(request: Request): Promise<Response>;
  }
}
