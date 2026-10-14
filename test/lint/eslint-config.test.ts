import { ESLint } from 'eslint';
import { relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createConfig } from '../../eslint.config.js';

// 以 fixtures/ 為根目錄套用真正的 ESLint 設定，固定依賴規則與 Worker 寫法的規則。
// fixtures/ 模仿套件的目錄結構；每個檔案的預期違規列在下方。

const fixtureRoot = `${import.meta.dirname}/fixtures`;

interface Violation {
  ruleId: string | null;
  line: number;
}

let violations: Map<string, Violation[]>;

beforeAll(async () => {
  const eslint = new ESLint({
    cwd: fixtureRoot,
    overrideConfigFile: true,
    overrideConfig: createConfig(fixtureRoot),
  });
  const results = await eslint.lintFiles(['.']);
  violations = new Map(
    results.map((result) => [
      relative(fixtureRoot, result.filePath),
      result.messages.map(({ ruleId, line }) => ({ ruleId, line })),
    ]),
  );
}, 60_000);

function violationsOf(file: string): Violation[] {
  const found = violations.get(file);
  if (!found) throw new Error(`沒有 lint 到 ${file}`);
  return found;
}

const boundary = { ruleId: 'boundaries/dependencies', line: 1 };
const restricted = (line: number) => ({ ruleId: 'no-restricted-syntax', line });

describe('依賴規則', () => {
  it.each([
    'src/index.ts',
    'src/main/engine.ts',
    'src/worker/index.ts',
    'src/worklet/index.ts',
    'src/protocol/messages.ts',
    'src/background/index.ts',
    'test/fakes/fake-worker.ts',
    'src/main/engine.test.ts',
    'demo/main.ts',
  ])('%s 沒有違規', (file) => {
    expect(violationsOf(file)).toEqual([]);
  });

  it.each([
    ['src/index.ts 不能 import worker/', 'src/index-imports-worker.ts', [boundary]],
    ['main/ 不能 import worker/', 'src/main/imports-worker.ts', [boundary]],
    ['worker/ 不能 import main/', 'src/worker/imports-main.ts', [boundary]],
    ['只有測試檔可以 import test/fakes/', 'src/main/imports-fakes.ts', [boundary]],
    ['test/fakes/ 只能 import protocol/', 'test/fakes/imports-main.ts', [boundary]],
    ['background/ 不能 import main/', 'src/background/imports-main.ts', [boundary]],
    ['demo/ 不能 import main/', 'demo/imports-main.ts', [boundary]],
    [
      'worklet/ 不能 import runtime 值',
      'src/worklet/imports-runtime.ts',
      [restricted(1), boundary],
    ],
    [
      'worklet/ 不能 re-export runtime 值或動態 import',
      'src/worklet/reexports-runtime.ts',
      [restricted(1), restricted(2), restricted(3)],
    ],
    [
      'protocol/ 不能 import runtime 值',
      'src/protocol/imports-runtime.ts',
      [restricted(1), boundary],
    ],
    ['protocol/ 不能宣告 runtime 值', 'src/protocol/runtime-value.ts', [restricted(1)]],
  ])('%s', (_name, file, expected) => {
    expect(violationsOf(file)).toEqual(expected);
  });
});

describe('Worker 的寫法', () => {
  it('只接受字面寫法', () => {
    // 第 5 行是唯一合法的寫法，其餘每一行都是一種非字面寫法。
    expect(violationsOf('src/main/workers.ts')).toEqual(
      [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((line) => ({
        ruleId: 'no-restricted-syntax',
        line,
      })),
    );
  });
});
