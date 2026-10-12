import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test эмулирует рантайм Convex только в edge-окружении
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts"],
  },
});
