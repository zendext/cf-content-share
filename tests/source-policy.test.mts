import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Include new, untracked sources while excluding ignored build outputs/dependencies.
test('maintained repository sources contain no JavaScript files', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  const javascript = files.filter(file => /\.(?:[cm]?js|jsx)$/.test(file) && existsSync(path.join(root, file)));
  assert.deepEqual(javascript, [], 'Migrate maintained JavaScript to strictly checked TypeScript; generated output belongs in ignored build directories.');
});
