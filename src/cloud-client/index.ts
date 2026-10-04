// Owns authenticated cloud actions; local storage and command parsing stay outside.
import { join } from 'node:path';
import { connectionConfigDirectory } from "../workspace/index.ts";
import type { SelectedConnection } from "../workspace/index.ts";
import { createCloudAuth, OAuthError } from './oauth.ts';
import { createCredentialStore, CredentialStoreError } from './credential-store.ts';
import { executeCloudOperation } from './cloud-operations.ts';
import type { Operation } from '../records/index.ts';

export { OAuthError } from './oauth.ts';
export { CredentialStoreError } from './credential-store.ts';
export type { AuthStatus } from './oauth.ts';

export function createCloudClient(connection: Extract<SelectedConnection, { kind: 'cloud' }>) {
  const auth = createCloudAuth({ origin: connection.url, stateDirectory: join(connectionConfigDirectory(), 'auth'),
    credentialStore: createCredentialStore() });
  const authenticate = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) {
      if (error instanceof OAuthError || error instanceof CredentialStoreError) throw error;
      throw new OAuthError('auth_failed', 'Authentication could not complete.');
    }
  };
  return {
    execute: (operation: Operation) => executeCloudOperation({ origin: connection.url, operation,
      authorize: () => authenticate(() => auth.accessToken()) }),
    login: (showAuthorizationUrl: (url: string) => void | Promise<void>) => authenticate(() => auth.login({ showAuthorizationUrl })),
    status: () => authenticate(() => auth.status()),
    logout: () => authenticate(() => auth.logout()),
  };
}
