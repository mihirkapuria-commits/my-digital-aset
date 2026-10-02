import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';

// ============================================================================
// GOOGLE OAUTH 2.0 ONLY ADMIN AUTHENTICATION ENGINE
// Target Site: https://www.mydigitasset.com
// Only Authorized Account: mihirkapuria@gmail.com
// ============================================================================

export interface AdminSession {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  csrfToken: string;
  clientIp: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

export interface SecurityAuditLog {
  id: string;
  timestamp: string;
  eventType:
    | 'GOOGLE_LOGIN_INITIATED'
    | 'GOOGLE_LOGIN_SUCCESS'
    | 'GOOGLE_LOGIN_UNAUTHORIZED_ACCOUNT'
    | 'GOOGLE_LOGIN_FAILED'
    | 'CSRF_VALIDATION_FAILED'
    | 'ADMIN_LOGOUT'
    | 'SESSION_EXPIRED'
    | 'SETTINGS_UPDATED';
  clientIp: string;
  email?: string;
  details: string;
}

// In-memory active session store
const activeSessions = new Map<string, AdminSession>();

// In-memory security audit trail (last 100 entries)
const auditLogs: SecurityAuditLog[] = [];
const MAX_AUDIT_LOGS = 100;

// Session lifetime: exactly 8 hours as specified
export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

/**
 * The single, authoritative Admin email.
 * Defaults strictly to mihirkapuria@gmail.com.
 */
export function getAuthorizedAdminEmail(): string {
  const envEmail = process.env.ADMIN_EMAIL || 'mihirkapuria@gmail.com';
  return envEmail.trim().toLowerCase();
}

/**
 * Record a security event in the immutable audit log (sanitized, no secrets)
 */
export function recordSecurityLog(
  eventType: SecurityAuditLog['eventType'],
  clientIp: string,
  details: string,
  email?: string
) {
  const log: SecurityAuditLog = {
    id: `sec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
    eventType,
    clientIp,
    email,
    details,
  };

  auditLogs.unshift(log);
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.pop();
  }

  console.log(`[ADMIN AUDIT] [${log.timestamp}] [${eventType}] [${email || 'Anonymous'}] IP: ${clientIp} - ${details}`);
}

export function getSecurityLogs(): SecurityAuditLog[] {
  return [...auditLogs];
}

/**
 * Extract client IP for audit logging only (no IP restrictions or allowlists)
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

/**
 * Build dynamic redirect URI for Google OAuth callback
 */
export function getOAuthCallbackUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'www.mydigitasset.com';
  return `${proto}://${host}/auth/google/callback`;
}

/**
 * Generate Google OAuth authorization URL requesting ONLY openid, email, profile
 */
export function generateGoogleAuthUrl(redirectUri: string, state: string): { url: string; error?: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return {
      url: '',
      error: 'GOOGLE_CLIENT_ID environment variable is missing on the server.',
    };
  }

  const client = new OAuth2Client({
    clientId,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  });

  const url = client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });

  return { url };
}

/**
 * Securely exchange authorization code for Google tokens on the server
 * and cryptographically validate the ID token
 */
export async function exchangeCodeAndVerifyToken(
  code: string,
  redirectUri: string
): Promise<{
  valid: boolean;
  email?: string;
  name?: string;
  picture?: string;
  error?: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      valid: false,
      error: 'Google OAuth credentials (GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET) are not configured on the server.',
    };
  }

  try {
    const client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri,
    });

    // 1. Server-side token exchange
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      return { valid: false, error: 'No ID token returned by Google.' };
    }

    // 2. Cryptographic signature and claim verification (Google public keys + audience)
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return { valid: false, error: 'Empty token payload received from Google.' };
    }

    // Step A: Explicit audience verification
    if (payload.aud !== clientId) {
      return { valid: false, error: 'Google ID token audience mismatch.' };
    }

    // Step B: Explicit expiration check
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) {
      return { valid: false, error: 'Google ID token has expired.' };
    }

    // Step C: Explicit email verification
    if (!payload.email) {
      return { valid: false, error: 'Google account has no associated email address.' };
    }

    if (payload.email_verified !== true) {
      return { valid: false, error: 'Google email address is not verified by Google.' };
    }

    const authorizedEmail = getAuthorizedAdminEmail();
    const candidateEmail = payload.email.trim().toLowerCase();
    if (candidateEmail !== authorizedEmail) {
      return {
        valid: false,
        email: candidateEmail,
        error: `Unauthorized Google account: ${candidateEmail}. Only ${authorizedEmail} is permitted.`,
      };
    }

    return {
      valid: true,
      email: candidateEmail,
      name: payload.name || 'Administrator',
      picture: payload.picture,
    };
  } catch (err: any) {
    console.error('Google OAuth exchange error:', err.message);
    return { valid: false, error: err.message || 'Google token exchange failed.' };
  }
}

