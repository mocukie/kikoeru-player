import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPackFiles, checkReleaseTag, writePackageAssets } from './package.ts';

const TAG = 'ffmpeg-wasm-6.10.9.0-0123abcd';
const RELEASE_URL = `https://github.com/example/player/releases/tag/${TAG}`;

describe('writePackageAssets', () => {
  let root: string;
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

  const release: Record<string, string> = {
    'libav-6.10.9.0-kikoeru.wasm.wasm': '\0asm wasm',
    'libav-6.10.9.0-kikoeru.wasm.mjs': '/*! license header */\nglue();\n',
    'libav-6.10.9.0-kikoeru.mjs': 'frontend();\n',
    'libav.types.d.ts': 'export {};\n',
    'LGPL-2.1.txt': 'GNU LESSER GENERAL PUBLIC LICENSE\n',
    NOTICE: 'wasm notice\n',
    'sources.tar': 'tar',
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kikoeru-package-test-'));
    write(
      'package.json',
      JSON.stringify({ repository: { url: 'git+https://github.com/example/player.git' } }),
    );
    // wasm/dist/ 是 Release 中 sources.tar 以外的檔案；SHA256SUMS 列出全部。
    for (const [file, content] of Object.entries(release)) {
      if (file !== 'sources.tar') write(`wasm/dist/${file}`, content);
    }
    write(
      'wasm/dist/SHA256SUMS',
      Object.entries(release)
        .map(([file, content]) => `${sha256(content)}  ${file}\n`)
        .join(''),
    );
    // tsc 輸出的佔位模組。
    write('dist/main/third-party-notices.js', 'export const thirdPartyNotices = [];\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('把 wasm、glue 與 frontend 原封不動複製到 dist/wasm/，不含型別與 sources.tar', () => {
    writePackageAssets(root, TAG);
    const files = readdirSync(join(root, 'dist/wasm')).sort();
    expect(files).toEqual([
      'libav-6.10.9.0-kikoeru.mjs',
      'libav-6.10.9.0-kikoeru.wasm.mjs',
      'libav-6.10.9.0-kikoeru.wasm.wasm',
      'wasm.json',
    ]);
    for (const file of files.filter((f) => f.startsWith('libav-'))) {
      expect(read(`dist/wasm/${file}`)).toBe(release[file]);
    }
  });

  it('wasm.json 記錄 wasm Release 的 tag、網址與每個複本的 sha256', () => {
    writePackageAssets(root, TAG);
    expect(JSON.parse(read('dist/wasm/wasm.json'))).toEqual({
      tag: TAG,
      releaseUrl: RELEASE_URL,
      files: {
        'libav-6.10.9.0-kikoeru.mjs': sha256('frontend();\n'),
        'libav-6.10.9.0-kikoeru.wasm.mjs': sha256('/*! license header */\nglue();\n'),
        'libav-6.10.9.0-kikoeru.wasm.wasm': sha256('\0asm wasm'),
      },
    });
  });

  it('NOTICE 有 FFmpeg 的 LGPL 聲明與 wasm Release 的網址，LICENSES/ 有 LGPL 全文', () => {
    writePackageAssets(root, TAG);
    const notice = read('NOTICE');
    expect(notice).toContain('FFmpeg');
    expect(notice).toContain('LGPL-2.1-or-later');
    expect(notice).toContain(RELEASE_URL);
    expect(notice).toContain('LICENSES/LGPL-2.1.txt');
    expect(read('LICENSES/LGPL-2.1.txt')).toBe(release['LGPL-2.1.txt']);
  });

  it('thirdPartyNotices 寫入 wasm Release 的原始碼網址與 NOTICE 全文', async () => {
    writePackageAssets(root, TAG);
    const url = pathToFileURL(join(root, 'dist/main/third-party-notices.js')).href;
    const { thirdPartyNotices } = (await import(url)) as {
      thirdPartyNotices: readonly Record<string, string>[];
    };
    expect(thirdPartyNotices).toEqual([
      {
        name: 'FFmpeg',
        license: 'LGPL-2.1-or-later',
        sourceUrl: RELEASE_URL,
        noticeText: read('NOTICE'),
      },
    ]);
    expect(Object.isFrozen(thirdPartyNotices)).toBe(true);
    expect(Object.isFrozen(thirdPartyNotices[0])).toBe(true);
  });

  it('wasm/dist/ 的檔案與 SHA256SUMS 不符時失敗，不寫出任何檔案', () => {
    write('wasm/dist/libav-6.10.9.0-kikoeru.wasm.wasm', 'changed');
    expect(() => {
      writePackageAssets(root, TAG);
    }).toThrow(/libav-6\.10\.9\.0-kikoeru\.wasm\.wasm/);
    expect(() => readdirSync(join(root, 'dist/wasm'))).toThrow();
    expect(() => read('NOTICE')).toThrow();
  });

  it('tsc 沒有輸出 dist/main/third-party-notices.js 時失敗', () => {
    rmSync(join(root, 'dist/main/third-party-notices.js'));
    expect(() => {
      writePackageAssets(root, TAG);
    }).toThrow(/third-party-notices\.js/);
  });
});

