import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLgpl,
  checkWasmDist,
  installWasmDist,
  parseSha256Sums,
  parseVersions,
  SOURCES_ASSET,
  wasmReleaseTag,
  wasmTreeHash,
} from './wasm.ts';

describe('wasm/ 的 tree hash 與 Release tag', () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kikoeru-wasm-test-'));
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    write('.gitignore', 'wasm/dist/\n');
    write('wasm/versions.env', '# 註解\nLIBAVJS_VERSION=6.10.9.0\nVARIANT=kikoeru\n');
    write('wasm/build.sh', 'echo build\n');
    write('src/index.ts', 'export {};\n');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'init');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('沒有修改時等於 git rev-parse HEAD:wasm', () => {
    expect(wasmTreeHash(root)).toBe(git('rev-parse', 'HEAD:wasm'));
  });

  it('包含尚未 commit 的修改與新檔案', () => {
    const committed = wasmTreeHash(root);
    write('wasm/build.sh', 'echo changed\n');
    const modified = wasmTreeHash(root);
    expect(modified).not.toBe(committed);
    write('wasm/new.patch', 'patch\n');
    expect(wasmTreeHash(root)).not.toBe(modified);
  });

  it('不受 gitignored 的 wasm/dist/ 與 wasm/ 以外的修改影響', () => {
    const before = wasmTreeHash(root);
    write('wasm/dist/libav.wasm', 'binary');
    write('src/index.ts', 'export const x = 1;\n');
    expect(wasmTreeHash(root)).toBe(before);
  });

  it('不改動 repo 的 index', () => {
    write('wasm/build.sh', 'echo changed\n');
    wasmTreeHash(root);
    expect(git('diff', '--cached', '--name-only')).toBe('');
  });

  it('tag 是 ffmpeg-wasm-<libav.js 版本>-<tree hash 前 8 碼>', () => {
    expect(wasmReleaseTag(root)).toBe(
      `ffmpeg-wasm-6.10.9.0-${git('rev-parse', 'HEAD:wasm').slice(0, 8)}`,
    );
  });

  describe('checkWasmDist', () => {
    it('沒有 wasm/dist/ 時提示 pnpm wasm:fetch', () => {
      expect(checkWasmDist(root)).toMatch(/pnpm wasm:fetch/);
    });

    it('wasm/dist/ 的 stamp 符合目前的 tag 時通過', () => {
      write('wasm/dist/.stamp', `${wasmReleaseTag(root)}\n`);
      expect(checkWasmDist(root)).toBeUndefined();
    });

    it('installWasmDist 之後通過；不放進 sources.tar，也清掉舊的檔案', () => {
      write('wasm/dist/old.wasm', 'old');
      write('release/libav.wasm', 'wasm');
      write('release/NOTICE', 'notice');
      write(`release/${SOURCES_ASSET}`, 'sources');
      installWasmDist(root, join(root, 'release'), wasmReleaseTag(root));
      expect(readdirSync(join(root, 'wasm/dist')).sort()).toEqual([
        '.stamp',
        'NOTICE',
        'libav.wasm',
      ]);
      expect(checkWasmDist(root)).toBeUndefined();
    });

    it('改動 wasm/ 任一檔案後失敗並提示指令', () => {
      write('wasm/dist/.stamp', `${wasmReleaseTag(root)}\n`);
      write('wasm/versions.env', 'LIBAVJS_VERSION=6.10.9.0\nVARIANT=kikoeru\n');
      const message = checkWasmDist(root);
      expect(message).toMatch(/pnpm wasm:fetch/);
      expect(message).toMatch(/pnpm wasm:build/);
    });
  });
});

describe('parseVersions', () => {
  it('讀取 KEY=VALUE，略過註解與空行', () => {
    expect(parseVersions('# x=1\n\nA=1\nB=two words\n')).toEqual({ A: '1', B: 'two words' });
  });

  it('不是 KEY=VALUE 的行視為錯誤', () => {
    expect(() => parseVersions('A=1\nnot a pair\n')).toThrow(/not a pair/);
  });
});

describe('parseSha256Sums', () => {
  const hash = 'a'.repeat(64);

  it('讀取 sha256sum 的輸出', () => {
    expect(parseSha256Sums(`${hash}  NOTICE\n${'b'.repeat(64)}  libav.wasm\n`)).toEqual([
      { file: 'NOTICE', sha256: hash },
      { file: 'libav.wasm', sha256: 'b'.repeat(64) },
    ]);
  });

  it('不接受含路徑的檔名與格式錯誤的行', () => {
    expect(() => parseSha256Sums(`${hash}  ../NOTICE\n`)).toThrow();
    expect(() => parseSha256Sums('xyz  NOTICE\n')).toThrow();
  });
});

describe('checkLgpl', () => {
  /** FFmpeg configure 產生的 config.h 中，與授權有關的幾行（其餘省略）。 */
  const configH = ({
    gpl = '0',
    nonfree = '0',
    version3 = '0',
    license = 'LGPL version 2.1 or later',
  } = {}) =>
    [
      '#define FFMPEG_CONFIGURATION "--target-os=none --enable-cross-compile"',
      `#define FFMPEG_LICENSE "${license}"`,
      '#define CONFIG_THIS_IS_NOT_RELEVANT 1',
      `#define CONFIG_GPL ${gpl}`,
      `#define CONFIG_NONFREE ${nonfree}`,
      `#define CONFIG_VERSION3 ${version3}`,
      '',
    ].join('\n');

  it('LGPL-2.1-or-later 的 build 通過', () => {
    expect(checkLgpl(configH())).toEqual([]);
  });

  it('啟用 GPL 元件（--enable-gpl）時失敗', () => {
    const problems = checkLgpl(configH({ gpl: '1', license: 'GPL version 2 or later' }));
    expect(problems).toContain('CONFIG_GPL 為 1');
    expect(problems.some((p) => p.includes('GPL version 2 or later'))).toBe(true);
  });

  it('啟用 nonfree 元件時失敗', () => {
    expect(
      checkLgpl(configH({ nonfree: '1', license: 'nonfree and unredistributable' })),
    ).toContain('CONFIG_NONFREE 為 1');
  });

  it('啟用 version3（LGPL-3）時失敗', () => {
    expect(checkLgpl(configH({ version3: '1', license: 'LGPL version 3 or later' }))).toContain(
      'CONFIG_VERSION3 為 1',
    );
  });

  it('找不到授權的 define 時失敗，不當成通過', () => {
    expect(checkLgpl('')).toHaveLength(4);
  });
});
