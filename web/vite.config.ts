import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

/** Версия сборки для отчётов об ошибках интерфейса: VITE_BUILD_ID, иначе коммит git, иначе время сборки. */
function buildId(): string {
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_BUILD__: JSON.stringify(buildId()) },
  server: { port: 5190 },
});
