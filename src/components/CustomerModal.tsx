import React, { useState, useEffect } from 'react';
import {
  X,
  User,
  Mail,
  Phone,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  LogOut,
  Edit2,
  Lock,
  Layers,
  Send,
  ExternalLink,
  RefreshCw,
  Unlink,
  Copy,
  Check,
  Calendar,
  Clock,
  ArrowRight,
  Info,
  QrCode,
} from 'lucide-react';
import {
  Customer,
  Category,
  Subscription,
  SubscriptionCategory,
  Payment,
  Product,
  GlobalSiteSettings,
} from '../types';

interface CustomerModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer | null;
  categories: Category[];
  onCustomerUpdated: (customer: Customer | null) => void;
  onProceedToPayment?: () => void;
  product?: Product;
  settings?: GlobalSiteSettings;
}

export const CustomerModal: React.FC<CustomerModalProps> = ({
  isOpen,
  onClose,
  customer,
  categories,
  onCustomerUpdated,
  onProceedToPayment,
  product,
  settings,
}) => {
  // Registration form state
  const [fullName, setFullName] = useState(customer?.fullName || '');
  const [email, setEmail] = useState(customer?.email || '');
  const [countryCode, setCountryCode] = useState(customer?.mobileCountryCode || '+91');
  const [mobileNumber, setMobileNumber] = useState(customer?.mobileNumber || '');
  const [selectedCats, setSelectedCats] = useState<string[]>(
    customer?.selectedCategoryIds && customer.selectedCategoryIds.length > 0
      ? customer.selectedCategoryIds
      : ['cat_india_startups']
  );

  // Subscriptions & Payment state
  const [userSubs, setUserSubs] = useState<Array<{ subscription: Subscription; categories: SubscriptionCategory[] }>>([]);
  const [userPayments, setUserPayments] = useState<Payment[]>([]);
  const [subStatusData, setSubStatusData] = useState<any | null>(null);

  // Payment proof submission state (Stage 2 Section 7, 8, 10)
  const [paymentProofRef, setPaymentProofRef] = useState('');
  const [isSubmittingProof, setIsSubmittingProof] = useState(false);
  const [showProofForm, setShowProofForm] = useState(false);
  const [copiedUpi, setCopiedUpi] = useState(false);

  // Renewal request state (Stage 2 Section 9)
  const [isRequestingRenewal, setIsRequestingRenewal] = useState(false);
  const [renewalSubmitted, setRenewalSubmitted] = useState(false);

  // Mobile edit state for existing customer (Stage 2 Section 10)
  const [isEditingMobile, setIsEditingMobile] = useState(false);
  const [newCountryCode, setNewCountryCode] = useState(customer?.mobileCountryCode || '+91');
  const [newMobileNumber, setNewMobileNumber] = useState(customer?.mobileNumber || '');

  // Telegram connection state (Stage 2 Section 5 & 6)
  const [tgTokenData, setTgTokenData] = useState<{
    token: string;
    deepLink: string;
    expiresAt: string;
    botUsername: string;
    isConfigured: boolean;
  } | null>(null);
  const [isGeneratingTgToken, setIsGeneratingTgToken] = useState(false);
  const [isCheckingTgStatus, setIsCheckingTgStatus] = useState(false);
  const [isDisconnectingTg, setIsDisconnectingTg] = useState(false);
  const [copiedTgLink, setCopiedTgLink] = useState(false);
  const [tgLinkExpired, setTgLinkExpired] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  // India Telegram connection state (System B: India Edition)
  const [indiaTgTokenData, setIndiaTgTokenData] = useState<{
    deepLink: string;
    expiresAt: string;
    botUsername: string;
    isConfigured: boolean;
  } | null>(null);
  const [isGeneratingIndiaTgToken, setIsGeneratingIndiaTgToken] = useState(false);
  const [isCheckingIndiaTgStatus, setIsCheckingIndiaTgStatus] = useState(false);
  const [isDisconnectingIndiaTg, setIsDisconnectingIndiaTg] = useState(false);
  const [copiedIndiaTgLink, setCopiedIndiaTgLink] = useState(false);
  const [indiaTgLinkExpired, setIndiaTgLinkExpired] = useState(false);
  const [indiaTgError, setIndiaTgError] = useState<string | null>(null);

  // General state
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Pricing calculations
  const effectiveBasePrice = product?.basePriceInr || 252;
  const effectiveGstRate = product?.gstRatePercent || 18;
  const effectiveGstAmount = Number(((effectiveBasePrice * effectiveGstRate) / 100).toFixed(2));
  const effectiveTotal = (effectiveBasePrice + effectiveGstAmount).toFixed(2);
  const effectiveUpiId = settings?.payment?.upiId || '9876543210@upi';
  const effectiveBeneficiary = settings?.payment?.beneficiaryName || 'MyDigitAsset News Pvt Ltd';

  // Synchronize internal form state when customer changes
  useEffect(() => {
    if (customer) {
      setFullName(customer.fullName);
      setEmail(customer.email);
      setCountryCode(customer.mobileCountryCode);
      setMobileNumber(customer.mobileNumber);
      setNewCountryCode(customer.mobileCountryCode);
      setNewMobileNumber(customer.mobileNumber);
      if (customer.selectedCategoryIds && customer.selectedCategoryIds.length > 0) {
        setSelectedCats(customer.selectedCategoryIds);
      }
      if (customer.renewalRequested) {
        setRenewalSubmitted(true);
      }
    }
  }, [customer]);

  // Check token expiry timer
  useEffect(() => {
    if (!tgTokenData?.expiresAt) {
      setTgLinkExpired(false);
      return;
    }
    const checkExpiry = () => {
      const now = new Date().getTime();
      const expiry = new Date(tgTokenData.expiresAt).getTime();
      if (now >= expiry) {
        setTgLinkExpired(true);
      }
    };
    checkExpiry();
    const interval = setInterval(checkExpiry, 10000);
    return () => clearInterval(interval);
  }, [tgTokenData]);

  // Check India token expiry timer
  useEffect(() => {
    if (!indiaTgTokenData?.expiresAt) {
      setIndiaTgLinkExpired(false);
      return;
    }
    const checkExpiry = () => {
      const now = new Date().getTime();
      const expiry = new Date(indiaTgTokenData.expiresAt).getTime();
      if (now >= expiry) {
        setIndiaTgLinkExpired(true);
      }
    };
    checkExpiry();
    const interval = setInterval(checkExpiry, 10000);
    return () => clearInterval(interval);
  }, [indiaTgTokenData]);

  // India Telegram connection status polling & focus refresh
  useEffect(() => {
    if (!customer || !isOpen) return;

    const checkIndiaStatus = async () => {
      try {
        const res = await fetch('/api/customer/telegram-india/status');
        const data = await res.json();
        if (data.ok && typeof data.indiaTelegramConnected === 'boolean') {
          if (data.indiaTelegramConnected !== Boolean(customer.indiaTelegramConnected)) {
            onCustomerUpdated({
              ...customer,
              indiaTelegramConnected: data.indiaTelegramConnected,
            });
            if (data.indiaTelegramConnected) {
              setIndiaTgTokenData(null);
              setSuccessMsg(`India Telegram connected successfully! Connected to @${data.botUsername || 'MyDigitAssetIndiaBot'}.`);
            }
          }
        }
      } catch (_) {
        // Silently catch background poll errors
      }
    };

    checkIndiaStatus();

    let pollInterval: NodeJS.Timeout | null = null;
    if (indiaTgTokenData && !customer.indiaTelegramConnected && !indiaTgLinkExpired) {
      pollInterval = setInterval(checkIndiaStatus, 3500);
    }

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        checkIndiaStatus();
      }
    };

    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    return () => {
      if (pollInterval) clearInterval(pollInterval);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    };
  }, [customer, isOpen, indiaTgTokenData, indiaTgLinkExpired]);

  // Fetch safe subscription status, subscriptions, and payments
  const fetchSafeStatus = () => {
    if (!customer) return;
    fetch('/api/customer/subscription-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.ok) {
          setSubStatusData(data);
          if (data.renewalRequested) setRenewalSubmitted(true);
        }
      })
      .catch(() => {});

    fetch('/api/customer/telegram-india/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.ok && typeof data.indiaTelegramConnected === 'boolean') {
          if (customer && data.indiaTelegramConnected !== Boolean(customer.indiaTelegramConnected)) {
            onCustomerUpdated({
              ...customer,
              indiaTelegramConnected: data.indiaTelegramConnected,
            });
          }
        }
      })
      .catch(() => {});

    fetch('/api/customer/subscriptions')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.ok && Array.isArray(data.subscriptions)) {
          setUserSubs(data.subscriptions);
        }
      })
      .catch(() => {});

    fetch('/api/customer/payments')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.ok && Array.isArray(data.payments)) {
          setUserPayments(data.payments);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (customer && isOpen) {
      fetchSafeStatus();
    }
  }, [customer, isOpen]);

  if (!isOpen) return null;

  // Format dates cleanly without recalculating
  const formatDate = (isoString?: string | null) => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return String(isoString);
    }
  };

  const handleCategoryToggle = (catId: string) => {
    setSelectedCats((prev) => {
      if (prev.includes(catId)) {
        if (prev.length === 1) return prev;
        return prev.filter((id) => id !== catId);
      } else {
        return [...prev, catId];
      }
    });
  };

  const handleSelectAllCategories = () => {
    setSelectedCats(categories.filter((c) => c.isActive).map((c) => c.id));
  };

  // Submit registration / login
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/customer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim(),
          mobileCountryCode: countryCode.trim(),
          mobileNumber: mobileNumber.trim(),
          selectedCategoryIds: selectedCats,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Registration could not be completed. Please check your details and try again.');
      }

      onCustomerUpdated(data.customer);
      setSuccessMsg('Welcome to MyDigitAsset! Your subscriber account is ready.');
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred during registration. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Update mobile number (Stage 2 Section 10)
  const handleUpdateMobile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/customer/mobile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mobileCountryCode: newCountryCode.trim(),
          mobileNumber: newMobileNumber.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not update mobile number. Please check and try again.');
      }

      onCustomerUpdated(data.customer);
      setIsEditingMobile(false);
      setSuccessMsg('Your mobile number has been updated successfully.');
    } catch (err: any) {
      setErrorMsg(err.message || 'Unable to update mobile number.');
    } finally {
      setIsLoading(false);
    }
  };

  // Logout (Stage 2 Section 11)
  const handleLogout = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/customer/logout', { method: 'POST' });
    } catch (_) {
      // Continue cleanup on client
    } finally {
      onCustomerUpdated(null);
      setTgTokenData(null);
      setIndiaTgTokenData(null);
      setFullName('');
      setEmail('');
      setMobileNumber('');
      setIsLoading(false);
      onClose();
    }
  };

  // Generate Telegram connection token (Stage 2 Section 5 & 6)
  const handleGenerateTelegramToken = async () => {
    setIsGeneratingTgToken(true);
    setErrorMsg(null);
    setTgError(null);
    try {
      const res = await fetch('/api/customer/telegram/token', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not initiate Telegram connection. Please try again.');
      }
      setTgTokenData(data);
      setTgLinkExpired(false);
    } catch (err: any) {
      setTgError(err.message || 'Something went wrong while connecting Telegram. Please try again.');
    } finally {
      setIsGeneratingTgToken(false);
    }
  };

  // Check Telegram connection status manually (Stage 2 Section 6)
  const handleCheckTelegramStatus = async () => {
    setIsCheckingTgStatus(true);
    setTgError(null);
    try {
      const meRes = await fetch('/api/customer/me');
      const meData = await meRes.json();
      if (meData.ok && meData.customer) {
        onCustomerUpdated(meData.customer);
        if (meData.customer.telegramConnected) {
          setSuccessMsg('Telegram connected successfully! Your morning briefings are active.');
          setTgTokenData(null);
          fetchSafeStatus();
        } else {
          setSuccessMsg('Waiting for connection. Please tap START in the Telegram app.');
        }
      }
    } catch (_) {
      setTgError('Unable to check Telegram status. Please verify your connection.');
    } finally {
      setIsCheckingTgStatus(false);
    }
  };

  // Disconnect Telegram (Stage 2 Section 6)
  const handleDisconnectTelegram = async () => {
    setIsDisconnectingTg(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/customer/telegram/disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not disconnect Telegram.');
      }
      setSuccessMsg('Telegram account unlinked.');
      setTgTokenData(null);
      const meRes = await fetch('/api/customer/me');
      const meData = await meRes.json();
      if (meData.ok && meData.customer) {
        onCustomerUpdated(meData.customer);
      }
      fetchSafeStatus();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not disconnect Telegram account.');
    } finally {
      setIsDisconnectingTg(false);
    }
  };

  // Generate India Telegram connection token (System B: India Edition)
  const handleGenerateIndiaTelegramToken = async () => {
    setIsGeneratingIndiaTgToken(true);
    setErrorMsg(null);
    setIndiaTgError(null);
    try {
      const res = await fetch('/api/customer/telegram-india/token', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not initiate India Telegram connection. Please try again.');
      }
      setIndiaTgTokenData({
        deepLink: data.deepLink,
        expiresAt: data.expiresAt,
        botUsername: data.botUsername || 'MyDigitAssetIndiaBot',
        isConfigured: data.isConfigured !== false,
      });
      setIndiaTgLinkExpired(false);
    } catch (err: any) {
      setIndiaTgError(err.message || 'Something went wrong while connecting India Telegram. Please try again.');
    } finally {
      setIsGeneratingIndiaTgToken(false);
    }
  };

  // Check India Telegram connection status manually
  const handleCheckIndiaTelegramStatus = async () => {
    setIsCheckingIndiaTgStatus(true);
    setIndiaTgError(null);
    try {
      const res = await fetch('/api/customer/telegram-india/status');
      const data = await res.json();
      if (data.ok) {
        if (customer) {
          onCustomerUpdated({
            ...customer,
            indiaTelegramConnected: Boolean(data.indiaTelegramConnected),
          });
        }
        if (data.indiaTelegramConnected) {
          setSuccessMsg(`Connected to India News Bot (@${data.botUsername || 'MyDigitAssetIndiaBot'}) successfully!`);
          setIndiaTgTokenData(null);
          fetchSafeStatus();
        } else {
          setSuccessMsg('Waiting for connection. Please open Telegram and tap START.');
        }
      } else {
        throw new Error(data.error || 'Could not verify status.');
      }
    } catch (err: any) {
      setIndiaTgError(err.message || 'Unable to check India Telegram status. Please verify your connection.');
    } finally {
      setIsCheckingIndiaTgStatus(false);
    }
  };

  // Disconnect from India Telegram
  const handleDisconnectIndiaTelegram = async () => {
    setIsDisconnectingIndiaTg(true);
    setErrorMsg(null);
    setIndiaTgError(null);
    try {
      const res = await fetch('/api/customer/telegram-india/disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not disconnect from India News Bot.');
      }
      setSuccessMsg('Disconnected from India News Bot.');
      setIndiaTgTokenData(null);
      if (customer) {
        onCustomerUpdated({
          ...customer,
          indiaTelegramConnected: false,
        });
      }
      fetchSafeStatus();
    } catch (err: any) {
      setIndiaTgError(err.message || 'Could not disconnect India Telegram account.');
    } finally {
      setIsDisconnectingIndiaTg(false);
    }
  };

  // Submit payment reference / UTR (Stage 2 Section 7 & 8)
  const handleSubmitPaymentProof = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanRef = paymentProofRef.trim();
    if (!cleanRef || cleanRef.length < 6) {
      setErrorMsg('Please enter a valid 12-digit UPI UTR or payment reference number.');
      return;
    }

    setIsSubmittingProof(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/customer/submit-payment-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentReference: cleanRef,
          categoryIds: customer?.selectedCategoryIds,
          amount: Number(effectiveTotal),
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Your payment reference could not be submitted. Please check it and try again.');
      }

      setSuccessMsg('Payment proof submitted successfully! Your submission is pending administrative verification.');
      setPaymentProofRef('');
      setShowProofForm(false);
      fetchSafeStatus();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not submit payment reference. Please try again.');
    } finally {
      setIsSubmittingProof(false);
    }
  };

  // Request annual renewal (Stage 2 Section 9)
  const handleRequestRenewal = async () => {
    setIsRequestingRenewal(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/customer/request-renewal-trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Renewal request could not be submitted. Please try again.');
      }

      setRenewalSubmitted(true);
      setSuccessMsg('Renewal request received. Our desk has logged your request for priority processing.');
      fetchSafeStatus();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not record renewal request.');
    } finally {
      setIsRequestingRenewal(false);
    }
  };

  // Determine current authoritative subscription state (Stage 2 Section 3)
  const activeSub = userSubs[0]?.subscription || subStatusData?.subscription;
  const isPaymentPending = subStatusData?.paymentStatus === 'pending';
  const hasActivePaidSub = Boolean(subStatusData?.hasActiveSubscription || (activeSub && activeSub.status === 'active'));
  const isBufferActive = subStatusData?.deliveryPhase === 'buffer';
  const isTrialActive = subStatusData?.trialStatus === 'active' && !hasActivePaidSub;
  const isExpired = subStatusData?.accountStatus === 'inactive' || (activeSub && activeSub.status === 'expired');

  return (
    <div
      id="customer-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isLoading && !isSubmittingProof) onClose();
      }}
      className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4"
    >
      <div
        id="customer-modal-dialog"
        className="bg-white rounded-2xl max-w-xl w-full shadow-2xl border border-stone-200 overflow-hidden relative animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="bg-stone-900 text-white p-5 sm:p-6 relative border-b border-stone-800">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-stone-400 hover:text-white bg-stone-800/80 hover:bg-stone-700 p-2 rounded-lg transition"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-amber-400 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> MyDigitAsset Subscriber Account
            </span>
          </div>

          <h2 className="text-lg sm:text-xl font-bold font-serif text-white">
            {customer ? customer.fullName : 'Subscriber Registration'}
          </h2>
          <p className="text-xs text-stone-300 mt-0.5">
            {customer
              ? 'Your private executive subscription status, delivery channel, and payment details.'
              : 'Sign up to activate your daily executive morning briefings across PE/VC, startups, and healthcare.'}
          </p>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-5 sm:p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {/* Notification Messages */}
          {errorMsg && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs p-3.5 rounded-xl flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold block">Notice</span>
                <span>{errorMsg}</span>
              </div>
            </div>
          )}

          {successMsg && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs p-3.5 rounded-xl flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold block">Success</span>
                <span>{successMsg}</span>
              </div>
            </div>
          )}

          {/* VIEW A: REGISTERED CUSTOMER DASHBOARD */}
          {customer ? (
            <div className="space-y-4">
              {/* SECTION 3: VISUAL STATUS AREA */}
              <div className="rounded-xl border p-4 space-y-3 bg-stone-50 border-stone-200">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-stone-500">
                    Subscription Status
                  </span>
                  <span className="text-xs text-stone-400">
                    Daily 6:00–7:00 AM IST
                  </span>
                </div>

                {/* State 1: Payment Pending Verification */}
                {isPaymentPending && (
                  <div className="bg-amber-50/80 border border-amber-300/80 rounded-lg p-3.5 space-y-1.5 text-xs">
                    <div className="flex items-center gap-2 text-amber-900 font-bold">
                      <Clock className="w-4 h-4 text-amber-600" />
                      <span>Payment Under Review</span>
                    </div>
                    <p className="text-amber-800 leading-relaxed text-[11px]">
                      Your payment reference has been submitted and is currently awaiting administrative verification. Our desk will verify your receipt shortly and activate your continuous 5-day courtesy buffer + 12-month paid period.
                    </p>
                    {subStatusData?.latestPaymentReference && (
                      <p className="text-[11px] font-mono text-amber-950 font-semibold pt-1">
                        Submitted Reference: {subStatusData.latestPaymentReference}
                      </p>
                    )}
                  </div>
                )}

                {/* State 2: Courtesy Buffer Active (Continuous delivery) */}
                {isBufferActive && activeSub?.bufferStartDate && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3.5 space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-emerald-900 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>Courtesy Buffer Period Active (News Delivery Active)</span>
                    </div>
                    <div className="text-stone-700 text-[11px] space-y-1">
                      <p>
                        <strong>News Delivery Started:</strong> {formatDate(activeSub.bufferStartDate)}
                      </p>
                      <p>
                        <strong>Courtesy Buffer Window (5 Days):</strong> {formatDate(activeSub.bufferStartDate)} – {formatDate(activeSub.bufferEndDate)}
                      </p>
                      <p>
                        <strong>12-Month Paid Subscription Begins:</strong> {formatDate(activeSub.paidStartDate)}
                      </p>
                    </div>
                    <p className="text-[11px] text-emerald-800 font-medium pt-1 border-t border-emerald-100">
                      ✓ News is delivered continuously across both the buffer and paid subscription periods without any gap.
                    </p>
                  </div>
                )}

                {/* State 3: Active Paid Subscription */}
                {hasActivePaidSub && !isBufferActive && activeSub && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3.5 space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-emerald-900 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>Active Annual Paid Subscription</span>
                    </div>
                    <div className="text-stone-700 text-[11px] space-y-1">
                      <p>
                        <strong>Paid Subscription Period:</strong> {formatDate(activeSub.paidStartDate || activeSub.startDate)} – {formatDate(activeSub.paidEndDate || activeSub.expiryDate)}
                      </p>
                    </div>
                    <p className="text-[11px] text-emerald-800 font-medium">
                      ✓ Executive briefings are delivered every morning directly to your connected Telegram.
                    </p>
                  </div>
                )}

                {/* State 4: Free Trial Active */}
                {isTrialActive && !isPaymentPending && (
                  <div className="bg-stone-100 border border-stone-300 rounded-lg p-3.5 space-y-1 text-xs">
                    <div className="flex items-center gap-2 text-stone-900 font-bold">
                      <Clock className="w-4 h-4 text-amber-600" />
                      <span>Complimentary Trial Active</span>
                    </div>
                    <p className="text-stone-600 text-[11px] leading-relaxed">
                      You are currently enjoying your 3-day complimentary executive trial. To avoid any gap in your morning briefings, submit your annual subscription payment reference below.
                    </p>
                  </div>
                )}

                {/* State 5: Renewal Requested */}
                {renewalSubmitted && (
                  <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 space-y-1 text-xs">
                    <div className="flex items-center gap-1.5 text-sky-950 font-bold">
                      <Info className="w-4 h-4 text-sky-600" />
                      <span>Renewal Request Received</span>
                    </div>
                    <p className="text-sky-800 text-[11px]">
                      Your request for subscription renewal has been recorded and is queued for priority administrative review.
                    </p>
                  </div>
                )}

                {/* State 6: Expired */}
                {isExpired && (
                  <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-1 text-xs">
                    <div className="flex items-center gap-1.5 text-rose-950 font-bold">
                      <AlertCircle className="w-4 h-4 text-rose-600" />
                      <span>Subscription Concluded</span>
                    </div>
                    <p className="text-rose-800 text-[11px]">
                      Your subscription period has ended. Submit your renewal payment reference to resume receiving daily briefings.
                    </p>
                  </div>
                )}
              </div>

              {/* CONNECT TELEGRAM (INDIA) SECTION */}
              <div className="border border-stone-200 rounded-xl p-4 space-y-3 bg-white">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-stone-900 block">Connect Telegram (India)</span>
                    <span className="text-[11px] text-stone-500">
                      Receive your subscribed India news briefings directly in your private Telegram chat.
                    </span>
                  </div>
                  <div>
                    {customer.indiaTelegramConnected ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                        <Send className="w-3.5 h-3.5 text-amber-600" /> Not Connected
                      </span>
                    )}
                  </div>
                </div>

                {indiaTgError && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-800 text-[11px] p-2.5 rounded-lg flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                    <span>{indiaTgError}</span>
                  </div>
                )}

                {/* State A: India Telegram Connected */}
                {customer.indiaTelegramConnected ? (
                  <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-3 text-xs space-y-2">
                    <p className="text-emerald-900 text-[11px] leading-relaxed">
                      ✓ <strong>Connected to India News Bot:</strong> Your Telegram account is safely linked to{' '}
                      <strong>@MyDigitAssetIndiaBot</strong>. Daily India news briefings will be delivered directly to your
                      private Telegram chat every morning between 6:00 AM and 7:00 AM IST.
                    </p>
                    <button
                      type="button"
                      onClick={handleDisconnectIndiaTelegram}
                      disabled={isDisconnectingIndiaTg}
                      className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 hover:text-rose-800 hover:bg-rose-50 px-2.5 py-1 rounded border border-rose-200 transition cursor-pointer"
                    >
                      <Unlink className="w-3 h-3" />
                      <span>{isDisconnectingIndiaTg ? 'Disconnecting...' : 'Disconnect India News Bot'}</span>
                    </button>
                  </div>
                ) : (
                  /* State B: India Telegram Not Connected or In-Progress */
                  <div className="space-y-3">
                    {!indiaTgTokenData ? (
                      <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <p className="text-[11px] text-stone-600 leading-snug">
                          Receive your subscribed India news briefings directly in your private Telegram chat.
                        </p>
                        <button
                          type="button"
                          onClick={handleGenerateIndiaTelegramToken}
                          disabled={isGeneratingIndiaTgToken}
                          className="bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs px-4 py-2 rounded-lg transition shrink-0 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>{isGeneratingIndiaTgToken ? 'Connecting...' : 'Connect Telegram'}</span>
                        </button>
                      </div>
                    ) : (
                      /* Token Generated / Waiting for Connection State */
                      <div className="bg-amber-50/80 border border-amber-200 rounded-lg p-3.5 text-xs space-y-3">
                        <div className="flex items-center justify-between font-semibold text-amber-950">
                          <span>Complete Your India Telegram Connection</span>
                          <span className="text-[10px] text-amber-700 font-mono">
                            {indiaTgLinkExpired ? 'Link Expired' : 'Valid for 15 mins'}
                          </span>
                        </div>

                        {indiaTgLinkExpired ? (
                          <div className="space-y-2">
                            <p className="text-[11px] text-rose-700">
                              Your Telegram connection link has expired. Please generate a fresh link to connect your account.
                            </p>
                            <button
                              type="button"
                              onClick={handleGenerateIndiaTelegramToken}
                              disabled={isGeneratingIndiaTgToken}
                              className="bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs px-3.5 py-2 rounded-lg transition cursor-pointer"
                            >
                              {isGeneratingIndiaTgToken ? 'Generating...' : 'Generate New Link'}
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="text-[11px] text-stone-700 space-y-1 leading-relaxed">
                              <p>
                                1. Tap the button below to open our official India bot:{' '}
                                <strong>@{indiaTgTokenData.botUsername || 'MyDigitAssetIndiaBot'}</strong>
                              </p>
                              <p>2. Tap <strong>START</strong> in Telegram to securely complete the connection.</p>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-2 pt-1">
                              <a
                                href={indiaTgTokenData.deepLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="bg-sky-600 hover:bg-sky-700 text-white font-semibold text-xs px-4 py-2 rounded-lg transition text-center inline-flex items-center justify-center gap-1.5"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>Open Telegram & Tap START</span>
                              </a>

                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(indiaTgTokenData.deepLink);
                                  setCopiedIndiaTgLink(true);
                                  setTimeout(() => setCopiedIndiaTgLink(false), 2000);
                                }}
                                className="bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 font-semibold text-xs px-3 py-2 rounded-lg transition inline-flex items-center justify-center gap-1.5 cursor-pointer"
                              >
                                {copiedIndiaTgLink ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                <span>{copiedIndiaTgLink ? 'Link Copied' : 'Copy Link'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={handleCheckIndiaTelegramStatus}
                                disabled={isCheckingIndiaTgStatus}
                                className="bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 font-semibold text-xs px-3 py-2 rounded-lg transition inline-flex items-center justify-center gap-1.5 cursor-pointer"
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingIndiaTgStatus ? 'animate-spin' : ''}`} />
                                <span>{isCheckingIndiaTgStatus ? 'Checking...' : 'Check Status'}</span>
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* SECTION 5 & 6: TELEGRAM CONNECTION UX */}
              <div className="border border-stone-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-stone-900 block">Telegram Delivery Channel</span>
                    <span className="text-[11px] text-stone-500">Private 1-to-1 morning briefings (6:00–7:00 AM IST)</span>
                  </div>
                  <div>
                    {customer.telegramConnected ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Telegram Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                        <Send className="w-3.5 h-3.5 text-amber-600" /> Not Connected
                      </span>
                    )}
                  </div>
                </div>

                {tgError && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-800 text-[11px] p-2.5 rounded-lg flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                    <span>{tgError}</span>
                  </div>
                )}

                {/* Telegram State A: Connected */}
                {customer.telegramConnected ? (
                  <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-3 text-xs space-y-2">
                    <p className="text-emerald-900 text-[11px] leading-relaxed">
                      ✓ <strong>Connected & Active:</strong> Your Telegram account is safely linked. Briefings are delivered directly to your Telegram chat every morning between 6:00 AM and 7:00 AM IST. Your account details remain strictly private.
                    </p>
                    <button
                      type="button"
                      onClick={handleDisconnectTelegram}
                      disabled={isDisconnectingTg}
                      className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 hover:text-rose-800 hover:bg-rose-50 px-2.5 py-1 rounded border border-rose-200 transition"
                    >
                      <Unlink className="w-3 h-3" />
                      <span>{isDisconnectingTg ? 'Disconnecting...' : 'Unlink Telegram Account'}</span>
                    </button>
                  </div>
                ) : (
                  /* Telegram State B: Not Connected or In-Progress */
                  <div className="space-y-3">
                    {!tgTokenData ? (
                      <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <p className="text-[11px] text-stone-600 leading-snug">
                          Connect your Telegram to receive daily intelligence briefings directly in your private chat. You will never be asked to type a numeric Chat ID.
                        </p>
                        <button
                          type="button"
                          onClick={handleGenerateTelegramToken}
                          disabled={isGeneratingTgToken}
                          className="bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs px-4 py-2 rounded-lg transition shrink-0 inline-flex items-center justify-center gap-1.5"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>{isGeneratingTgToken ? 'Connecting...' : 'Connect Telegram'}</span>
                        </button>
                      </div>
                    ) : (
                      /* Token Generated / Waiting for Connection State */
                      <div className="bg-amber-50/80 border border-amber-200 rounded-lg p-3.5 text-xs space-y-3">
                        <div className="flex items-center justify-between font-semibold text-amber-950">
                          <span>Complete Your Telegram Connection</span>
                          <span className="text-[10px] text-amber-700 font-mono">
                            {tgLinkExpired ? 'Link Expired' : 'Valid for 15 mins'}
                          </span>
                        </div>

                        {tgLinkExpired ? (
                          <div className="space-y-2">
                            <p className="text-[11px] text-rose-700">
                              Your Telegram connection link has expired. Please generate a fresh link to connect your account.
                            </p>
                            <button
                              type="button"
                              onClick={handleGenerateTelegramToken}
                              disabled={isGeneratingTgToken}
                              className="bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs px-3.5 py-2 rounded-lg transition"
                            >
                              {isGeneratingTgToken ? 'Generating...' : 'Generate New Telegram Link'}
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="text-[11px] text-stone-700 space-y-1 leading-relaxed">
                              <p>1. Tap the button below to open our official bot: <strong>@{tgTokenData.botUsername}</strong></p>
                              <p>2. Tap <strong>START</strong> in Telegram to securely complete the connection.</p>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-2 pt-1">
                              <a
                                href={tgTokenData.deepLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="bg-sky-600 hover:bg-sky-700 text-white font-semibold text-xs px-4 py-2 rounded-lg transition text-center inline-flex items-center justify-center gap-1.5"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>Open Telegram & Tap START</span>
                              </a>

                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(tgTokenData.deepLink);
                                  setCopiedTgLink(true);
                                  setTimeout(() => setCopiedTgLink(false), 2000);
                                }}
                                className="bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 font-semibold text-xs px-3 py-2 rounded-lg transition inline-flex items-center justify-center gap-1.5"
                              >
                                {copiedTgLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                                <span>{copiedTgLink ? 'Link Copied' : 'Copy Link'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={handleCheckTelegramStatus}
                                disabled={isCheckingTgStatus}
                                className="bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 font-semibold text-xs px-3 py-2 rounded-lg transition inline-flex items-center justify-center gap-1.5"
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingTgStatus ? 'animate-spin' : ''}`} />
                                <span>{isCheckingTgStatus ? 'Checking...' : 'Check Status'}</span>
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* SECTION 7 & 8: MANUAL UPI PAYMENT & PROOF SUBMISSION */}
              <div className="border border-stone-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-stone-900 block">Annual Subscription & Payment</span>
                    <span className="text-[11px] text-stone-500">
                      Official Rate: ₹{effectiveBasePrice} + {effectiveGstRate}% GST = ₹{effectiveTotal} / year
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowProofForm(!showProofForm)}
                    className="text-xs font-semibold text-amber-800 hover:text-amber-900 bg-amber-50 hover:bg-amber-100 px-3 py-1.5 rounded-lg border border-amber-200 transition"
                  >
                    {showProofForm ? 'Hide Payment Details' : 'Pay via UPI / Submit UTR'}
                  </button>
                </div>

                {showProofForm && (
                  <div className="bg-stone-50 rounded-xl p-4 border border-stone-200 space-y-4 text-xs">
                    {/* Official Payment Instructions */}
                    <div className="space-y-2">
                      <span className="font-bold text-stone-900 block">Official UPI Payment Details</span>

                      <div className="bg-white p-3 rounded-lg border border-stone-200 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-stone-500 text-[11px]">UPI ID (VPA):</span>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-bold text-stone-900">{effectiveUpiId}</span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(effectiveUpiId);
                                setCopiedUpi(true);
                                setTimeout(() => setCopiedUpi(false), 2000);
                              }}
                              className="text-stone-600 hover:text-stone-900 p-1 bg-stone-100 rounded"
                              title="Copy UPI ID"
                            >
                              {copiedUpi ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="text-stone-500 text-[11px]">Beneficiary Name:</span>
                          <span className="font-medium text-stone-800">{effectiveBeneficiary}</span>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-stone-100">
                          <span className="text-stone-500 text-[11px]">Payable Amount:</span>
                          <span className="font-bold text-stone-900 font-mono">₹{effectiveTotal} (All inclusive)</span>
                        </div>
                      </div>

                      <div className="text-[11px] text-stone-600 space-y-1 pt-1 leading-relaxed">
                        <p><strong>Step 1:</strong> Transfer <strong>₹{effectiveTotal}</strong> to the official UPI ID above via Google Pay, PhonePe, Paytm, BHIM, or your bank app.</p>
                        <p><strong>Step 2:</strong> Note the 12-digit <strong>UTR (Unique Transaction Reference)</strong> number on your payment receipt.</p>
                        <p><strong>Step 3:</strong> Enter the 12-digit UTR below and submit for verification.</p>
                        <p><strong>Step 4:</strong> Our administrative desk verifies the receipt and activates your continuous 5-day courtesy buffer + 12-month paid subscription.</p>
                      </div>
                    </div>

                    {/* UTR Submission Form */}
                    <form onSubmit={handleSubmitPaymentProof} className="space-y-2 pt-2 border-t border-stone-200">
                      <label className="block text-xs font-semibold text-stone-800">
                        Enter 12-Digit UPI UTR / Payment Reference
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={paymentProofRef}
                          onChange={(e) => setPaymentProofRef(e.target.value)}
                          placeholder="e.g. 429812345678"
                          className="flex-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-xs font-mono focus:border-stone-800 outline-hidden"
                          required
                          disabled={isSubmittingProof}
                        />
                        <button
                          type="submit"
                          disabled={isSubmittingProof || !paymentProofRef.trim()}
                          className="bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white font-semibold text-xs px-4 py-2 rounded-lg transition"
                        >
                          {isSubmittingProof ? 'Submitting...' : 'Submit Proof'}
                        </button>
                      </div>
                      <p className="text-[10px] text-stone-500">
                        Submission and admin confirmation are separate steps. Your access activates upon administrative verification.
                      </p>
                    </form>
                  </div>
                )}
              </div>

              {/* SECTION 9: ANNUAL RENEWAL REQUEST */}
              <div className="border border-stone-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-bold text-stone-900 block">Annual Subscription Renewal</span>
                  <span className="text-[11px] text-stone-500">
                    {renewalSubmitted
                      ? 'Renewal request recorded and queued for priority processing.'
                      : 'Request early renewal to ensure uninterrupted daily intelligence briefings.'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleRequestRenewal}
                  disabled={isRequestingRenewal || renewalSubmitted}
                  className={`text-xs font-semibold px-4 py-2 rounded-lg border transition shrink-0 ${
                    renewalSubmitted
                      ? 'bg-stone-100 text-stone-500 border-stone-200 cursor-not-allowed'
                      : 'bg-stone-900 hover:bg-stone-800 text-white border-stone-900'
                  }`}
                >
                  {renewalSubmitted ? 'Requested ✓' : isRequestingRenewal ? 'Requesting...' : 'Request Renewal'}
                </button>
              </div>

              {/* SECTION 10: CUSTOMER PROFILE & MOBILE NUMBER */}
              <div className="border border-stone-200 rounded-xl divide-y divide-stone-100 text-xs">
                <div className="p-3.5 flex justify-between items-center">
                  <span className="text-stone-500 font-medium">Registered Name</span>
                  <span className="font-semibold text-stone-900">{customer.fullName}</span>
                </div>

                <div className="p-3.5 flex justify-between items-center">
                  <span className="text-stone-500 font-medium">Registered Email</span>
                  <span className="font-mono text-stone-900">{customer.email}</span>
                </div>

                <div className="p-3.5">
                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Registered Mobile</span>
                    {!isEditingMobile && (
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-stone-900">
                          {customer.mobileCountryCode} {customer.mobileNumber}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setNewCountryCode(customer.mobileCountryCode);
                            setNewMobileNumber(customer.mobileNumber);
                            setIsEditingMobile(true);
                          }}
                          className="text-amber-700 hover:text-amber-800 p-1 hover:bg-amber-50 rounded transition"
                          title="Update mobile number"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {isEditingMobile && (
                    <form onSubmit={handleUpdateMobile} className="mt-2.5 pt-2.5 border-t border-stone-100 flex gap-2">
                      <input
                        type="text"
                        value={newCountryCode}
                        onChange={(e) => setNewCountryCode(e.target.value)}
                        className="w-16 bg-stone-50 border border-stone-300 rounded-lg px-2 py-1.5 text-xs text-center font-mono"
                        placeholder="+91"
                        required
                      />
                      <input
                        type="tel"
                        value={newMobileNumber}
                        onChange={(e) => setNewMobileNumber(e.target.value)}
                        className="flex-1 bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        placeholder="10-digit mobile"
                        required
                      />
                      <button
                        type="submit"
                        disabled={isLoading}
                        className="bg-stone-900 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-stone-800 transition"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsEditingMobile(false)}
                        className="text-stone-500 text-xs px-2 py-1.5 hover:text-stone-800"
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </div>
              </div>

              {/* Past Payment Records */}
              {userPayments.length > 0 && (
                <div className="border border-stone-200 rounded-xl p-4 space-y-2">
                  <span className="text-xs font-bold text-stone-900 block">Submitted Payment References</span>
                  <div className="divide-y divide-stone-100 text-xs max-h-32 overflow-y-auto">
                    {userPayments.map((p) => (
                      <div key={p.paymentId} className="py-2 flex justify-between items-center text-[11px]">
                        <div>
                          <span className="font-mono font-medium text-stone-800 block">Reference: {p.gatewayReference}</span>
                          <span className="text-stone-400">{formatDate(p.paymentDate)}</span>
                        </div>
                        <div className="text-right">
                          <span className="font-mono font-bold text-stone-900 block">₹{p.amount.toFixed(2)}</span>
                          <span
                            className={`text-[10px] font-semibold uppercase ${
                              p.paymentStatus === 'successful'
                                ? 'text-emerald-700'
                                : p.paymentStatus === 'pending'
                                ? 'text-amber-700'
                                : 'text-stone-500'
                            }`}
                          >
                            {p.paymentStatus}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* SECTION 11: CUSTOMER LOGOUT & ACTIONS */}
              <div className="pt-2 flex items-center justify-between gap-3 border-t border-stone-100">
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-700 hover:text-rose-800 hover:bg-rose-50 px-3.5 py-2 rounded-lg transition border border-rose-200"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Log Out</span>
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  className="bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs px-4 py-2 rounded-lg transition"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* VIEW B: NEW CUSTOMER REGISTRATION FORM */
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="text-[11px] text-stone-600 bg-stone-50 p-3 rounded-lg border border-stone-200 leading-relaxed">
                Provide your subscriber details to begin your complimentary 3-day executive trial. Daily briefings will be synchronized every morning between 6:00 AM and 7:00 AM IST.
              </div>

              {/* Full Name */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-stone-800">
                  Full Name <span className="text-amber-600">*</span>
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g., Mihir Kapuria"
                    className="w-full pl-9 pr-3 py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg focus:bg-white focus:border-stone-800 outline-hidden transition"
                  />
                </div>
              </div>

              {/* Email Address */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-stone-800">
                  Email Address <span className="text-amber-600">*</span>
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="e.g., yourname@domain.com"
                    className="w-full pl-9 pr-3 py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg focus:bg-white focus:border-stone-800 outline-hidden transition"
                  />
                </div>
              </div>

              {/* Mobile Number with Country Code */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-stone-800">
                  Mobile Number <span className="text-amber-600">*</span>
                </label>
                <div className="flex gap-2">
                  <div className="w-24 shrink-0">
                    <input
                      type="text"
                      required
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value)}
                      placeholder="+91"
                      className="w-full text-center py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg font-mono focus:bg-white focus:border-stone-800 outline-hidden transition"
                    />
                  </div>
                  <div className="relative flex-1">
                    <Phone className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
                    <input
                      type="tel"
                      required
                      value={mobileNumber}
                      onChange={(e) => setMobileNumber(e.target.value)}
                      placeholder="10-digit mobile number"
                      className="w-full pl-9 pr-3 py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg font-mono focus:bg-white focus:border-stone-800 outline-hidden transition"
                    />
                  </div>
                </div>
              </div>

              {/* Selected Categories */}
              <div className="space-y-2 pt-2 border-t border-stone-200">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-stone-800">
                    Select Your Subscribed News Verticals <span className="text-amber-600">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleSelectAllCategories}
                    className="text-[11px] font-semibold text-amber-700 hover:text-amber-800 underline"
                  >
                    Select All
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                  {categories.map((cat) => {
                    const isChecked = selectedCats.includes(cat.id);
                    return (
                      <label
                        key={cat.id}
                        className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                          isChecked
                            ? 'bg-amber-50/60 border-amber-300 text-stone-900 font-medium'
                            : 'bg-stone-50 border-stone-200 text-stone-600 hover:bg-stone-100'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleCategoryToggle(cat.id)}
                          className="mt-0.5 rounded border-stone-300 text-amber-600 focus:ring-amber-500"
                        />
                        <span className="leading-tight">{cat.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Submit Button */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading || selectedCats.length === 0}
                  className="w-full bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white font-semibold text-xs py-2.5 rounded-xl transition cursor-pointer"
                >
                  {isLoading ? 'Creating Account...' : 'Complete Subscriber Registration'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
