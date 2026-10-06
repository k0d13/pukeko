import { defineConfig } from "oxfmt";

export default defineConfig({
  sortImports: {
    groups: ["builtin", "external", "internal", "parent", "sibling", "index", "unknown"],
    newlinesBetween: false,
  },
  sortPackageJson: {
    sortScripts: true,
  },
  jsdoc: true,
});
