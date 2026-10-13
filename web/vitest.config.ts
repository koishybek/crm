import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test эмулирует рантайм Convex только в edge-окружении; тесты интерфейса (src) задают окружение
    // в первой строке файла: `// @vitest-environment node`.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
  },
});
