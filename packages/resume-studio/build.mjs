// 产物给两类消费者：渲染层（Vite）与发布包里的侧车（裸 Node ESM，不走 tsx）。
// 源码是 bundler 风格（相对 import 不带扩展名），tsc 原样输出后裸 Node 解析不了，
// 所以 JS 由 esbuild 打包：每个入口一份，公共代码拆成共享 chunk（字体地址改写器等模块级状态
// 必须只有一份，fonts 与 pdf 入口才能共用）；第三方包一律 external（由 node_modules 提供）。
// 类型声明仍由 tsc 生成（tsc --emitDeclarationOnly）。
import { build } from 'esbuild';

await build({
  entryPoints: {
    'schema/index': 'src/schema/index.ts',
    'pdf/browser': 'src/pdf/browser.tsx',
    'pdf/server': 'src/pdf/server.tsx',
    'pdf/document': 'src/pdf/document.tsx',
    'fonts/index': 'src/fonts/index.ts',
  },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  jsx: 'automatic',
  packages: 'external',
  sourcemap: true,
  chunkNames: 'chunks/[name]-[hash]',
  loader: { '.json': 'json' },
  logLevel: 'warning',
});
