export interface AccessEnvironment {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
}

export interface AdminIdentity {
  email: string;
}

export type AccessErrorCode =
  | 'access_not_configured'
  | 'authentication_required'
  | 'invalid_access_token'
  | 'authentication_unavailable'
  | 'administrator_required';

export type AccessResult =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; status: 401 | 403 | 503; code: AccessErrorCode };

interface AccessJwk extends JsonWebKey {
  kid?: string;
}

interface JsonWebKeySet {
  keys: AccessJwk[];
}

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  email?: unknown;
}

interface AccessHeader {
  alg?: unknown;
  kid?: unknown;
}

interface AuthenticatorOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  cryptoProvider?: Crypto;
  timeoutMs?: number;
}

interface AccessConfig {
  issuer: string;
  audience: string;
  admins: Set<string>;
}

interface CachedKeys {
  issuer: string;
  expiresAt: number;
  keys: AccessJwk[];
}

interface PendingKeys {
  issuer: string;
  promise: Promise<AccessJwk[]>;
}

const invalidToken: AccessResult = { ok: false, status: 401, code: 'invalid_access_token' };
const requiredToken: AccessResult = { ok: false, status: 401, code: 'authentication_required' };
const unconfigured: AccessResult = { ok: false, status: 503, code: 'access_not_configured' };
const authUnavailable: AccessResult = {
  ok: false,
  status: 503,
  code: 'authentication_unavailable',
};
const administratorRequired: AccessResult = {
  ok: false,
  status: 403,
  code: 'administrator_required',
};

function normalizeTeamIssuer(value: string | undefined): string | undefined {
  if (!value?.trim() || value.length > 255) return undefined;

  try {
    const input = value.trim();
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.port ||
      !url.hostname.includes('.') ||
      url.hostname === 'localhost'
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function readConfig(environment: AccessEnvironment): AccessConfig | undefined {
  const issuer = normalizeTeamIssuer(environment.CF_ACCESS_TEAM_DOMAIN);
  const audience = environment.CF_ACCESS_AUD?.trim();
  const rawAdmins = environment.ADMIN_EMAILS?.trim();
  if (!issuer || !audience || audience.length > 256 || !rawAdmins) return undefined;

  const emails = rawAdmins
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (
    emails.length === 0 ||
    emails.length > 50 ||
    emails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ) {
    return undefined;
  }

  return { issuer, audience, admins: new Set(emails) };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;

  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decodeJsonSegment<T>(segment: string): T | undefined {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return undefined;

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch {
    return undefined;
  }
}

function parseAccessToken(
  token: string,
):
  | { header: AccessHeader; claims: AccessClaims; signingInput: string; signature: Uint8Array }
  | undefined {
  if (token.length > 8_192) return undefined;
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  const [headerSegment, claimsSegment, signatureSegment] = segments;
  if (!headerSegment || !claimsSegment || !signatureSegment) return undefined;

  const header = decodeJsonSegment<AccessHeader>(headerSegment);
  const claims = decodeJsonSegment<AccessClaims>(claimsSegment);
  const signature = decodeBase64Url(signatureSegment);
  if (!header || !claims || !signature) return undefined;
  return { header, claims, signingInput: `${headerSegment}.${claimsSegment}`, signature };
}

function isExpectedClaims(claims: AccessClaims, config: AccessConfig, nowSeconds: number) {
  return (
    claims.iss === config.issuer &&
    Array.isArray(claims.aud) &&
    claims.aud.includes(config.audience) &&
    typeof claims.exp === 'number' &&
    Number.isFinite(claims.exp) &&
    claims.exp > nowSeconds &&
    (claims.nbf === undefined ||
      (typeof claims.nbf === 'number' &&
        Number.isFinite(claims.nbf) &&
        claims.nbf <= nowSeconds)) &&
    (claims.iat === undefined ||
      (typeof claims.iat === 'number' &&
        Number.isFinite(claims.iat) &&
        claims.iat <= nowSeconds + 60)) &&
    typeof claims.email === 'string' &&
    claims.email.length > 0 &&
    claims.email.length <= 254
  );
}

function cacheLifetime(response: Response, now: number) {
  const match = response.headers.get('Cache-Control')?.match(/(?:^|,)\s*max-age=(\d+)/i);
  const advertisedSeconds = match ? Number(match[1]) : 300;
  return (
    now +
    Math.max(30, Math.min(Number.isFinite(advertisedSeconds) ? advertisedSeconds : 300, 300)) *
      1_000
  );
}

export function createAdminAuthenticator(options: AuthenticatorOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cryptoProvider = options.cryptoProvider ?? crypto;
  const timeoutMs = options.timeoutMs ?? 4_000;
  let cachedKeys: CachedKeys | undefined;
  let pendingKeys: PendingKeys | undefined;

  async function getKeys(issuer: string): Promise<AccessJwk[]> {
    const currentTime = now();
    if (cachedKeys?.issuer === issuer && cachedKeys.expiresAt > currentTime) {
      return cachedKeys.keys;
    }
    if (pendingKeys?.issuer === issuer) return pendingKeys.promise;

    const promise = (async () => {
      const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error('JWKS request failed');
      const text = await response.text();
      if (text.length > 65_536) throw new Error('JWKS response too large');
      const keySet = JSON.parse(text) as JsonWebKeySet;
      if (!Array.isArray(keySet.keys) || keySet.keys.length === 0 || keySet.keys.length > 16) {
        throw new Error('JWKS response invalid');
      }
      const keys = keySet.keys.filter(
        (key) => key.kty === 'RSA' && typeof key.kid === 'string' && key.kid.length <= 256,
      );
      if (keys.length === 0) throw new Error('JWKS has no supported signing keys');

      cachedKeys = {
        issuer,
        expiresAt: cacheLifetime(response, currentTime),
        keys,
      };
      return keys;
    })();

    pendingKeys = { issuer, promise };
    try {
      return await promise;
    } finally {
      if (pendingKeys?.promise === promise) pendingKeys = undefined;
    }
  }

  return async function authenticateAdmin(
    request: Request,
    environment: AccessEnvironment,
  ): Promise<AccessResult> {
    const config = readConfig(environment);
    if (!config) return unconfigured;

    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) return requiredToken;
    const parsed = parseAccessToken(token);
    if (
      !parsed ||
      parsed.header.alg !== 'RS256' ||
      typeof parsed.header.kid !== 'string' ||
      parsed.header.kid.length > 256 ||
      !isExpectedClaims(parsed.claims, config, Math.floor(now() / 1_000))
    ) {
      return invalidToken;
    }

    let validSignature = false;
    try {
      const keys = await getKeys(config.issuer);
      const jwk = keys.find((key) => key.kid === parsed.header.kid);
      if (!jwk) return invalidToken;
      const publicKey = await cryptoProvider.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      validSignature = await cryptoProvider.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        publicKey,
        toArrayBuffer(parsed.signature),
        toArrayBuffer(new TextEncoder().encode(parsed.signingInput)),
      );
    } catch {
      return authUnavailable;
    }
    if (!validSignature) return invalidToken;

    const email = (parsed.claims.email as string).toLowerCase();
    if (!config.admins.has(email)) return administratorRequired;
    return { ok: true, identity: { email } };
  };
}

export const authenticateAdmin = createAdminAuthenticator();
