// Files imported with `with { type: "text" }` and embedded in the binary
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.service" {
  const text: string;
  export default text;
}
declare module "*.example" {
  const text: string;
  export default text;
}
declare module "*.gitignore" {
  const text: string;
  export default text;
}
