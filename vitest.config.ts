import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Validation checkouts and archived evidence can also contain test files.
    include: ["test/**/*.test.ts"],
  },
});
