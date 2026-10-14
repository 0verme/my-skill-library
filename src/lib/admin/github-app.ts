export interface GitHubAppEnvironment {
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export type GitHubAppErrorCode =
  | 'github_app_not_configured'
  | 'github_app_key_invalid'
  | 'github_app_authentication_failed'
  | 'github_app_installation_missing'
  | 'github_app_permission_denied'
  | 'github_rate_limited'
  | 'github_service_unavailable';

export class GitHubAppError extends Error {
  readonly code: GitHubAppErrorCode;
  readonly retryAfter: number | undefined;

  constructor(code: GitHubAppErrorCode, retryAfter?: number) {
    super(code);
    this.name = 'GitHubAppError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface GitHubAppOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  cryptoProvider?: Crypto;
  timeoutMs?: number;
}

const rsaEncryptionAlgorithm = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

function concatBytes(...arrays: Uint8Array[]) {
  const result = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function derLength(length: number) {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.push(remaining & 0xff);
    remaining >>>= 8;
  }
  bytes.reverse();
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, content: Uint8Array) {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodePemPrivateKey(pem: string): Uint8Array {
  if (pem.length > 20_000) throw new GitHubAppError('github_app_key_invalid');
  const match = pem
    .trim()
    .match(/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\s*([\s\S]+?)\s*-----END \1-----$/);
  if (!match) throw new GitHubAppError('github_app_key_invalid');

  let der: Uint8Array;
  try {
    const base64 = match[2]?.replace(/\s/g, '');
    if (!base64) throw new GitHubAppError('github_app_key_invalid');
    const binary = atob(base64);
    der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new GitHubAppError('github_app_key_invalid');
  }
  if (der.length < 128 || der.length > 16_384) throw new GitHubAppError('github_app_key_invalid');

  if (match[1] === 'PRIVATE KEY') return der;
  const privateKey = derWrap(0x04, der);
  const privateKeyInfo = concatBytes(
    Uint8Array.of(0x02, 0x01, 0x00),
    rsaEncryptionAlgorithm,
    privateKey,
  );
  return derWrap(0x30, privateKeyInfo);
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8_000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeJson(value: Record<string, unknown>) {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function readAppConfiguration(environment: GitHubAppEnvironment) {
  const appId = environment.GITHUB_APP_ID?.trim();
  const installationId = environment.GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = environment.GITHUB_APP_PRIVATE_KEY;
  if (
    !appId ||
    !/^\d{1,20}$/.test(appId) ||
    !installationId ||
    !/^\d{1,20}$/.test(installationId) ||
    !privateKey?.trim()
  ) {
    throw new GitHubAppError('github_app_not_configured');
  }
  return { appId, installationId, privateKey };
}

export async function createGitHubAppJwt(
  environment: GitHubAppEnvironment,
  options: Pick<GitHubAppOptions, 'now' | 'cryptoProvider'> = {},
) {
  const { appId, privateKey } = readAppConfiguration(environment);
  const cryptoProvider = options.cryptoProvider ?? crypto;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId });
  const signingInput = `${header}.${payload}`;

  try {
    const key = await cryptoProvider.subtle.importKey(
      'pkcs8',
      toArrayBuffer(decodePemPrivateKey(privateKey)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await cryptoProvider.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      toArrayBuffer(new TextEncoder().encode(signingInput)),
    );
    return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  } catch (error) {
    if (error instanceof GitHubAppError) throw error;
    throw new GitHubAppError('github_app_key_invalid');
  }
}

export async function createInstallationAccessToken(
  environment: GitHubAppEnvironment,
  options: GitHubAppOptions = {},
): Promise<{ token: string; expiresAt: string }> {
  const { installationId } = readAppConfiguration(environment);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const jwt = await createGitHubAppJwt(environment, options);
  let response: Response;
  try {
    response = await fetcher(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          repositories: ['my-skill-library'],
          permissions: {
            actions: 'read',
            checks: 'read',
            contents: 'write',
            pull_requests: 'write',
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw new GitHubAppError('github_service_unavailable');
  }

  if (response.status === 401) throw new GitHubAppError('github_app_authentication_failed');
  if (response.status === 404) throw new GitHubAppError('github_app_installation_missing');
  if (response.status === 403 && response.headers.has('Retry-After')) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new GitHubAppError(
      'github_rate_limited',
      Number.isFinite(retryAfter) ? Math.max(1, Math.min(retryAfter, 3_600)) : 60,
    );
  }
  if (response.status === 403) throw new GitHubAppError('github_app_permission_denied');
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new GitHubAppError(
      'github_rate_limited',
      Number.isFinite(retryAfter) ? Math.max(1, Math.min(retryAfter, 3_600)) : 60,
    );
  }
  if (!response.ok) throw new GitHubAppError('github_service_unavailable');

  let result: { token?: unknown; expires_at?: unknown };
  try {
    const text = await response.text();
    if (text.length > 16_384) throw new Error('response too large');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('response invalid');
    }
    result = parsed as { token?: unknown; expires_at?: unknown };
  } catch {
    throw new GitHubAppError('github_service_unavailable');
  }
  const expiresAt = typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : NaN;
  if (
    typeof result.token !== 'string' ||
    result.token.length < 20 ||
    result.token.length > 4_096 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= (options.now?.() ?? Date.now())
  ) {
    throw new GitHubAppError('github_service_unavailable');
  }
  return { token: result.token, expiresAt: result.expires_at as string };
}
