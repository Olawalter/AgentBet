import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    // Build/tooling files and Next's generated ambient types are not
    // application code. next-env.d.ts is regenerated on every build and always
    // contains a triple-slash reference; tailwind.config.js is CommonJS by
    // necessity (it needs __dirname to resolve content globs absolutely).
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "tailwind.config.js",
      "postcss.config.mjs",
      "eslint.config.mjs",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