describe('checkReleaseTag', () => {
  it('tag 是 v 加上 package.json 的版本時通過', () => {
    expect(checkReleaseTag('v0.1.0', '0.1.0')).toBeUndefined();
    expect(checkReleaseTag('v1.2.3-rc.1', '1.2.3-rc.1')).toBeUndefined();
  });

  it('tag 與版本不一致時回傳說明', () => {
    expect(checkReleaseTag('v0.1.1', '0.1.0')).toMatch(/v0\.1\.1.*0\.1\.0/);
    expect(checkReleaseTag('0.1.0', '0.1.0')).toMatch(/0\.1\.0/);
    expect(checkReleaseTag('v0.1.0', '0.0.0')).toMatch(/0\.0\.0/);
  });
});

describe('checkPackFiles', () => {
  const allowed = [
    'package.json',
    'README.md',
    'LICENSE',
    'NOTICE',
    'LICENSES/LGPL-2.1.txt',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/main/wasm.js',
    'dist/main/third-party-notices.js',
    'dist/worker/index.js',
    'dist/worklet/index.js',
    'dist/wasm/libav-6.10.9.0-kikoeru.wasm.wasm',
    'dist/wasm/libav-6.10.9.0-kikoeru.wasm.mjs',
    'dist/wasm/libav-6.10.9.0-kikoeru.mjs',
    'dist/wasm/wasm.json',
  ];

  it('只有 dist/、LICENSE、NOTICE、LICENSES/（與 npm 一定會放的 package.json、README）時通過', () => {
    expect(checkPackFiles(allowed)).toEqual([]);
  });

  it('列出不該在套件內的檔案', () => {
    expect(
      checkPackFiles([...allowed, 'src/index.ts', 'wasm/dist/sources.tar', 'sources/ffmpeg.c']),
    ).toEqual([
      '不該在套件內：src/index.ts',
      '不該在套件內：wasm/dist/sources.tar',
      '不該在套件內：sources/ffmpeg.c',
    ]);
  });

  it('dist/ 內也不能有 sources.tar 或 sources/', () => {
    expect(checkPackFiles([...allowed, 'dist/wasm/sources.tar', 'dist/sources/a.c'])).toEqual([
      '不該在套件內：dist/wasm/sources.tar',
      '不該在套件內：dist/sources/a.c',
    ]);
  });

  it('缺少必要的檔案時列出', () => {
    expect(
      checkPackFiles(allowed.filter((f) => f !== 'NOTICE' && !f.startsWith('dist/wasm/'))),
    ).toEqual([
      '套件缺少：NOTICE',
      '套件缺少：dist/wasm/wasm.json',
      '套件缺少：dist/wasm/libav-*.wasm',
    ]);
  });
});
