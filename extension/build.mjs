import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const root = import.meta.dirname;
const outDir = resolve(root, 'dist');

async function run() {
  // 1. Side panel + background service worker (ESM)
  await build({
    root,
    plugins: [vue()],
    publicDir: 'public',
    define: {
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
    },
    build: {
      outDir,
      emptyOutDir: true,
      watch: watch ? {} : null,
      rollupOptions: {
        input: {
          sidepanel: resolve(root, 'sidepanel.html'),
          background: resolve(root, 'src/background.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });

  // 2. Content script (self-contained IIFE so Chrome loads it without ESM chunk issues)
  await build({
    root,
    plugins: [vue()],
    publicDir: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
    },
    build: {
      outDir,
      emptyOutDir: false,
      watch: watch ? {} : null,
      lib: {
        entry: resolve(root, 'src/content.ts'),
        name: 'AtsuSyncContent',
        formats: ['iife'],
        fileName: () => 'content.js',
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
