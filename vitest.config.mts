import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for pure logic (simulation model, scenario derivations, timeline helpers).
 * Node environment: nothing here touches the DOM; components are imported only for their pure exports.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    restoreMocks: true,
  },
});
