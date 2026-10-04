import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import type { CoreSetup, OpenSearchDashboardsRequest, RequestHandlerContext } from '../../OpenSearch-Dashboards/src/core/server';

export interface Principal {
  id: string;
  name: string;
  admin: boolean;
}

const adminRole = 'xdr_navigator_admin';

export async function principalFor(
  core: CoreSetup,
  context: RequestHandlerContext,
  request: OpenSearchDashboardsRequest
): Promise<Principal> {
  const auth = core.http.auth.get(request);
  if (auth.status === 'unauthenticated') throw new Error('Authentication required');
  const state = auth.state as { authInfo?: { user_id?: string; user_name?: string; backend_roles?: string[]; roles?: string[] } } | null;
  let name = state?.authInfo?.user_id || state?.authInfo?.user_name;
  let roles = [...(state?.authInfo?.roles || []), ...(state?.authInfo?.backend_roles || [])];
  try {
    const result = await context.core.opensearch.client.asCurrentUser.transport.request({
      method: 'GET', path: '/_plugins/_security/authinfo',
    });
    const info = result.body as { user_name?: string; user?: string; roles?: string[]; backend_roles?: string[] };
    name = info.user_name || info.user || name;
    roles = [...roles, ...(info.roles || []), ...(info.backend_roles || [])];
  } catch {
    // Core authentication is sufficient when the Security auth-info endpoint is unavailable.
  }
  if (!name) {
    throw new Error('Signed-in user identity is unavailable');
  }
  return { id: name, name, admin: roles.includes(adminRole) };
}

function encryptionKey(): Buffer {
  const source = process.env.XDR_NAVIGATOR_ENCRYPTION_KEY;
  if (!source || source.length < 32) throw new Error('XDR_NAVIGATOR_ENCRYPTION_KEY must contain at least 32 characters');
  return createHash('sha256').update(source).digest();
}

export function encryptionReady(): boolean {
  try { encryptionKey(); return true; } catch { return false; }
}

export function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function unseal(value?: string): string {
  if (!value) return '';
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
