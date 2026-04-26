import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // entrypoint: argv parsing only
        "src/transports/**", // covered by manual stdio smoke + integration
      ],
      // Thresholds:
      // - Lines and statements at 70% (whole codebase exercised).
      // - Branches at 70% (error paths matter).
      // - Functions intentionally lower because each tool handler is a
      //   thin wrapper; we exercise representative tools per domain rather
      //   than every handler. The /client/, /auth/, and /tools/registry
      //   modules — the actual business logic — sit comfortably above 90%.
      thresholds: {
        lines: 70,
        functions: 45,
        branches: 70,
        statements: 70,
      },
    },
  },
});
