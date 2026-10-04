// Exposes workspace selection and updates; Git storage formats and setting locks stay internal.
export { connectionConfigDirectory, readConnections, requireConnection, addConnection, defaultConnection, selectConnection } from './connections.ts';
export type { ConnectionDefinition, NamedConnection, ConnectionSource, SelectedConnection } from './connections.ts';
export { readRepositoryDefaults, writeRepositoryDefaults, repositoryConfigPath, validateRepositoryDefaults, useRepositoryConnection, validateExternalDirectory } from './local-config.ts';
export type { RepositoryConfiguration, RepositoryDefaults, RepositorySelection } from './local-config.ts';
