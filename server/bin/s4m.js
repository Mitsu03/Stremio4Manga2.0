#!/usr/bin/env node
// A shim, so that `s4m` works from an npm bin link while the real command lives
// in the bundle esbuild produces. Nothing here but the hop, and one sentence for
// the one thing that can go wrong before the CLI itself is loaded.
import('../dist/cli.js').catch((error) => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write('The server has not been built. Run "npm run build" in server/ first.\n');
    process.exit(2);
  }
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
