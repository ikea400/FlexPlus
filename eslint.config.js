// @ts-check
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config (ESLint v9+).
 *
 * Key architectural rule:
 *   The `domain` layer must never import from `application` or `infrastructure`.
 *   The `application` layer must never import from `infrastructure`.
 *
 * This is enforced by the `no-restricted-imports` rule below.
 */
export default tseslint.config(
  // ─── Base ───────────────────────────────────────────────────────────────
  ...tseslint.configs.recommended,

  // ─── TypeScript project config ──────────────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ─── Domain layer: zero external/upward imports ─────────────────────────
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../application/**", "../../application/**", "@application/*"],
              message:
                "[DDD] The domain layer must not import from the application layer.",
            },
            {
              group: [
                "../infrastructure/**",
                "../../infrastructure/**",
                "@infrastructure/*",
              ],
              message:
                "[DDD] The domain layer must not import from the infrastructure layer.",
            },
          ],
        },
      ],
    },
  },

  // ─── Application layer: no infrastructure imports ───────────────────────
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../infrastructure/**",
                "../../infrastructure/**",
                "@infrastructure/*",
              ],
              message:
                "[DDD] The application layer must not import from the infrastructure layer.",
            },
          ],
        },
      ],
    },
  },

  // ─── General rules ──────────────────────────────────────────────────────
  {
    rules: {
      // Keep unused variables visible during development
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Require Promise rejections to be handled
      "@typescript-eslint/no-floating-promises": "error",

      // Disallow non-null assertions — use explicit type guards
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },

  // ─── Ignore patterns ────────────────────────────────────────────────────
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "*.config.js",
      "*.config.ts",
      ".agents/**",
    ],
  },
);
