import { defineConfig } from "tsup";

// The published package is one self-contained module: palm's internal
// packages (@palm/*) are bundled in, so a deployment installs exactly one
// thing. Third-party dependencies, once there are any, stay external and are
// listed in this package's dependencies.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2023",
  platform: "neutral",
  // Point @palm/* at their sources so the declarations are inlined too;
  // through node_modules they would be left as imports of unpublished packages.
  dts: {
    resolve: true,
    compilerOptions: { paths: { "@palm/core": ["../../packages/core/src/index.ts"] } },
  },
  noExternal: [/^@palm\//],
  clean: true,
  sourcemap: true,
});
