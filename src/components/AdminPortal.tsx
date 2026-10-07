import React, { useEffect, useState } from 'react';

declare global {
  interface Window {
    google?: any;
  }
}

import {
  ShieldCheck,
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

import {
  Product,
  Category,
  GlobalSiteSettings,
} from '../types';

import { Logo } from './Logo';

const GOOGLE_CLIENT_ID =
  '406513640464-isus97avpm2dfqueioasa26cg6mh0am5.apps.googleusercontent.com';

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycby2sDyq2oT6x6GjBpoGXSTrsdupIbwqWqOkFrDRA9k7PRNpjWRjv3MMCZSvZnaX94WB/exec';

const AUTHORIZED_EMAIL = 'mihirkapuria@gmail.com';

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
  id?: string;
  timestamp: string;
  eventType?: string;
  action?: string;
  email?: string;
  adminEmail?: string;
  details: string;
}

interface BackendResponse {
  ok: boolean;
  error?: string;
  message?: string;
  user?: AdminUser;
  categories?: Category[];
  logs?: SecurityAuditLog[];
  auditLog?: SecurityAuditLog[];
  settings?: GlobalSiteSettings;
  valid?: boolean;
  detectedType?: string;
  sanitizedFilename?: string;
}

export const AdminPortal: React.FC<AdminPortalProps> = ({
  settings,
  onUpdateSettings,
  product,
  onUpdateProduct,
  categories,
  onUpdateCategories,
  onExitAdmin,
}) => {
  // ============================================================
  // AUTHENTICATION STATE
  // ============================================================

  const [isAuthenticated, setIsAuthenticated] =
    useState<boolean>(false);

  const [currentUser, setCurrentUser] =
    useState<AdminUser | null>(null);

  const [isCheckingAuth, setIsCheckingAuth] =
    useState<boolean>(true);

  const [authError, setAuthError] =
    useState<string | null>(null);

  const [authorizedEmail] =
    useState<string>(AUTHORIZED_EMAIL);

  // ============================================================
  // DASHBOARD STATE
  // ============================================================

  const [activeTab, setActiveTab] = useState<
    | 'pricing'
    | 'categories'
    | 'adsense'
    | 'oauth-guide'
    | 'upload-security'
    | 'security'
  >('pricing');

  const [auditLogs, setAuditLogs] =
    useState<SecurityAuditLog[]>([]);

  const [saveMessage, setSaveMessage] =
    useState<string | null>(null);

  // ============================================================
  // FORM STATE
  // ============================================================

  const [basePrice, setBasePrice] =
    useState(product.basePriceInr);

  const [gstRate, setGstRate] =
    useState(product.gstRatePercent);

  const [upiId, setUpiId] =
    useState(settings.payment.upiId);

  const [beneficiaryName, setBeneficiaryName] =
    useState(settings.payment.beneficiaryName);

  const [adsenseIsEnabled, setAdsenseIsEnabled] =
    useState(settings.adsense.isEnabled);

  const [adsensePublisherId, setAdsensePublisherId] =
    useState(settings.adsense.publisherId);

  // ============================================================
  // UPLOAD TEST STATE
  // ============================================================

  const [uploadTestFilename, setUploadTestFilename] =
    useState('');

  const [uploadTestResult, setUploadTestResult] =
    useState<BackendResponse | null>(null);

  const [isTestingUpload, setIsTestingUpload] =
    useState(false);

  // Category status toggle state
  const [updatingCategoryId, setUpdatingCategoryId] = useState<string | null>(null);
  const [categoryMessage, setCategoryMessage] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const handleToggleCategoryStatus = async (categoryId: string, currentStatus: boolean) => {
    setUpdatingCategoryId(categoryId);
    try {
      const res = await fetch('/api/admin/category-status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId, isActive: !currentStatus }),
      });
      const data = await res.json();
      if (data.ok && data.category) {
        onUpdateCategories(
          categories.map((c) => (c.id === categoryId ? { ...c, isActive: !currentStatus } : c))
        );
        setCategoryMessage(`Category '${data.category.name}' status updated to ${!currentStatus ? 'Enabled' : 'Disabled'}.`);
        setTimeout(() => setCategoryMessage(null), 4000);
      } else {
        setCategoryError(data.error || 'Failed to update category status.');
        setTimeout(() => setCategoryError(null), 4000);
      }
    } catch (err: any) {
      setCategoryError(err.message || 'Error updating category.');
      setTimeout(() => setCategoryError(null), 4000);
    } finally {
      setUpdatingCategoryId(null);
    }
  };

  // ============================================================
  // AUTHENTICATION CHECK
  // ============================================================

  const throwIfNotAuthenticated = () => {
    if (!isAuthenticated) {
      throw new Error(
        'Administrator authentication is required.'
      );
    }
  };

  // ============================================================
  // APPS SCRIPT BACKEND CALL
  // ============================================================

  const callBackend = async (
    action: string,
    extraData: Record<string, any> = {}
  ): Promise<BackendResponse> => {
    throwIfNotAuthenticated();

    const googleCredential =
      sessionStorage.getItem('admin_google_id_token');

    if (!googleCredential) {
      throw new Error(
        'Administrator authentication session has expired. Please sign in again.'
      );
    }

    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({
        action,
        idToken: googleCredential,
        ...extraData,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Server request failed with HTTP ${response.status}.`
      );
    }

    const data: BackendResponse =
      await response.json();

    if (!data.ok) {
      throw new Error(
        data.error ||
          'The administrator request was rejected.'
      );
    }

    return data;
  };

  // ============================================================
  // 1. INITIALIZE GOOGLE IDENTITY SERVICES
  // ============================================================

  useEffect(() => {
    let timer: number | undefined;
    let timeout: number | undefined;

    const initializeGoogleSignIn = () => {
      if (!window.google?.accounts?.id) {
        setAuthError(
          'Google Sign-In could not be loaded. Please refresh the page.'
        );

        setIsCheckingAuth(false);
        return;
      }

      try {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,

          callback: async (response: any) => {
            try {
              setAuthError(null);
              setIsCheckingAuth(true);

              const token = response?.credential;

              if (!token) {
                throw new Error(
                  'Google did not return an ID token.'
                );
              }

              // Store only for the current browser session.
              // Never store the Google ID token in localStorage.
              sessionStorage.setItem(
                'admin_google_id_token',
                token
              );

              // IMPORTANT:
              // The Apps Script backend does not have a
              // VERIFY_ADMIN action.
              //
              // GET_ADMIN_CATEGORIES is an authenticated
              // backend action. The backend verifies:
              //
              // - Google ID token
              // - issuer
              // - audience
              // - email verification
              // - authorized administrator email
              //
              // Only after successful verification does
              // the backend return the categories/audit data.

              const backendResponse =
                await fetch(APPS_SCRIPT_URL, {
                  method: 'POST',
                  redirect: 'follow',
                  headers: {
                    'Content-Type':
                      'text/plain;charset=utf-8',
                  },
                  body: JSON.stringify({
                    action: 'GET_ADMIN_CATEGORIES',
                    idToken: token,
                  }),
                });

              if (!backendResponse.ok) {
                throw new Error(
                  `Authentication server returned HTTP ${backendResponse.status}.`
                );
              }

              const data: BackendResponse =
                await backendResponse.json();

              if (!data.ok) {
                sessionStorage.removeItem(
                  'admin_google_id_token'
                );

                throw new Error(
                  data.error ||
                    'Administrator authentication failed.'
                );
              }

              const verifiedUser: AdminUser = {
                email:
                  data.user?.email ||
                  AUTHORIZED_EMAIL,
                name:
                  data.user?.name,
                picture:
                  data.user?.picture,
              };

              // If the backend returned categories,
              // synchronize them with the application.
              if (data.categories) {
                onUpdateCategories(data.categories);
              }

              // The backend currently calls this field auditLog.
              if (data.auditLog) {
                setAuditLogs(
                  data.auditLog.map((log, index) => ({
                    ...log,
                    id:
                      log.id ||
                      `${log.timestamp}-${log.action || log.eventType || index}`,
                    eventType:
                      log.eventType ||
                      log.action ||
                      'ADMIN_EVENT',
                    email:
                      log.email ||
                      log.adminEmail,
                  }))
                );
              }

              setCurrentUser(verifiedUser);
              setIsAuthenticated(true);
              setAuthError(null);

            } catch (error: any) {
              console.error(
                'Google authentication error:',
                error
              );

              sessionStorage.removeItem(
                'admin_google_id_token'
              );

              setIsAuthenticated(false);
              setCurrentUser(null);

              setAuthError(
                error?.message ||
                  'Administrator authentication failed.'
              );

            } finally {
              setIsCheckingAuth(false);
            }
          },
        });

        setIsCheckingAuth(false);

      } catch (error: any) {
        console.error(
          'Google Identity initialization error:',
          error
        );

        setAuthError(
          error?.message ||
            'Unable to initialize Google Sign-In.'
        );

        setIsCheckingAuth(false);
      }
    };

    // Google Identity Services may load asynchronously.
    if (window.google?.accounts?.id) {
      initializeGoogleSignIn();
      return;
    }

    timer = window.setInterval(() => {
      if (window.google?.accounts?.id) {
        if (timer) {
          window.clearInterval(timer);
        }

        initializeGoogleSignIn();
      }
    }, 100);

    timeout = window.setTimeout(() => {
      if (timer) {
        window.clearInterval(timer);
      }

      if (!window.google?.accounts?.id) {
        setAuthError(
          'Google Sign-In could not be loaded. Please refresh the page.'
        );

        setIsCheckingAuth(false);
      }
    }, 10000);

    return () => {
      if (timer) {
        window.clearInterval(timer);
      }

      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, [onUpdateCategories]);

  // ============================================================
  // 2. RENDER GOOGLE SIGN-IN BUTTON
  // ============================================================

  useEffect(() => {
    if (
      isAuthenticated ||
      isCheckingAuth
    ) {
      return;
    }

    const renderGoogleButton = () => {
      const container =
        document.getElementById(
          'google-signin-button'
        );

      if (
        !container ||
        !window.google?.accounts?.id
      ) {
        return false;
      }

      container.innerHTML = '';

      window.google.accounts.id.renderButton(
        container,
        {
          theme: 'outline',
          size: 'large',
          width: 360,
          text: 'signin_with',
        }
      );

      return true;
    };

    if (renderGoogleButton()) {
      return;
    }

    const timer = window.setInterval(() => {
      if (renderGoogleButton()) {
        window.clearInterval(timer);
      }
    }, 100);

    const timeout = window.setTimeout(() => {
      window.clearInterval(timer);
    }, 10000);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, [
    isAuthenticated,
    isCheckingAuth,
    authError,
  ]);

  // ============================================================
  // 3. LOAD SECURITY LOGS
  // ============================================================

  const loadAuditLogs = async () => {
    if (!isAuthenticated) {
      return;
    }

    try {
      const data = await callBackend(
        'GET_ADMIN_LOGS'
      );

      setAuditLogs(
        (data.logs || []).map(
          (log, index) => ({
            ...log,
            id:
              log.id ||
              `${log.timestamp}-${log.action || log.eventType || index}`,
            eventType:
              log.eventType ||
              log.action ||
              'ADMIN_EVENT',
            email:
              log.email ||
              log.adminEmail,
          })
        )
      );

    } catch (error: any) {
      console.error(
        'Unable to load audit logs:',
        error
      );

      setAuditLogs([]);
    }
  };

  useEffect(() => {
    if (
      isAuthenticated &&
      activeTab === 'security'
    ) {
      loadAuditLogs();
    }
  }, [
    isAuthenticated,
    activeTab,
  ]);

  // ============================================================
  // 4. LOGOUT
  // ============================================================

  const handleLogout = () => {
    sessionStorage.removeItem(
      'admin_google_id_token'
    );

    setIsAuthenticated(false);
    setCurrentUser(null);
    setAuthError(null);
    setAuditLogs([]);

    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch {
        // Ignore Google logout UI errors.
      }
    }
  };

  // ============================================================
  // 5. SAVE SETTINGS
  // ============================================================

  const handleSaveSettings = async () => {
    const updatedProduct: Product = {
      ...product,
      basePriceInr:
        Number(basePrice),
      gstRatePercent:
        Number(gstRate),
    };

    const updatedSettings:
      GlobalSiteSettings = {
      ...settings,

      payment: {
        ...settings.payment,
        upiId,
        beneficiaryName,
      },

      adsense: {
        ...settings.adsense,
        isEnabled:
          adsenseIsEnabled,
        publisherId:
          adsensePublisherId,
      },
    };

    // Update local application state immediately.
    onUpdateProduct(updatedProduct);
    onUpdateSettings(updatedSettings);

    try {
      await callBackend(
        'SAVE_ADMIN_SETTINGS',
        {
          product: updatedProduct,
          settings: updatedSettings,
        }
      );

      setSaveMessage(
        'All configuration changes have been securely saved and applied.'
      );

      window.setTimeout(() => {
        setSaveMessage(null);
      }, 3500);

    } catch (error: any) {
      console.error(
        'Save settings error:',
        error
      );

      setSaveMessage(
        `Save failed: ${
          error?.message ||
          'Server error'
        }`
      );
    }
  };

  // ============================================================
  // 6. FILE UPLOAD SECURITY TEST
  // ============================================================

  const handleFileTest = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file =
      e.target.files?.[0];

    if (!file) {
      return;
    }

    setUploadTestFilename(
      file.name
    );

    setIsTestingUpload(true);
    setUploadTestResult(null);

    const reader =
      new FileReader();

    reader.onload = async () => {
      try {
        const resultString =
          reader.result as string;

        const base64Content =
          resultString.split(',')[1];

        if (!base64Content) {
          throw new Error(
            'Unable to read the selected file.'
          );
        }

        const result =
          await callBackend(
            'VALIDATE_UPLOAD',
            {
              originalFilename:
                file.name,

              base64Content,

              allowedTypes: [
                'pdf',
                'png',
                'jpg',
                'docx',
              ],
            }
          );

        setUploadTestResult(
          result
        );

      } catch (error: any) {
        console.error(
          'Upload validation error:',
          error
        );

        setUploadTestResult({
          ok: false,
          valid: false,
          error:
            error?.message ||
            'Upload validation failed.',
        });

      } finally {
        setIsTestingUpload(false);
      }
    };

    reader.onerror = () => {
      setIsTestingUpload(false);

      setUploadTestResult({
        ok: false,
        valid: false,
        error:
          'The browser could not read this file.',
      });
    };

    reader.readAsDataURL(file);
  };

  // ============================================================
  // AUTHENTICATION CHECK SCREEN
  // ============================================================

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-stone-950 flex items-center justify-center text-stone-300">
        <div className="flex items-center gap-2 font-mono text-xs">
          <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />

          <span>
            Verifying administrator session...
          </span>
        </div>
      </div>
    );
  }

  // ============================================================
  // VIEW 1: GOOGLE ADMIN SIGN-IN
  // ============================================================

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-stone-950 flex flex-col justify-center items-center p-4 font-sans text-stone-100 selection:bg-amber-500 selection:text-stone-950">

        <div className="w-full max-w-md bg-stone-900 border border-stone-800 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">

          <div className="text-center space-y-3">

            <div className="flex justify-center pb-1">
              <Logo
                size="lg"
                theme="dark"
                showBadge={false}
              />
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold">

              <Lock className="w-3.5 h-3.5" />

              <span>
                Admin Portal Login
              </span>

            </div>

            <p className="text-xs text-stone-400 max-w-xs mx-auto">
              Access is restricted exclusively to the authorized administrator via Google Sign-In.
            </p>

          </div>

          <div className="bg-stone-950 border border-stone-800 rounded-xl p-3.5 space-y-1.5 text-xs">

            <div className="flex items-center justify-between text-stone-400">

              <span>
                Sole Authorized Account:
              </span>

              <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded font-mono">
                Required
              </span>

            </div>

            <p className="text-white font-mono font-medium text-xs break-all">
              {authorizedEmail}
            </p>

            <p className="text-[11px] text-stone-500">
              The server verifies the Google ID token before administrator access is granted.
            </p>

          </div>

          {authError && (
            <div className="bg-rose-950/80 border border-rose-800/80 text-rose-300 p-3.5 rounded-xl text-xs flex items-start gap-2.5">

              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />

              <div className="space-y-1">

                <p className="font-semibold">
                  Authentication Rejected
                </p>

                <p className="text-[11px] leading-relaxed">
                  {authError}
                </p>

              </div>

            </div>
          )}

          <div className="space-y-3 pt-2">

            <div
              id="google-signin-button"
              className="flex justify-center min-h-[44px]"
            />

            <p className="text-[11px] text-stone-500 text-center">
              Only {authorizedEmail} is authorized to access this portal.
            </p>

          </div>

          <div className="pt-2 text-center border-t border-stone-800">

            <button
              onClick={onExitAdmin}
              className="text-xs text-stone-500 hover:text-stone-300 transition flex items-center justify-center gap-1.5 mx-auto"
            >

              <ArrowLeft className="w-3.5 h-3.5" />

              <span>
                Return to Public Website
              </span>

            </button>

          </div>

        </div>

      </div>
    );
  }

  // ============================================================
  // VIEW 2: AUTHENTICATED ADMIN DASHBOARD
  // ============================================================

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col font-sans text-stone-900 selection:bg-amber-100 selection:text-amber-900">

      {/* HEADER */}

      <header className="bg-stone-950 text-white border-b border-stone-800 sticky top-0 z-30">

        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">

          <div className="flex items-center gap-3">

            <Logo
              size="sm"
              theme="dark"
              showBadge={false}
            />

            <div className="hidden sm:block h-6 w-px bg-stone-800" />

            <div>

              <div className="flex items-center gap-2">

                <h1 className="text-xs sm:text-sm font-semibold tracking-tight text-stone-200">
                  Admin Control Panel
                </h1>

                <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-1.5 py-0.5 rounded font-mono font-medium">
                  Google Verified
                </span>

              </div>

              <p className="text-[11px] text-stone-400 flex items-center gap-1">

                <span>
                  Authenticated Admin:
                </span>

                <span className="text-stone-200 font-mono font-medium">
                  {currentUser?.email}
                </span>

              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <button
              onClick={handleSaveSettings}
              className="bg-amber-500 hover:bg-amber-400 text-stone-950 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-xs cursor-pointer"
            >

              <Save className="w-3.5 h-3.5" />

              <span className="hidden sm:inline">
                Save All Settings
              </span>

            </button>

            <button
              onClick={handleLogout}
              className="bg-stone-900 hover:bg-stone-800 text-stone-300 hover:text-white px-2.5 py-1.5 rounded-lg text-xs transition border border-stone-800 flex items-center gap-1.5 cursor-pointer"
              title="Sign out of Admin session"
            >

              <LogOut className="w-3.5 h-3.5 text-stone-400" />

              <span>
                Logout
              </span>

            </button>

            <button
              onClick={onExitAdmin}
              className="text-stone-400 hover:text-stone-200 text-xs transition flex items-center gap-1 pl-2 border-l border-stone-800"
              title="Return to public site"
            >

              <ArrowLeft className="w-3.5 h-3.5" />

              <span className="hidden sm:inline">
                Public Site
              </span>

            </button>

          </div>

        </div>

        {/* TAB NAVIGATION */}

        <div className="max-w-6xl mx-auto px-4 flex items-center gap-1 sm:gap-2 overflow-x-auto text-xs border-t border-stone-900">

          <button
            onClick={() => setActiveTab('pricing')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'pricing'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>
              Pricing & GST Rules
            </span>
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

            <span>
              Categories
            </span>
          </button>

          <button
            onClick={() => setActiveTab('adsense')}
            className={`py-2.5 px-3 border-b-2 font-medium flex items-center gap-1.5 transition whitespace-nowrap ${
              activeTab === 'adsense'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>
              AdSense Controls
            </span>
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

            <span>
              Google OAuth Setup
            </span>
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

            <span>
              File & Upload Safety
            </span>
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

            <span>
              Security & Audit Logs
            </span>
          </button>

        </div>

      </header>

      {/* MAIN CONTENT */}

      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">

        {saveMessage && (
          <div className="bg-emerald-50 border border-emerald-300 text-emerald-900 p-3 rounded-xl text-xs flex items-center gap-2">

            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />

            <span>
              {saveMessage}
            </span>

          </div>
        )}

        {/* PRICING */}

        {activeTab === 'pricing' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-6">

            <div>

              <h2 className="text-base font-bold text-stone-900">
                Subscription Pricing & GST Billing Rules
              </h2>

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
                  onChange={(e) =>
                    setBasePrice(
                      Number(e.target.value)
                    )
                  }
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
                  onChange={(e) =>
                    setGstRate(
                      Number(e.target.value)
                    )
                  }
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
                  onChange={(e) =>
                    setUpiId(e.target.value)
                  }
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
                  onChange={(e) =>
                    setBeneficiaryName(
                      e.target.value
                    )
                  }
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

                <span>
                  Save Pricing Changes
                </span>

              </button>

            </div>

          </div>
        )}

        {/* CATEGORIES */}

        {activeTab === 'categories' && (
          <div className="space-y-6">

            {categoryMessage && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs px-4 py-3 rounded-xl flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{categoryMessage}</span>
              </div>
            )}

            {categoryError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs px-4 py-3 rounded-xl flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{categoryError}</span>
              </div>
            )}

            {/* SECTION 1: SYSTEM B — NEW INDIA NEWS CATEGORIES */}
            <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stone-100 pb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-stone-900">
                      India News Categories
                    </h2>
                    <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-semibold">
                      System B • 10 Categories
                    </span>
                  </div>
                  <p className="text-stone-500 text-xs mt-0.5">
                    Independent Enable/Disable controls for the 10 India categories. Disabling a category halts news generation and Telegram delivery for that category only.
                  </p>
                </div>
                <div className="text-xs text-stone-500">
                  <span className="font-semibold text-stone-800">
                    {categories.filter((c) => (c.system === 'india' || c.id.startsWith('cat_india_')) && c.id !== 'cat_india_healthcare' && c.id !== 'cat_india_pe_vc' && c.id !== 'cat_india_coffee_nespresso' && c.id !== 'cat_india_oil_gas' && c.id !== 'cat_india_wedding_cards' && c.id !== 'cat_india_gems_jewellery' && c.isActive).length} / 10
                  </span> Active
                </div>
              </div>

              <div className="divide-y divide-stone-100 text-xs">
                {categories
                  .filter((c) => (c.system === 'india' || c.id.startsWith('cat_india_')) && c.id !== 'cat_india_healthcare' && c.id !== 'cat_india_pe_vc' && c.id !== 'cat_india_coffee_nespresso' && c.id !== 'cat_india_oil_gas' && c.id !== 'cat_india_wedding_cards' && c.id !== 'cat_india_gems_jewellery')
                  .map((c) => (
                    <div
                      key={c.id}
                      className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-stone-900">
                            {c.name}
                          </span>
                          <span className="text-[10px] bg-stone-100 text-stone-600 px-2 py-0.5 rounded font-mono">
                            {c.id}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                              c.isActive
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-stone-100 text-stone-500 border border-stone-200'
                            }`}
                          >
                            {c.isActive ? 'Active' : 'Disabled'}
                          </span>
                        </div>
                        <p className="text-stone-500 text-[11px]">
                          {c.description}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={updatingCategoryId === c.id}
                          onClick={() => handleToggleCategoryStatus(c.id, c.isActive)}
                          className={`px-3 py-1.5 rounded-lg font-medium text-xs transition cursor-pointer flex items-center gap-1.5 ${
                            c.isActive
                              ? 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
                              : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-xs'
                          } ${updatingCategoryId === c.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          {updatingCategoryId === c.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : c.isActive ? (
                            <span>Disable Category</span>
                          ) : (
                            <span>Enable Category</span>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            {/* SECTION 2: SYSTEM A — EXISTING SPECIALIST NEWS CATEGORIES */}
            <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stone-100 pb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-stone-900">
                      Specialist News Categories
                    </h2>
                    <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-semibold">
                      System A • 7 Working Specialist Categories
                    </span>
                  </div>
                  <p className="text-stone-500 text-xs mt-0.5">
                    Existing working product stream. Uses dedicated specialist Telegram bot and delivery pipeline.
                  </p>
                </div>
                <div className="text-xs text-stone-500">
                  <span className="font-semibold text-stone-800">
                    {categories.filter((c) => c.system === 'specialist' || c.id === 'cat_japan_re' || c.id === 'cat_india_healthcare' || c.id === 'cat_india_pe_vc' || c.id === 'cat_india_coffee_nespresso' || c.id === 'cat_india_oil_gas' || c.id === 'cat_india_wedding_cards' || c.id === 'cat_india_gems_jewellery').filter((c) => c.isActive).length} / 7
                  </span> Active
                </div>
              </div>

              <div className="divide-y divide-stone-100 text-xs">
                {categories
                  .filter((c) => c.system === 'specialist' || c.id === 'cat_japan_re' || c.id === 'cat_india_healthcare' || c.id === 'cat_india_pe_vc' || c.id === 'cat_india_coffee_nespresso' || c.id === 'cat_india_oil_gas' || c.id === 'cat_india_wedding_cards' || c.id === 'cat_india_gems_jewellery')
                  .map((c) => (
                    <div
                      key={c.id}
                      className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-stone-900">
                            {c.name}
                          </span>
                          <span className="text-[10px] bg-stone-100 text-stone-600 px-2 py-0.5 rounded font-mono">
                            {c.id}
                          </span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                              c.isActive
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-stone-100 text-stone-500 border border-stone-200'
                            }`}
                          >
                            {c.isActive ? 'Active' : 'Disabled'}
                          </span>
                        </div>
                        <p className="text-stone-500 text-[11px]">
                          {c.description}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={updatingCategoryId === c.id}
                          onClick={() => handleToggleCategoryStatus(c.id, c.isActive)}
                          className={`px-3 py-1.5 rounded-lg font-medium text-xs transition cursor-pointer flex items-center gap-1.5 ${
                            c.isActive
                              ? 'bg-stone-100 text-stone-700 border border-stone-200 hover:bg-stone-200'
                              : 'bg-stone-900 text-white hover:bg-stone-800'
                          } ${updatingCategoryId === c.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          {updatingCategoryId === c.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : c.isActive ? (
                            <span>Deactivate</span>
                          ) : (
                            <span>Activate</span>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>

          </div>
        )}

        {/* ADSENSE */}

        {activeTab === 'adsense' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">

            <h2 className="text-base font-bold text-stone-900">
              Google AdSense Configuration
            </h2>

            <div className="space-y-3 text-xs">

              <label className="flex items-center gap-2 cursor-pointer">

                <input
                  type="checkbox"
                  checked={adsenseIsEnabled}
                  onChange={(e) =>
                    setAdsenseIsEnabled(
                      e.target.checked
                    )
                  }
                  className="rounded border-stone-300 text-amber-600 focus:ring-amber-500"
                />

                <span className="font-semibold text-stone-800">
                  Enable AdSense Monetization
                </span>

              </label>

              <div>

                <label className="block text-stone-700 font-semibold mb-1">
                  AdSense Publisher ID
                </label>

                <input
                  type="text"
                  value={adsensePublisherId}
                  onChange={(e) =>
                    setAdsensePublisherId(
                      e.target.value
                    )
                  }
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

        {/* OAUTH GUIDE */}

        {activeTab === 'oauth-guide' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-6">

            <div>

              <h2 className="text-base font-bold text-stone-900">
                Google OAuth / Identity Configuration
              </h2>

              <p className="text-xs text-stone-500 mt-0.5">
                Configuration information for the administrator Google Identity setup.
              </p>

            </div>

            <div className="space-y-4 text-xs">

              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-2">

                <h3 className="font-bold text-stone-900 flex items-center gap-1.5">

                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />

                  <span>
                    1. Google Identity Services
                  </span>

                </h3>

                <p className="text-stone-600 leading-relaxed">
                  The browser uses Google Identity Services to obtain an ID token. The token is sent to the Apps Script backend for server-side verification.
                </p>

              </div>

              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3">

                <h3 className="font-bold text-stone-900">
                  2. Authorized Administrator
                </h3>

                <div className="p-3 bg-stone-900 text-stone-100 rounded-lg font-mono text-[11px]">

                  <p className="text-amber-400 font-bold">
                    Authorized Account:
                  </p>

                  <p className="select-all">
                    {AUTHORIZED_EMAIL}
                  </p>

                </div>

              </div>

              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-2">

                <h3 className="font-bold text-stone-900">
                  3. Google Client ID
                </h3>

                <div className="p-3 bg-stone-900 text-stone-200 font-mono text-[11px] rounded-lg select-all break-all">
                  {GOOGLE_CLIENT_ID}
                </div>

                <p className="text-[11px] text-stone-500 pt-1">
                  The Google Client ID is public configuration. A Google OAuth client secret must never be placed in this frontend file.
                </p>

              </div>

              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">

                <p className="text-amber-900 leading-relaxed">
                  Administrator authorization is ultimately decided by the Apps Script backend after cryptographic verification of the Google ID token. The frontend must not be trusted to determine whether an account is authorized.
                </p>

              </div>

            </div>

          </div>
        )}

        {/* FILE UPLOAD SECURITY */}

        {activeTab === 'upload-security' && (
          <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-5">

            <div>

              <h2 className="text-base font-bold text-stone-900">
                File Upload & Malware Protection Module
              </h2>

              <p className="text-xs text-stone-500 mt-0.5">
                Multi-layer verification: binary magic-byte signature checks, safe filenames, and directory traversal defense.
              </p>

            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">

              <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl space-y-3">

                <h3 className="font-bold text-stone-900 flex items-center gap-2">

                  <FileCheck className="w-4 h-4 text-emerald-600" />

                  <span>
                    Binary Signature Protection
                  </span>

                </h3>

                <p className="text-stone-600 leading-relaxed">
                  The server should inspect the binary content rather than trusting the filename extension. Renaming an executable to a document extension must not be sufficient to pass validation.
                </p>

                <ul className="space-y-1.5 text-stone-600 list-disc list-inside">

                  <li>
                    <strong>MyDigitAsset:</strong> PDF briefs and dossiers, JPG/PNG images
                  </li>

                  <li>
                    <strong>MyJobGrowth:</strong> PDF/DOCX resume validation
                  </li>

                  <li>
                    <strong>MyFlixAI:</strong> MP4 and audio validation
                  </li>

                  <li>
                    <strong>MyMoneyLuck:</strong> PDF statements and financial proof documents
                  </li>

                </ul>

              </div>

              <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl space-y-3">

                <h3 className="font-bold text-stone-900 flex items-center gap-2">

                  <Upload className="w-4 h-4 text-amber-600" />

                  <span>
                    Interactive Security Validator Test
                  </span>

                </h3>

                <p className="text-stone-600">
                  Select a test file to send it to the server-side validator.
                </p>

                <label className="block border-2 border-dashed border-stone-300 hover:border-amber-500 p-4 rounded-xl text-center cursor-pointer transition bg-white">

                  <Upload className="w-5 h-5 text-stone-400 mx-auto mb-1" />

                  <span className="text-xs font-semibold text-stone-700">
                    Choose File to Validate
                  </span>

                  <input
                    type="file"
                    className="hidden"
                    onChange={handleFileTest}
                  />

                </label>

                {uploadTestFilename && (
                  <p className="text-[10px] text-stone-500 font-mono break-all">
                    Selected: {uploadTestFilename}
                  </p>
                )}

                {isTestingUpload && (
                  <div className="flex items-center gap-2 text-stone-500 font-mono text-[11px]">

                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />

                    <span>
                      Analyzing binary byte headers...
                    </span>

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
                      {uploadTestResult.valid
                        ? '✓ Passed Binary Validation'
                        : '✕ Rejected by Security Filter'}
                    </p>

                    {uploadTestResult.valid ? (
                      <div>

                        <p>
                          Detected Format:{' '}
                          {uploadTestResult.detectedType?.toUpperCase()}
                        </p>

                        <p className="font-mono text-[10px] break-all">
                          Safe Random ID:{' '}
                          {uploadTestResult.sanitizedFilename}
                        </p>

                      </div>
                    ) : (
                      <p>
                        {uploadTestResult.error}
                      </p>
                    )}

                  </div>
                )}

              </div>

            </div>

          </div>
        )}

        {/* SECURITY AUDIT */}

        {activeTab === 'security' && (
          <div className="space-y-4">

            <div className="bg-stone-900 text-white p-5 rounded-2xl space-y-3">

              <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs uppercase tracking-wider">

                <ShieldCheck className="w-4 h-4" />

                Google Identity Security Active

              </div>

              <p className="text-xs text-stone-300 leading-relaxed">
                Administrator access is granted only after the Apps Script backend verifies the Google ID token and confirms the authorized administrator identity.
              </p>

              <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[11px]">

                <span className="bg-stone-800 border border-stone-700 px-2.5 py-1 rounded text-stone-300">
                  Authorized Identity: {authorizedEmail}
                </span>

                <span className="bg-stone-800 border border-stone-700 px-2.5 py-1 rounded text-stone-300">
                  No IP Logging
                </span>

                <span className="bg-stone-800 border border-stone-700 px-2.5 py-1 rounded text-stone-300">
                  Session Token: Browser Session Only
                </span>

              </div>

            </div>

            <div className="bg-white border border-stone-200 rounded-2xl p-5 sm:p-6 space-y-4">

              <div className="flex items-center justify-between">

                <div>

                  <h3 className="text-sm font-bold text-stone-900">
                    Security Audit Trail
                  </h3>

                  <p className="text-xs text-stone-500">
                    Administrative authentication events and configuration changes.
                  </p>

                </div>

                <button
                  onClick={loadAuditLogs}
                  className="text-xs bg-stone-100 hover:bg-stone-200 text-stone-700 px-2.5 py-1 rounded-lg transition flex items-center gap-1 cursor-pointer"
                >

                  <RefreshCw className="w-3 h-3" />

                  <span>
                    Refresh
                  </span>

                </button>

              </div>

              <div className="divide-y divide-stone-100 max-h-96 overflow-y-auto font-mono text-xs">

                {auditLogs.length === 0 ? (

                  <p className="text-xs text-stone-400 py-4 text-center font-sans">
                    No security events recorded yet.
                  </p>

                ) : (

                  auditLogs.map((log, index) => (

                    <div
                      key={
                        log.id ||
                        `${log.timestamp}-${index}`
                      }
                      className="py-2.5 flex items-start justify-between gap-2"
                    >

                      <div>

                        <div className="flex items-center gap-2">

                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              log.eventType ===
                              'GOOGLE_LOGIN_SUCCESS'
                                ? 'bg-emerald-100 text-emerald-800'
                                : log.eventType ===
                                  'GOOGLE_LOGIN_UNAUTHORIZED_ACCOUNT'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-stone-200 text-stone-800'
                            }`}
                          >
                            {log.eventType ||
                              log.action ||
                              'ADMIN_EVENT'}
                          </span>

                          <span className="text-stone-700 text-[11px] font-semibold">
                            {log.details}
                          </span>

                        </div>

                        <div className="text-[10px] text-stone-400 flex items-center gap-2 mt-0.5">

                          {log.email && (
                            <span>
                              Account: {log.email}
                            </span>
                          )}

                        </div>

                      </div>

                      <span className="text-[10px] text-stone-400 whitespace-nowrap">

                        {new Date(
                          log.timestamp
                        ).toLocaleTimeString(
                          [],
                          {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          }
                        )}

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
