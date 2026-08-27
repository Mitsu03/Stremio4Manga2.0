/**
 * `schema.graphql` is bundled as text (see server/build.js: `loader: { '.graphql': 'text' }`),
 * so the executor can `import schema from './schema.graphql'` and carry the contract
 * inside dist/main.js instead of reading a file next to it at runtime.
 */
declare module '*.graphql' {
  const source: string;
  export default source;
}
