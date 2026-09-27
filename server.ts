import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import {
  generateGoogleAuthUrl,
  exchangeCodeAndVerifyToken,
  createAdminSession,
  validateAdminSession,
  invalidateAdminSession,
  requireAdminAuth,
  getAuthorizedAdminEmail,
  recordSecurityLog,
  getSecurityLogs,
  getClientIp,
  getOAuthCallbackUrl,
  SESSION_LIFETIME_MS,
} from './server/googleAdminAuth.js';
import { validateUploadFile } from './server/fileUploadSecurity.js';

// Server-side persistent site settings file (non-secret content)
const SETTINGS_FILE = path.join(process.cwd(), 'server', 'data', 'site-settings.json');

function loadPersistedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading site settings:', err);
  }
  return null;
}

function savePersistedSettings(settings: any) {
  try {
    const dataDir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving site settings:', err);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // Cookie and body parsers with strict size limits
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // ==========================================
  // PUBLIC API ROUTES
  // ==========================================
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Public endpoint for normal visitors to fetch site configurations
  app.get('/api/site-settings', (req, res) => {
    const custom = loadPersistedSettings();
    res.json({ settings: custom });
  });

  // Public client-safe config info (NO secrets exposed)
  app.get('/api/admin/auth-status', (req, res) => {
    res.json({
      authorizedEmail: getAuthorizedAdminEmail(),
      isConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
      hasClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    });
  });

  // ==========================================
  // GOOGLE OAUTH 2.0 ENDPOINTS
  // ==========================================

  /**
   * 1. /auth/google/login
   * Initiates Google OAuth 2.0 Authorization Code flow
   */
  app.get('/auth/google/login', (req, res) => {
    const clientIp = getClientIp(req);
    const redirectUri = getOAuthCallbackUrl(req);
    const state = crypto.randomBytes(32).toString('hex');

    // Store state in an HttpOnly cookie for CSRF verification on callback
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/',
    });

    const { url, error } = generateGoogleAuthUrl(redirectUri, state);
    if (error || !url) {
      recordSecurityLog('GOOGLE_LOGIN_FAILED', clientIp, `Login initiate failed: ${error}`);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Admin Configuration Notice - mydigitasset.com</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0a09; color: #f5f5f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #1c1917; border: 1px solid #44403c; border-radius: 16px; padding: 32px; max-width: 520px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
              h1 { color: #f59e0b; font-size: 20px; margin-top: 0; }
              p { font-size: 14px; line-height: 1.6; color: #d6d3d1; }
              code { background: #292524; color: #fbbf24; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
              a { display: inline-block; margin-top: 16px; background: #f59e0b; color: #0c0a09; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Google OAuth Credentials Required</h1>
              <p>Google OAuth 2.0 is the exclusive required Admin authentication method for <strong>mydigitasset.com</strong>.</p>
              <p>Please ensure <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> are set in your server environment variables.</p>
              <a href="/admin">← Return to Admin</a>
            </div>
          </body>
        </html>
      `);
    }

    recordSecurityLog('GOOGLE_LOGIN_INITIATED', clientIp, 'Google OAuth login flow started');
    return res.redirect(url);
  });

  /**
   * 2. /auth/google/callback
   * Exchanges code securely on server, cryptographically validates ID token,
   * verifies exact email match (mihirkapuria@gmail.com), and issues 8-hour HttpOnly session.
   */
  app.get('/auth/google/callback', async (req, res) => {
    const clientIp = getClientIp(req);
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      recordSecurityLog('GOOGLE_LOGIN_FAILED', clientIp, `Google OAuth error query: ${oauthError}`);
      return res.redirect('/admin?error=oauth_cancelled');
    }

    // A. Verify OAuth state against stored cookie (CSRF defense)
    const storedState = req.cookies?.oauth_state;
    res.clearCookie('oauth_state', { path: '/' });

    if (!state || !storedState || state !== storedState) {
      recordSecurityLog(
        'CSRF_VALIDATION_FAILED',
        clientIp,
        'OAuth state mismatch or missing on callback'
      );
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Security Check Failed - mydigitasset.com</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0a09; color: #f5f5f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #1c1917; border: 1px solid #ef4444; border-radius: 16px; padding: 32px; max-width: 480px; text-align: center; }
              h1 { color: #ef4444; font-size: 20px; }
              p { font-size: 14px; color: #d6d3d1; line-height: 1.5; }
              a { display: inline-block; margin-top: 16px; background: #ef4444; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>OAuth State Verification Failed</h1>
              <p>The state verification parameter did not match. This protects against CSRF attacks. Please try logging in again.</p>
              <a href="/auth/google/login">Try Again</a>
            </div>
          </body>
        </html>
      `);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect('/admin?error=missing_code');
    }

    // B. Exchange code and cryptographically verify ID token
    const redirectUri = getOAuthCallbackUrl(req);
    const verification = await exchangeCodeAndVerifyToken(code, redirectUri);

    if (!verification.valid || !verification.email) {
      recordSecurityLog(
        'GOOGLE_LOGIN_FAILED',
        clientIp,
        `Token verification failed: ${verification.error || 'Unknown'}`
      );
      return res.redirect(`/admin?error=${encodeURIComponent(verification.error || 'verification_failed')}`);
    }

    const authenticatedEmail = verification.email.toLowerCase();
    const authorizedEmail = getAuthorizedAdminEmail();

    // C. Strict single-email check: ONLY mihirkapuria@gmail.com
    if (authenticatedEmail !== authorizedEmail) {
      recordSecurityLog(
        'GOOGLE_LOGIN_UNAUTHORIZED_ACCOUNT',
        clientIp,
        `Unauthorized Google account rejected: ${authenticatedEmail}`,
        authenticatedEmail
      );

      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Access Denied - mydigitasset.com Admin</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0a09; color: #f5f5f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #1c1917; border: 1px solid #ef4444; border-radius: 16px; padding: 32px; max-width: 480px; text-align: center; }
              h1 { color: #ef4444; font-size: 20px; }
              p { font-size: 14px; color: #d6d3d1; line-height: 1.6; }
              .bad-email { font-family: monospace; background: #292524; color: #f87171; padding: 3px 8px; border-radius: 4px; }
              a { display: inline-block; margin-top: 16px; background: #292524; color: #f5f5f4; border: 1px solid #57534e; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
              a:hover { background: #44403c; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Access Denied</h1>
              <p>The Google account <span class="bad-email">${authenticatedEmail}</span> is not authorized to access the Admin system of <strong>mydigitasset.com</strong>.</p>
              <p>Only the designated administrator Google account has access.</p>
              <a href="/auth/google/login">Sign in with Authorized Account</a>
            </div>
          </body>
        </html>
      `);
    }

    // D. Create secure 8-hour Admin session
    const { sessionToken, csrfToken } = createAdminSession(
      authenticatedEmail,
      clientIp,
      verification.name,
      verification.picture
    );

    // E. Set secure HttpOnly session cookie (~8 hours)
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_MS,
      path: '/',
    });

    // F. Set CSRF cookie (readable by frontend JS for x-csrf-token header)
    res.cookie('admin_csrf', csrfToken, {
      httpOnly: false,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_MS,
      path: '/',
    });

    recordSecurityLog(
      'GOOGLE_LOGIN_SUCCESS',
      clientIp,
      `Administrator successfully authenticated via Google`,
      authenticatedEmail
    );

    // Redirect authorized admin to /admin
    return res.redirect('/admin');
  });

  /**
   * 3. /auth/google/logout & /api/admin/logout
   */
  const handleLogout = (req: express.Request, res: express.Response) => {
    const clientIp = getClientIp(req);
    const sessionToken = req.cookies?.admin_session;

    if (sessionToken) {
      invalidateAdminSession(sessionToken);
    }

    res.clearCookie('admin_session', { path: '/' });
    res.clearCookie('admin_csrf', { path: '/' });

    recordSecurityLog('ADMIN_LOGOUT', clientIp, 'Administrator logged out');

    if (req.path.startsWith('/auth/')) {
      return res.redirect('/');
    }
    return res.json({ success: true });
  };

  app.get('/auth/google/logout', handleLogout);
  app.post('/api/admin/logout', handleLogout);

  /**
   * 4. /api/admin/session
   * Verifies current session from HttpOnly cookie
   */
  app.get('/api/admin/session', (req, res) => {
    const sessionToken = req.cookies?.admin_session;
    if (!sessionToken) {
      return res.json({ authenticated: false });
    }

    const session = validateAdminSession(sessionToken);
    if (!session) {
      return res.json({ authenticated: false });
    }

    const authorizedEmail = getAuthorizedAdminEmail();
    if (session.email.toLowerCase() !== authorizedEmail) {
      invalidateAdminSession(sessionToken);
      res.clearCookie('admin_session', { path: '/' });
      res.clearCookie('admin_csrf', { path: '/' });
      return res.json({ authenticated: false });
    }

    return res.json({
      authenticated: true,
      csrfToken: session.csrfToken,
      user: {
        email: session.email,
        name: session.name,
        picture: session.picture,
      },
    });
  });

  // ==========================================
  // SENSITIVE ADMIN APIS (Protected by requireAdminAuth)
  // ==========================================

  // Admin Site Settings (GET/POST)
  app.get('/api/admin/settings', requireAdminAuth, (req, res) => {
    const custom = loadPersistedSettings();
    res.json({ settings: custom });
  });

  app.post('/api/admin/settings', requireAdminAuth, (req, res) => {
    const { settings } = req.body || {};
    if (settings) {
      savePersistedSettings(settings);
      const clientIp = getClientIp(req);
      const adminEmail = (req as any).adminSession?.email;
      recordSecurityLog('SETTINGS_UPDATED', clientIp, 'Admin updated global website settings', adminEmail);
      return res.json({ success: true });
    }
    return res.status(400).json({ error: 'Invalid settings payload' });
  });

  // Security Audit Logs
  app.get('/api/admin/logs', requireAdminAuth, (req, res) => {
    res.json({ logs: getSecurityLogs() });
  });

  // Upload Security Validator
  app.post('/api/admin/upload-validate', requireAdminAuth, (req, res) => {
    const { originalFilename, base64Content, allowedTypes } = req.body || {};
    if (!originalFilename || !base64Content) {
      return res.status(400).json({ error: 'Filename and base64 content are required' });
    }

    try {
      const buffer = Buffer.from(base64Content, 'base64');
      const permitted = Array.isArray(allowedTypes) ? allowedTypes : ['pdf', 'png', 'jpg', 'docx'];
      const result = validateUploadFile(buffer, originalFilename, permitted);

      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ valid: false, error: err.message || 'Validation error' });
    }
  });

  // ==========================================
  // VITE / SPA HANDLING
  // ==========================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Google OAuth Admin System active. Authorized email: ${getAuthorizedAdminEmail()}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
