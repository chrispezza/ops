// Vite's `?raw` import, used by the docs consistency tests to read a markdown
// file as a string inside workerd (no fs there).
declare module "*.md?raw" {
  const content: string;
  export default content;
}

// Vite's `import.meta.glob`, used by test/write-path.test.ts to read every
// source file as text. Declared narrowly instead of pulling in vite/client.
interface ImportMeta {
  glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
}
