import React, { useState, useEffect } from 'react';
declare global {
  interface Window {
    google?: any;
  }
}
import {
  ShieldCheck,
  ShieldAlert,
  LogOut,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  Layers,
  Activity,
  Save,
  RefreshCw,
  FileCheck,
  Upload,
  Globe,
  Lock,
} from 'lucide-react';
import { Product, Category, GlobalSiteSettings } from '../types';
import { Logo } from './Logo';

interface AdminPortalProps {
  settings: GlobalSiteSettings;
  onUpdateSettings: (s: GlobalSiteSettings) => void;
  product: Product;
  onUpdateProduct: (p: Product) => void;
  categories: Category[];
  onUpdateCategories: (c: Category[]) => void;
  onExitAdmin: () => void;
}

interface AdminUser {
  email: string;
  name?: string;
  picture?: string;
}

interface SecurityAuditLog {
  id: string;
  timestamp: string;
  eventType: string;
  clientIp: string;
  email?: string;
  details: string;
}

export const AdminPortal: React.FC<AdminPortalProps> = ({
  settings,
  onUpdateSettings,
  product,
  onUpdateProduct,
  categories,
  onExitAdmin,
}) => {
  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [currentUser, setCurrentUser] = useState<AdminUser | null>(null);
  const [csrfToken, setCsrfToken] = useState<string>('');
  const [isCheckingAuth, setIsCheckingAuth] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Status Info
  const [authorizedEmail, setAuthorizedEmail] = useState<string>('mihirkapuria@gmail.com');
  const [isGoogleConfigured, setIsGoogleConfigured] = useState<boolean>(false);

  // Dashboard Tab State
  const [activeTab, setActiveTab] = useState<
    'pricing' | 'categories' | 'adsense' | 'subscribers' | 'oauth-guide' | 'upload-security' | 'security'
  >('pricing');

  // Audit Logs State
  const [auditLogs, setAuditLogs] = useState<SecurityAuditLog[]>([]);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Form states for Dashboard settings
  const [basePrice, setBasePrice] = useState(product.basePriceInr);
  const [gstRate, setGstRate] = useState(product.gstRatePercent);
  const [upiId, setUpiId] = useState(settings.payment.upiId);
  const [beneficiaryName, setBeneficiaryName] = useState(settings.payment.beneficiaryName);
  const [adsenseIsEnabled, setAdsenseIsEnabled] = useState(settings.adsense.isEnabled);
  const [adsensePublisherId, setAdsensePublisherId] = useState(settings.adsense.publisherId);

  // File Upload Security Test Tool State
  const [uploadTestFilename, setUploadTestFilename] = useState('');
  const [uploadTestResult, setUploadTestResult] = useState<any>(null);
  const [isTestingUpload, setIsTestingUpload] = useState(false);

  // 1. Fetch OAuth status, check existing session, and check URL for OAuth errors
  useEffect(() => {
    // Check URL parameters for authentication errors
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) {
      if (err === 'oauth_cancelled') {
        setAuthError('Google sign-in was cancelled or interrupted.');
      } else if (err === 'unauthorized_account') {
        const attemptedEmail = params.get('email');
        setAuthError(
          attemptedEmail
            ? `Access Denied: The Google account (${attemptedEmail}) is not authorized.`
            : 'Access Denied: The Google account used is not authorized.'
        );
      } else {
        setAuthError(decodeURIComponent(err));
      }
      // Clean query string from browser bar without reload
      window.history.replaceState({}, '', '/admin');
    }

    const checkSessionAndConfig = async () => {
      try {
        // Fetch Auth Status
        const statusRes = await fetch('/api/admin/auth-status');
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (statusData.authorizedEmail) {
            setAuthorizedEmail(statusData.authorizedEmail);
          }
          setIsGoogleConfigured(statusData.isConfigured);
        }

        // Check active session via HttpOnly cookie
        const sessionRes = await fetch('/api/admin/session');
        if (sessionRes.ok) {
          const sessionData = await sessionRes.json();
          if (sessionData.authenticated && sessionData.user) {
            setIsAuthenticated(true);
            setCurrentUser(sessionData.user);
            if (sessionData.csrfToken) {
              setCsrfToken(sessionData.csrfToken);
            }
          }
        }
      } catch (err) {
        console.error('Session check error:', err);
      } finally {
        setIsCheckingAuth(false);
      }
    };

    checkSessionAndConfig();
  }, []);

  // 2. Fetch security audit logs when tab is selected
  useEffect(() => {
    if (isAuthenticated && activeTab === 'security') {
      fetch('/api/admin/logs')
        .then((res) => (res.ok ? res.json() : { logs: [] }))
        .then((data) => setAuditLogs(data.logs || []))
        .catch(() => {});
    }
  }, [isAuthenticated, activeTab]);

  // Handle Logout
  const handleLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } catch {}
    setIsAuthenticated(false);
    setCurrentUser(null);
    setCsrfToken('');
  };

  // Handle Save Dashboard Settings (Protected with CSRF token)
  const handleSaveSettings = async () => {
    const updatedProduct = {
      ...product,
      basePriceInr: Number(basePrice),
      gstRatePercent: Number(gstRate),
    };

    const updatedSettings: GlobalSiteSettings = {
      ...settings,
      payment: {
        ...settings.payment,
        upiId,
        beneficiaryName,
      },
      adsense: {
        ...settings.adsense,
        isEnabled: adsenseIsEnabled,
        publisherId: adsensePublisherId,
      },
    };

    onUpdateProduct(updatedProduct);
    onUpdateSettings(updatedSettings);

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ settings: updatedSettings, _csrf: csrfToken }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save settings');
      }

      setSaveMessage('All configuration changes have been securely saved and applied.');
      setTimeout(() => setSaveMessage(null), 3500);
    } catch (err: any) {
      setSaveMessage(`Save failed: ${err.message || 'Server error'}`);
    }
  };

  // Handle File Upload Security Demonstration (Protected with CSRF token)
  const handleFileTest = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadTestFilename(file.name);
    setIsTestingUpload(true);
    setUploadTestResult(null);

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Content = (reader.result as string).split(',')[1];
      try {
        const res = await fetch('/api/admin/upload-validate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            originalFilename: file.name,
            base64Content,
            allowedTypes: ['pdf', 'png', 'jpg', 'docx'],
            _csrf: csrfToken,
          }),
        });
        const result = await res.json();
        setUploadTestResult(result);
      } catch (err: any) {
        setUploadTestResult({ valid: false, error: err.message });
      } finally {
        setIsTestingUpload(false);
      }
    };
    reader.readAsDataURL(file);
  };

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-stone-950 flex items-center justify-center text-stone-300">
        <div className="flex items-center gap-2 font-mono text-xs">
          <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
          <span>Verifying administrator session...</span>
        </div>
      </div>
    );
  }

  // ==========================================
  // VIEW 1: GOOGLE ADMIN SIGN-IN SCREEN (ONLY GOOGLE OAUTH 2.0)
  // ==========================================
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-stone-950 flex flex-col justify-center items-center p-4 font-sans text-stone-100 selection:bg-amber-500 selection:text-stone-950">
        <div className="w-full max-w-md bg-stone-900 border border-stone-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
          <div className="text-center space-y-3">
            <div className="flex justify-center pb-1">
              <Logo size="lg" theme="dark" showBadge={false} />
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold">
              <Lock className="w-3.5 h-3.5" />
              <span>Admin Portal Login</span>
            </div>
            <p className="text-xs text-stone-400 max-w-xs mx-auto">
              Access is restricted exclusively to the authorized administrator via Google OAuth 2.0.
            </p>
          </div>

          {/* Configured Admin Notice */}
          <div className="bg-stone-950 border border-stone-800 rounded-xl p-3.5 space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-stone-400">
              <span>Sole Authorized Account:</span>
              <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded font-mono">
                Required
              </span>
            </div>
            <p className="text-white font-mono font-medium text-xs break-all">
              {authorizedEmail}
            </p>
            <p className="text-[11px] text-stone-500">
              Only this exact Google account will be granted access upon cryptographic token verification.
            </p>
          </div>

          {/* Error Message */}
          {authError && (
            <div className="bg-rose-950/80 border border-rose-800/80 text-rose-300 p-3.5 rounded-xl text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold">Authentication Rejected</p>
                <p className="text-[11px] leading-relaxed">{authError}</p>
              </div>
            </div>
          )}

          {/* Google Sign-In Action (Pure OAuth 2.0 endpoint) */}
          <div className="space-y-3 pt-2">
            <a
              href="/auth/google/login"
              className="w-full bg-white hover:bg-stone-100 text-stone-900 border border-stone-300 font-semibold py-3 px-4 rounded-xl text-xs sm:text-sm transition flex items-center justify-center gap-3 shadow-md cursor-pointer group"
            >
              <svg className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Sign in with Google</span>
            </a>

            {!isGoogleConfigured && (
              <p className="text-[11px] text-amber-400/90 text-center leading-relaxed">
                Note: Server Google OAuth credentials must be set in <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.
              </p>
            )}
          </div>

          <div className="pt-2 text-center border-t border-stone-800">
            <button
              onClick={onExitAdmin}
              className="text-xs text-stone-500 hover:text-stone-300 transition flex items-center justify-center gap-1.5 mx-auto"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Return to Public Website</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // VIEW 2: AUTHENTICATED ADMIN DASHBOARD
  // ==========================================
  return (
    <div className="min-h-screen bg-stone-100 flex flex-col font-sans text-stone-900 selection:bg-amber-100 selection:text-amber-900">
      {/* Top Header */}
      <header className="bg-stone-950 text-white border-b border-stone-800 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size="sm" theme="dark" showBadge={false} />
            <div className="hidden sm:block h-6 w-px bg-stone-800" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xs sm:text-sm font-semibold tracking-tight text-stone-200">Admin Control Panel</h1>
                <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-1.5 py-0.5 rounded font-mono font-medium">
                  Google Verified
                </span>
              </div>
              <p className="text-[11px] text-stone-400 flex items-center gap-1">
                <span>Authenticated Admin:</span>
                <span className="text-stone-200 font-mono font-medium">{currentUser?.email}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveSettings}
              className="bg-amber-500 hover:bg-amber-400 text-stone-950 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-xs cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Save All Settings</span>
            </button>

            <button
              onClick={handleLogout}
              className="bg-stone-900 hover:bg-stone-800 text-stone-300 hover:text-white px-2.5 py-1.5 rounded-lg text-xs transition border border-stone-800 flex items-center gap-1.5 cursor-pointer"
              title="Sign out of Admin session"
            >
              <LogOut className="w-3.5 h-3.5 text-stone-400" />
              <span>Logout</span>
            </button>

            <button
              onClick={onExitAdmin}
              className="text-stone-400 hover:text-stone-200 text-xs transition flex items-center gap-1 pl-2 border-l border-stone-800"
              title="Return to public site"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Public Site</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-6xl mx-auto px-4 flex items-center gap-1 sm:gap-2 overflow-x-auto text-xs border-t border-stone-900">
          <button
            onClick={() => setActiveTab('pricing')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'pricing'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>Pricing & GST Rules</span>
          </button>

          <button
            onClick={() => setActiveTab('categories')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'categories'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Categories</span>
          </button>

          <button
            onClick={() => setActiveTab('adsense')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'adsense'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>AdSense Controls</span>
          </button>

          <button
            onClick={() => setActiveTab('oauth-guide')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'oauth-guide'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Google OAuth Setup</span>
          </button>

          <button
            onClick={() => setActiveTab('upload-security')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'upload-security'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <FileCheck className="w-3.5 h-3.5" />
            <span>File & Upload Safety</span>
          </button>

          <button
            onClick={() => setActiveTab('security')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'security'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Security & Audit Logs</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {saveMessage && (
          <div className="bg-emerald-50 border border-emerald-300 text-emerald-900 p-3 rounded-xl text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{saveMessage}</span>
          </div>
        )}

        {/* TAB 1: PRICING & GST */}
        {activeTab === 'pricing' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-6">
            <div>
              <h2 className="text-base font-bold text-stone-900">Subscription Pricing & GST Billing Rules</h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Configure annual subscription fee, GST tax percentage, and payment reconciliation details for MyDigitAsset.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Annual Subscription Base Price (INR ₹)
                </label>
                <input
                  type="number"
                  value={basePrice}
                  onChange={(e) => setBasePrice(Number(e.target.value))}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs font-semibold focus:border-stone-800 outline-hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  GST Rate Percentage (%)
                </label>
                <input
                  type="number"
                  value={gstRate}
                  onChange={(e) => setGstRate(Number(e.target.value))}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs font-semibold focus:border-stone-800 outline-hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  UPI VPA / ID for Instant Reader Payments
                </label>
                <input
                  type="text"
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs font-mono focus:border-stone-800 outline-hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Beneficiary / Merchant Name
                </label>
                <input
                  type="text"
                  value={beneficiaryName}
                  onChange={(e) => setBeneficiaryName(e.target.value)}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs font-medium focus:border-stone-800 outline-hidden"
                />
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={handleSaveSettings}
                className="bg-stone-900 hover:bg-stone-800 text-white font-semibold px-4 py-2 rounded-lg text-xs transition flex items-center gap-1.5 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Pricing Changes</span>
              </button>
            </div>
          </div>
        )}

        {/* TAB 2: CATEGORIES */}
        {activeTab === 'categories' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <h2 className="text-base font-bold text-stone-900">Active News Verticals</h2>
            <div className="divide-y divide-stone-100 text-xs">
              {categories.map((c) => (
                <div key={c.id} className="py-3 flex items-center justify-between">
                  <div>
                    <span className="font-semibold text-stone-900">{c.name}</span>
                    <p className="text-stone-500 text-[11px]">{c.description}</p>
                  </div>
                  <span className="text-[10px] bg-stone-100 text-stone-600 px-2 py-0.5 rounded font-mono">
                    ID: {c.id}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: ADSENSE */}
        {activeTab === 'adsense' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <h2 className="text-base font-bold text-stone-900">Google AdSense Configuration</h2>
            <div className="space-y-3 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={adsenseIsEnabled}
                  onChange={(e) => setAdsenseIsEnabled(e.target.checked)}
                  className="rounded border-stone-300 text-amber-600 focus:ring-amber-500"
                />
                <span className="font-semibold text-stone-800">Enable AdSense Monetization</span>
              </label>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">AdSense Publisher ID</label>
                <input
                  type="text"
                  value={adsensePublisherId}
                  onChange={(e) => setAdsensePublisherId(e.target.value)}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 font-mono text-xs"
                />
              </div>

              <button
                onClick={handleSaveSettings}
                className="bg-stone-900 hover:bg-stone-800 text-white font-semibold px-4 py-2 rounded-lg text-xs transition cursor-pointer"
              >
                Save AdSense Settings
              </button>
            </div>
          </div>
        )}

        {/* TAB 4: GOOGLE OAUTH CONFIGURATION GUIDE */}
        {activeTab === 'oauth-guide' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-6">
            <div>
              <h2 className="text-base font-bold text-stone-900">Google OAuth 2.0 Credentials Setup</h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Exact instructions for configuring your Google Cloud Console Web Application credentials.
              </p>
            </div>

            <div className="space-y-4 text-xs">
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                <h3 className="font-bold text-stone-900 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>1. Google Cloud Project & Consent Screen</span>
                </h3>
                <p className="text-stone-600 leading-relaxed">
                  Go to <strong>console.cloud.google.com</strong>. Under <strong>OAuth consent screen</strong>, set App Name to <em>Admin Portal</em> and Support Email to <strong>mihirkapuria@gmail.com</strong>.
                </p>
                <p className="text-stone-600">
                  Required Scopes: Select strictly <strong>openid</strong>, <strong>email</strong>, and <strong>profile</strong>. (Do not request Gmail, Drive, Calendar or any other Google services).
                </p>
              </div>

              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">
                <h3 className="font-bold text-stone-900">
                  2. Authorized Redirect URIs
                </h3>
                <p className="text-stone-600">
                  Under <strong>Credentials → Create Credentials → OAuth Client ID</strong> (Application type: <em>Web application</em>), add the following Authorized Redirect URI:
                </p>

                <div className="p-3 bg-stone-900 text-stone-100 rounded-lg font-mono text-[11px] space-y-1">
                  <p className="text-amber-400 font-bold">Authorized Redirect URI:</p>
                  <p className="select-all">https://www.mydigitasset.com/auth/google/callback</p>
                </div>
              </div>

              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                <h3 className="font-bold text-stone-900">3. Server Environment Variables</h3>
                <p className="text-stone-600">
                  Copy the Client ID and Client Secret from Google Cloud Console into your server environment variables:
                </p>
                <div className="p-3 bg-stone-900 text-stone-200 font-mono text-[11px] rounded-lg space-y-1 select-all">
                  <p>ADMIN_EMAIL=mihirkapuria@gmail.com</p>
                  <p>ADMIN_RECOVERY_EMAIL=mihirkapuria@gmail.com</p>
                  <p>GOOGLE_CLIENT_ID=&lt;actual Google OAuth client ID&gt;</p>
                  <p>GOOGLE_CLIENT_SECRET=&lt;actual Google OAuth client secret&gt;</p>
                </div>
                <p className="text-[11px] text-stone-500 pt-1">
                  The Google Client Secret is held strictly on the server and is never exposed to the frontend browser.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: FILE UPLOAD & MALWARE SECURITY MODULE */}
        {activeTab === 'upload-security' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-stone-900">File Upload & Malware Protection Module</h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Multi-layer verification: binary magic bytes signature checks, unguessable random filenames, directory traversal defense.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl space-y-3">
                <h3 className="font-bold text-stone-900 flex items-center gap-2">
                  <FileCheck className="w-4 h-4 text-emerald-600" />
                  <span>Binary Signature (Magic Bytes) Protection</span>
                </h3>
                <p className="text-stone-600 leading-relaxed">
                  Malicious attackers often disguise dangerous executables by renaming them (e.g. <code className="bg-stone-200 px-1 py-0.5 rounded">virus.exe.pdf</code>). Our module inspects the binary magic bytes in memory to ensure real PDFs start with <code className="bg-stone-200 px-1 py-0.5 rounded">%PDF</code>, PNGs start with PNG headers, and videos match valid container formats.
                </p>
                <ul className="space-y-1.5 text-stone-600 list-disc list-inside">
                  <li><strong>MyDigitAsset:</strong> PDF briefs & dossiers, JPG/PNG images</li>
                  <li><strong>MyJobGrowth:</strong> Strict PDF/DOCX resume validation</li>
                  <li><strong>MyFlixAI:</strong> Validated MP4 containers, audio streams</li>
                  <li><strong>MyMoneyLuck:</strong> PDF statements & financial proof docs</li>
                </ul>
              </div>

              <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl space-y-3">
                <h3 className="font-bold text-stone-900 flex items-center gap-2">
                  <Upload className="w-4 h-4 text-amber-600" />
                  <span>Interactive Security Validator Test</span>
                </h3>
                <p className="text-stone-600">
                  Select any test file to inspect how the server validates binary signatures and generates safe filenames:
                </p>

                <label className="block border-2 border-dashed border-stone-300 hover:border-amber-500 p-4 rounded-xl text-center cursor-pointer transition bg-white">
                  <Upload className="w-5 h-5 text-stone-400 mx-auto mb-1" />
                  <span className="text-xs font-semibold text-stone-700">Choose File to Validate</span>
                  <input
                    type="file"
                    className="hidden"
                    onChange={handleFileTest}
                  />
                </label>

                {isTestingUpload && (
                  <div className="flex items-center gap-2 text-stone-500 font-mono text-[11px]">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Analyzing binary byte headers...</span>
                  </div>
                )}

                {uploadTestResult && (
                  <div
                    className={`p-3 rounded-xl border text-[11px] space-y-1 ${
                      uploadTestResult.valid
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                        : 'bg-rose-50 border-rose-300 text-rose-900'
                    }`}
                  >
                    <p className="font-bold">
                      {uploadTestResult.valid ? '✓ Passed Binary Validation' : '✕ Rejected by Security Filter'}
                    </p>
                    {uploadTestResult.valid ? (
                      <div>
                        <p>Detected Format: {uploadTestResult.detectedType?.toUpperCase()}</p>
                        <p className="font-mono text-[10px] break-all">Safe Random ID: {uploadTestResult.sanitizedFilename}</p>
                      </div>
                    ) : (
                      <p>{uploadTestResult.error}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 6: SECURITY AUDIT TRAIL */}
        {activeTab === 'security' && (
          <div className="space-y-4">
            <div className="bg-stone-900 text-white p-5 rounded-2xl space-y-3">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs uppercase tracking-wider">
                <ShieldCheck className="w-4 h-4" /> Google OAuth 2.0 Identity Security Active
              </div>
              <p className="text-xs text-stone-300 leading-relaxed">
                All Admin sessions are issued exclusively after verifying cryptographic signatures from Google's OpenID Connect endpoints. Session cookies are HTTP-only, secure, and isolated from frontend JavaScript.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[11px]">
                <span className="bg-stone-800 border border-stone-700 px-2.5 py-1 rounded text-stone-300">
                  Authorized Identity: {authorizedEmail}
                </span>
                <span className="bg-stone-800 border border-stone-700 px-2.5 py-1 rounded text-stone-300">
                  Cookie: HTTP-Only (SameSite=Lax)
                </span>
                <span className="bg-stone-800 border border-stone-700 px-2.5 py-1 rounded text-stone-300">
                  Inactivity Timeout: 8 Hours
                </span>
              </div>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-stone-900">Security Audit Trail</h3>
                  <p className="text-xs text-stone-500">Real-time log of Google authentication events and administrative changes.</p>
                </div>
                <button
                  onClick={() => {
                    fetch('/api/admin/logs')
                      .then((res) => (res.ok ? res.json() : { logs: [] }))
                      .then((data) => setAuditLogs(data.logs || []));
                  }}
                  className="text-xs bg-stone-100 hover:bg-stone-200 text-stone-700 px-2.5 py-1 rounded-lg transition flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Refresh</span>
                </button>
              </div>

              <div className="divide-y divide-stone-100 max-h-96 overflow-y-auto font-mono text-xs">
                {auditLogs.length === 0 ? (
                  <p className="text-xs text-stone-400 py-4 text-center font-sans">No security events recorded yet.</p>
                ) : (
                  auditLogs.map((log) => (
                    <div key={log.id} className="py-2.5 flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              log.eventType === 'GOOGLE_LOGIN_SUCCESS'
                                ? 'bg-emerald-100 text-emerald-800'
                                : log.eventType === 'GOOGLE_LOGIN_UNAUTHORIZED_ACCOUNT'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-stone-200 text-stone-800'
                            }`}
                          >
                            {log.eventType}
                          </span>
                          <span className="text-stone-700 text-[11px] font-semibold">{log.details}</span>
                        </div>
                        <div className="text-[10px] text-stone-400 flex items-center gap-2 mt-0.5">
                          <span>IP: {log.clientIp}</span>
                          {log.email && <span>• Account: {log.email}</span>}
                        </div>
                      </div>
                      <span className="text-[10px] text-stone-400 whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
