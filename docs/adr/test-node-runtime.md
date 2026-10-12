# Check the Node runtime before tests start

Test commands check the running Node version against `package.json` before they load test files or start children.
The guard reports the actual version and the required range, then exits with status 1 on an unsupported runtime.

The preload uses JavaScript so older Node versions can execute the check before they try to load TypeScript.
It reads the manifest and accepts its caret and lower-bound clauses. An unsupported clause fails instead of weakening the requirement.

The D1 runner, package test script, and shared CLI child helper also import the guard for direct invocation.
The D1 runner passes the preload to each child. The CLI version-simulation fixture still runs after the test process admission check.

The CLI bootstrap keeps its own runtime check because it permits help and version inquiries on unsupported runtimes.
Importing that bootstrap into the test guard would also execute the CLI command flow.
