// Simulates another runtime for the CLI and solarsql runtime checks. Both read the SQLite
// version through process.getBuiltinModule, so a store opened by a static import stays real.
const requestedVersion = process.env.PD_TEST_NODE_VERSION;
const requestedRuntime = process.env.PD_TEST_RUNTIME;
const requestedSqlite = process.env.PD_TEST_SQLITE_VERSION;

if (requestedVersion !== undefined) {
  Object.defineProperty(process.versions, 'node', { value: requestedVersion });
}
if (requestedRuntime !== undefined) {
  const [name, version] = requestedRuntime.split(':');
  Object.defineProperty(process.versions, name, { value: version, enumerable: true });
}
if (requestedSqlite !== undefined) {
  const builtin = process.getBuiltinModule.bind(process);
  class DatabaseSync {
    prepare() { return { get: () => ({ version: requestedSqlite }) }; }
    close() {}
  }
  process.getBuiltinModule = id => id === 'node:sqlite' || id === 'sqlite'
    ? (requestedSqlite === 'none' ? undefined : { DatabaseSync })
    : builtin(id);
}
