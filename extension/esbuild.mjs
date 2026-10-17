// Bundles the extension (and the shared core in ../src) into one CommonJS file for VS Code.
//   node esbuild.mjs               development build with source maps
//   node esbuild.mjs --production  minified, for packaging
//   node esbuild.mjs --watch       rebuild on change
import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['../src/ui/vscode/extension.js'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20', // the Node version inside VS Code 1.90
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build(options);
}
