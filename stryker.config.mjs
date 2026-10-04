// Selects bounded mutations and existing behavior tests; full type checks run separately.
export default {
  mutate: [
    "src/issue-id.ts:16:1-20:1",
    "src/issues.ts:222:1-240:1",
    "src/issues.ts:258:1-282:1",
    "src/snapshot.ts:97:1-99:1",
  ],
  testRunner: "tap",
  tap: {
    testFiles: ["test/issues.test.ts", "test/snapshot.test.ts"],
  },
  ignorePatterns: ["/tsconfig.json", "/tsconfig.cli.json"],
  reporters: ["clear-text", "agent"],
  plugins: ["@stryker-mutator/*", "stryker-agent-reporter"],
  coverageAnalysis: "perTest",
  concurrency: 2,
  timeoutMS: 10000,
};
