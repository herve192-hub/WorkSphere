import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "REACT_APP_");

  return {
    plugins: [react()],
    // Keep the existing public API URL setting and Docker build argument.
    // Only this value is included in browser code, never the whole environment.
    define: {
      "process.env.REACT_APP_API_URL": JSON.stringify(env.REACT_APP_API_URL || "http://localhost:5000/api/v1"),
    },
    server: { port: 3000, strictPort: true },
    build: { outDir: "build" },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{js,jsx}"],
      setupFiles: ["./src/setupTests.js"],
      coverage: {
        provider: "v8",
        include: ["src/**/*.{js,jsx}"],
        exclude: ["src/**/*.test.{js,jsx}", "src/setupTests.js"],
        reporter: ["text-summary", "lcov", "json-summary"],
      },
    },
  };
});
