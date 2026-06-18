import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".open-next/**",
    "public/ext/**",
  ]),
  // Editor library uses <img> for dynamic blob/asset URLs that are incompatible
  // with Next.js Image optimization. Suppress the warning for the editor core.
  {
    files: ["src/lib/opengpex/**/*.{ts,tsx}"],
    rules: {
      "@next/next/no-img-element": "off",
      // Allow _prefixed vars for intentional "omit via destructuring" patterns
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
]);

export default eslintConfig;
