import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        "src/github.ts",
        "src/gitops.ts",
      ],
    },
  },
});
