import { defineConfig } from "tsup";

// The published package is one self-contained module: palm's internal
// packages (@palm/*) are bundled in, so a deployment installs exactly one
// thing. Small runtime libraries (hono) are bundled too, so the package has no
// dependencies at all.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "es2023",
    platform: "neutral",
    // Point @palm/* at their sources so the declarations are inlined too;
    // through node_modules they would be left as imports of unpublished packages.
    dts: {
      resolve: true,
      compilerOptions: {
        paths: { "@palm/*": ["../../packages/*/src/index.ts"] },
      },
    },
    noExternal: [/^@palm\//, "hono", /^hono\//],
    clean: true,
    sourcemap: true,
  },
  // The admin CLI, as the package's `palm` bin, so an instance repo runs
  // `pnpm palm ...` against its own database. Node only; @palm/auth inlined.
  {
    entry: { cli: "../../packages/cli/src/palm.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    noExternal: [/^@palm\//],
    sourcemap: false,
  },
]);
