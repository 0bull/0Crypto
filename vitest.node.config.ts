import { defineConfig } from "vitest/config";

// Plain Node tests for scripts/ (no Workers pool).
export default defineConfig({ test: { include: ["test/node/**/*.test.ts"], exclude: ["plugins/**", "contracts/**", "node_modules/**", "tools/**"], environment: "node" } });
