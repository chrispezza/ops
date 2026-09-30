// Vite's `?raw` import, used by the docs consistency tests to read a markdown
// file as a string inside workerd (no fs there).
declare module "*.md?raw" {
  const content: string;
  export default content;
}
