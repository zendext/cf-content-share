import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

test('R2 create-only condition is checked when an open stream commits', async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'fence',
          modules: true,
          script: stripTypeScriptTypes(
            await readFile('tests/r2-fencing-fixture.mts', 'utf8'),
          ),
          r2Buckets: ['FILES'],
          compatibilityDate: '2026-10-11',
        },
      ],
    }),
  );
  try {
    const result = (await (
      await mf.dispatchFetch('https://test.test/')
    ).json()) as { fence: boolean; writer: boolean; size: number };
    console.log(result);
    assert.equal(result.fence, true);
    assert.equal(result.writer, false);
    assert.equal(result.size, 0);
  } finally {
    await mf.dispose();
  }
});
