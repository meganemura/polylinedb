const requestedVersion = process.env.PD_TEST_NODE_VERSION;

if (requestedVersion !== undefined) {
  Object.defineProperty(process.versions, 'node', { value: requestedVersion });
}
