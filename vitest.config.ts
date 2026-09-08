import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    // Pure modules, the host entry and the server run under node; app tests
    // opt into jsdom with a `// @vitest-environment jsdom` header.
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30_000,
  },
});
