// Bundles the server to a single dist/main.js.
//
// Bundling rather than tsc-emitting keeps the runtime free of a loader step and
// makes `node dist/main.js` the whole story for systemd and the Windows tray.
// schema.graphql and schema.sql are loaded through esbuild's `text` loader so
// the bundle carries them; there is no data directory to install next to it.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  // Two entry points: the server, and the account/migration CLI that bin/s4m.js
  // is a shim over. They share the config loader and the database module, so
  // bundling them together would mean shipping the HTTP stack inside the CLI.
  entryPoints: [join(root, 'src/main.ts'), join(root, 'src/cli.ts')],
  outdir: join(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['node:*'],
  loader: { '.graphql': 'text', '.sql': 'text' },
  logLevel: 'info',
  banner: {
    // esbuild's ESM output has no require(); a few transitive deps still reach
    // for it, so give them one built from this module's own URL.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
