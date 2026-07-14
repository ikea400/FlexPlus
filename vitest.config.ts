import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    // Run in a Node.js-like environment (no DOM)
    environment: "node",

    // Allow the test suite to pass when no test files exist yet (scaffold phase).
    // Remove this once real tests are added.
    passWithNoTests: true,

    // Glob patterns for test files
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],

    // Code coverage via V8 (fastest, no instrumentation)
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/main.ts",
        "src/**/index.ts",
      ],
      // Thresholds — enforce meaningful coverage from day one
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },

    // Enforce node:sqlite and resolved sqlite to be treated as external in tests
    server: {
      deps: {
        external: ["node:sqlite", "sqlite"],
      },
    },
  },

  resolve: {
    alias: {
      "@domain": resolve(__dirname, "src/domain"),
      "@application": resolve(__dirname, "src/application"),
      "@infrastructure": resolve(__dirname, "src/infrastructure"),
    },
  },
  build: {
    rollupOptions: {
      external: ["node:sqlite", "sqlite"],
    },
  },
  ssr: {
    external: ["node:sqlite", "sqlite"],
    resolve: {
      conditions: ["node", "import", "default"],
    },
  },
});
