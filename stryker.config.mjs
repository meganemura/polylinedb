// Selects bounded mutations and existing behavior tests; full type checks run separately.
export default {
  mutate: [
    "src/records/store/issue-id.ts:16:1-20:1",
    "src/records/issues/issues.ts:144:1-162:1",
    "src/records/store/issue-record.ts:84:1-108:1",
    "src/records/persistence/snapshot.ts:98:1-100:1",
    "src/transition/**/*.ts",
  ],
  testRunner: "tap",
  tap: {
    testFiles: [
      "test/issues.test.ts",
      "test/snapshot.test.ts",
      "test/transition.test.ts",
      "test/claims.test.ts",
      "test/transition-differential.test.ts",
      "test/agent-gates.test.ts",
    ],
  },
  ignorePatterns: ["/tsconfig.json", "/tsconfig.cli.json"],
  reporters: ["clear-text", "agent"],
  plugins: ["@stryker-mutator/*", "stryker-agent-reporter"],
  coverageAnalysis: "perTest",
  concurrency: 2,
  timeoutMS: 10000,
};
