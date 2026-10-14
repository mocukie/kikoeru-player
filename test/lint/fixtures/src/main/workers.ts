const url = new URL('./worker.js', import.meta.url);
const options = { type: 'module' } as const;

export const workers = [
  new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
  new Worker(url, { type: 'module' }),
  new Worker(new URL('./worker.js', import.meta.url)),
  new Worker(new URL(`./worker.js`, import.meta.url), { type: 'module' }),
  new Worker(new URL('./worker.js', location.href), { type: 'module' }),
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  new Worker(new URL('worker.js', import.meta.url), { type: 'module' }),
  new Worker('./worker.js', { type: 'module' }),
  new Worker(new URL('./worker.js', import.meta.url), options),
  new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'media' }),
  new Worker(new URL('/worker.js', import.meta.url), { type: 'module' }),
  new globalThis.Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
];