/**
 * Create a secure 8-hour Admin session
 * Returns { sessionToken, csrfToken }
 */
export function createAdminSession(
  email: string,
  clientIp: string,
  name?: string,
  picture?: string
): { sessionToken: string; csrfToken: string } {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const now = Date.now();

  const session: AdminSession = {
    id: sessionToken,
    email,
    name,
    picture,
    csrfToken,
    clientIp,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  };

  activeSessions.set(sessionToken, session);
  return { sessionToken, csrfToken };
}

/**
 * Validate an active session and update sliding activity
 */
export function validateAdminSession(sessionToken: string): AdminSession | null {
  if (!sessionToken) return null;

  const session = activeSessions.get(sessionToken);
  if (!session) return null;

  const now = Date.now();
  if (now > session.expiresAt) {
    activeSessions.delete(sessionToken);
    return null;
  }

  session.lastActiveAt = now;
  return session;
}

/**
 * Invalidate a session upon logout
 */
export function invalidateAdminSession(sessionToken: string): boolean {
  if (!sessionToken) return false;
  return activeSessions.delete(sessionToken);
}

/**
 * Express Middleware: Protect all sensitive /api/admin/* endpoints
 * Enforces:
 * 1. Valid HttpOnly admin_session cookie
 * 2. Strict authorized email match (mihirkapuria@gmail.com)
 * 3. CSRF token validation for state-changing methods (POST, PUT, DELETE, PATCH)
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const sessionToken = req.cookies?.admin_session;

  if (!sessionToken) {
    return res.status(401).json({
      error: 'Authentication required. No active administrator session found.',
    });
  }

  const session = validateAdminSession(sessionToken);
  if (!session) {
    return res.status(401).json({
      error: 'Administrator session expired or invalid. Please sign in again with Google.',
    });
  }

  const authorizedEmail = getAuthorizedAdminEmail();
  if (session.email.toLowerCase() !== authorizedEmail) {
    invalidateAdminSession(sessionToken);
    res.clearCookie('admin_session', { path: '/' });
    res.clearCookie('admin_csrf', { path: '/' });
    return res.status(403).json({
      error: 'Access denied: Google account is not authorized.',
    });
  }

  // Enforce CSRF token on mutating requests
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (mutatingMethods.includes(req.method.toUpperCase())) {
    const requestCsrf =
      (req.headers['x-csrf-token'] as string) ||
      (req.body && req.body._csrf);

    if (!requestCsrf || requestCsrf !== session.csrfToken) {
      const clientIp = getClientIp(req);
      recordSecurityLog(
        'CSRF_VALIDATION_FAILED',
        clientIp,
        `CSRF token mismatch or missing for method ${req.method} on ${req.originalUrl}`,
        session.email
      );
      return res.status(403).json({
        error: 'Forbidden: Invalid or missing CSRF token.',
      });
    }
  }

  (req as any).adminSession = session;
  next();
}

/**
 * Directly verifies a Google ID token passed by a client,
 * explicitly checking signature, audience, expiry, email_verified, and email match.
 */
export async function verifyGoogleIdTokenDirect(idToken: string): Promise<{
  valid: boolean;
  email?: string;
  name?: string;
  picture?: string;
  error?: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { valid: false, error: 'GOOGLE_CLIENT_ID is not configured on the server.' };
  }

  try {
    const client = new OAuth2Client({ clientId });
    const ticket = await client.verifyIdToken({
      idToken,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      return { valid: false, error: 'Empty payload returned from Google ID token.' };
    }

    // 1. Audience verification
    if (payload.aud !== clientId) {
      return { valid: false, error: 'Google ID token audience does not match configured Google Client ID.' };
    }

    // 2. Expiration verification
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) {
      return { valid: false, error: 'Google ID token has expired.' };
    }

    // 3. Email presence
    if (!payload.email) {
      return { valid: false, error: 'Google token does not contain an email address.' };
    }

    // 4. email_verified verification
    if (payload.email_verified !== true) {
      return { valid: false, error: 'Google email address is not verified by Google.' };
    }

    // 5. Authorized email verification
    const authorizedEmail = getAuthorizedAdminEmail();
    const candidateEmail = payload.email.trim().toLowerCase();
    if (candidateEmail !== authorizedEmail) {
      return {
        valid: false,
        email: candidateEmail,
        error: `Unauthorized Google account: ${candidateEmail}. Only ${authorizedEmail} is permitted.`,
      };
    }

    return {
      valid: true,
      email: candidateEmail,
      name: payload.name || 'Administrator',
      picture: payload.picture,
    };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Google token validation failed.' };
  }
}
