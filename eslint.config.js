// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import boundariesModule from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 依賴規則見 docs/architecture.md「依賴規則」，硬性約束見 AGENTS.md。

// eslint-plugin-boundaries 是 CommonJS，runtime 的 default 就是 plugin；它的 d.ts 在 nodenext 下會被當成整個 module。
const boundaries = /** @type {import('eslint').ESLint.Plugin} */ (
  /** @type {unknown} */ (boundariesModule)
);

/** 只有 type 的 import／export，用於 worklet/ 與 protocol/（硬性約束第 7 條）。 */
const typeOnlyImports = [
  {
    selector: ':matches(ImportDeclaration, TSImportEqualsDeclaration)[importKind="value"]',
    message: '這裡只能使用 import type。',
  },
  {
    selector: 'ExportNamedDeclaration[source][exportKind="value"]',
    message: '這裡只能使用 export type … from。',
  },
  {
    selector: 'ExportAllDeclaration[exportKind="value"]',
    message: '這裡只能使用 export type * from。',
  },
  {
    selector: 'ImportExpression',
    message: '這裡不能使用動態 import。',
  },
];

/** protocol/ 只放 type，不宣告任何 runtime 值。 */
const typeOnlyDeclarations = {
  selector: [
    ':matches(Program, ExportNamedDeclaration) > ',
    ':matches(VariableDeclaration, FunctionDeclaration, ClassDeclaration, TSEnumDeclaration, TSModuleDeclaration, ExpressionStatement)',
    ', ExportDefaultDeclaration',
  ].join(''),
  message: 'protocol/ 只能宣告 type 與 interface。',
};

/**
 * Worker 只能以字面寫法建立（硬性約束第 6 條）：
 * `new Worker(new URL('./….js', import.meta.url), { type: 'module' })`。
 * 路徑必須是 `./` 或 `../` 開頭、`.js` 結尾的字串字面值（例如主執行緒的 `'../worker/index.js'`）。
 */
const literalWorker = [
  {
    selector: [
      'NewExpression[callee.name="Worker"]:not(',
      '[arguments.length=2]',
      '[arguments.0.type="NewExpression"]',
      '[arguments.0.callee.name="URL"]',
      '[arguments.0.arguments.length=2]',
      '[arguments.0.arguments.0.type="Literal"]',
      String.raw`[arguments.0.arguments.0.value=/^\.\.?\/.*\.js$/]`,
      '[arguments.0.arguments.1.type="MemberExpression"]',
      '[arguments.0.arguments.1.object.type="MetaProperty"]',
      '[arguments.0.arguments.1.object.meta.name="import"]',
      '[arguments.0.arguments.1.property.name="url"]',
      '[arguments.1.type="ObjectExpression"]',
      '[arguments.1.properties.length=1]',
      '[arguments.1.properties.0.computed=false]',
      '[arguments.1.properties.0.key.name="type"]',
      '[arguments.1.properties.0.value.value="module"]',
      ')',
    ].join(''),
    message:
      "Worker 只能寫成 new Worker(new URL('./….js', import.meta.url), { type: 'module' })，App 的 Vite 才能辨識。",
  },
  {
    selector: 'NewExpression > MemberExpression.callee[property.name="Worker"]',
    message: 'Worker 只能以全域的 Worker 建立，不能寫成 globalThis.Worker 之類的屬性存取。',
  },
];

/**
 * @param {string} rootDir 套件根目錄；依賴規則的路徑都相對於它。lint fixture 測試以 fixture 目錄呼叫。
 */
export function createConfig(rootDir) {
  return defineConfig(
    globalIgnores(['dist/', 'coverage/', '.claude/', 'test/lint/fixtures/']),
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: rootDir,
        },
      },
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/consistent-type-exports': 'error',
        'no-restricted-syntax': ['error', ...literalWorker],
      },
    },
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      files: ['*.config.{js,ts}', 'scripts/**'],
      languageOptions: { globals: globals.node },
    },
    {
      files: ['src/worklet/**'],
      ignores: ['**/*.test.ts'],
      rules: {
        'no-restricted-syntax': ['error', ...literalWorker, ...typeOnlyImports],
      },
    },
    {
      files: ['src/protocol/**'],
      ignores: ['**/*.test.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          ...literalWorker,
          ...typeOnlyImports,
          typeOnlyDeclarations,
        ],
      },
    },
    {
      files: ['src/**', 'test/**', 'demo/**'],
      plugins: { boundaries },
      settings: {
        'boundaries/root-path': rootDir,
        // 由 eslint-import-resolver-typescript 把 import 的 './x.js' 對應回 './x.ts'。
        'import/resolver': { typescript: { project: `${rootDir}/tsconfig.json` } },
        // 每個檔案只取第一個符合的 descriptor；最後的 src 只會配到 src/index.ts。
        'boundaries/elements-single-match': true,
        'boundaries/elements': [
          { type: 'main', pattern: 'src/main', partialMatch: false },
          { type: 'worker', pattern: 'src/worker', partialMatch: false },
          { type: 'worklet', pattern: 'src/worklet', partialMatch: false },
          { type: 'protocol', pattern: 'src/protocol', partialMatch: false },
          { type: 'background', pattern: 'src/background', partialMatch: false },
          { type: 'fakes', pattern: 'test/fakes', partialMatch: false },
          { type: 'demo', pattern: 'demo', partialMatch: false },
          { type: 'index', pattern: 'src', partialMatch: false },
        ],
        'boundaries/files': [{ category: 'test', pattern: '**/*.test.ts' }],
      },
      rules: {
        'boundaries/dependencies': [
          'error',
          {
            default: 'disallow',
            policies: [
              {
                from: { element: { type: 'index' } },
                allow: { to: { element: { types: ['main', 'protocol'] } } },
              },
              {
                from: { element: { type: 'main' } },
                allow: { to: { element: { types: ['main', 'protocol'] } } },
              },
              {
                from: { element: { type: 'worker' } },
                allow: { to: { element: { types: ['worker', 'protocol'] } } },
              },
              {
                from: { element: { types: ['worklet', 'protocol'] } },
                allow: { to: { element: { type: 'protocol' } }, dependency: { kind: 'type' } },
              },
              {
                from: { element: { type: 'background' } },
                allow: { to: { element: { types: ['index', 'background'] } } },
              },
              {
                from: { element: { type: 'fakes' } },
                allow: { to: { element: { types: ['fakes', 'protocol'] } } },
              },
              {
                from: { element: { type: 'demo' } },
                allow: { to: { element: { types: ['index', 'background', 'demo'] } } },
              },
              // 測試檔可以 import 任何元素；test/fakes/ 只有測試檔可以 import。
              { from: { file: { categories: 'test' } }, allow: { to: { element: { type: '*' } } } },
            ],
          },
        ],
      },
    },
    prettier,
  );
}

export default createConfig(import.meta.dirname);
