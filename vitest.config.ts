import { defineConfig } from "vitest/config";

//  Live smoke tests hit the real Heliyos API; they only run via `npm run smoke`.
const runSmoke = process.env.HELIYOS_MCP_SMOKE === "1";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: runSmoke ? [] : ["tests/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
