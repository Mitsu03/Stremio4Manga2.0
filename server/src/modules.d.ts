// esbuild's `text` loader turns these into string exports at build time, which
// is what lets the schema ship inside dist/main.js with no data files beside it.
declare module '*.sql' {
  const content: string;
  export default content;
}
