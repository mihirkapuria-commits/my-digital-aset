import React, { useState, useEffect } from 'react';
import {
  X,
  Check,
  ShieldCheck,
  AlertCircle,
  Copy,
  Clock,
  Layers,
  ArrowRight,
  User,
  Info,
} from 'lucide-react';
import { Product, PaymentConfiguration, Customer, Subscription, SubscriptionCategory } from '../types';
import { Logo } from './Logo';

interface PaywallModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product;
  paymentConfig: PaymentConfiguration;
  customer: Customer | null;
  onOpenCustomerRegister: () => void;
  onPaymentActivated: (subscription: Subscription, entitlements: SubscriptionCategory[]) => void;
}

export const PaywallModal: React.FC<PaywallModalProps> = ({
  isOpen,
  onClose,
  product,
  paymentConfig,
  customer,
  onOpenCustomerRegister,
  onPaymentActivated,
}) => {
  const [utrNumber, setUtrNumber] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionSuccess, setSubmissionSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedUpi, setCopiedUpi] = useState(false);

  // Close when pressing the Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Pricing calculations
  const selectedCount = customer?.selectedCategoryIds?.length || 1;
  const basePrice = product.basePriceInr * selectedCount;
  const gstPercent = product.gstRatePercent;
  const gstAmount = Number(((basePrice * gstPercent) / 100).toFixed(2));
  const totalPayable = (basePrice + gstAmount).toFixed(2);
  const upiId = paymentConfig.upiId || '9876543210@upi';
  const beneficiaryName = paymentConfig.beneficiaryName || 'MyDigitAsset News Pvt Ltd';

  const handleSubmitUtr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer) {
      onClose();
      onOpenCustomerRegister();
      return;
    }

    const cleanUtr = utrNumber.trim();
    if (!cleanUtr || cleanUtr.length < 6) {
      setErrorMsg('Please enter a valid 12-digit UPI UTR or payment reference.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/customer/submit-payment-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentReference: cleanUtr,
          categoryIds: customer.selectedCategoryIds,
          amount: Number(totalPayable),
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to submit payment reference. Please check and try again.');
      }

      setSubmissionSuccess(true);
      setUtrNumber('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not submit payment reference.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      id="paywall-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4"
    >
      <div
        id="paywall-modal-dialog"
        className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-stone-200 overflow-hidden relative animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="bg-stone-900 text-white p-5 sm:p-6 relative border-b border-stone-800">
          <button
            id="close-paywall-top-btn"
            onClick={onClose}
            disabled={isSubmitting}
            className="absolute top-4 right-4 text-stone-400 hover:text-white bg-stone-800/80 hover:bg-stone-700 p-2 rounded-lg transition"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="mb-2">
            <Logo size="sm" theme="dark" showBadge={false} />
          </div>

          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 uppercase tracking-wider mb-1">
            <ShieldCheck className="w-3.5 h-3.5" /> 1-Year Paid Executive News Subscription
          </div>

          <p className="text-xs text-stone-300">
            Synchronized executive briefings delivered privately to your Telegram every morning from 6:00 AM to 7:00 AM IST.
          </p>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {errorMsg && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs p-3 rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {submissionSuccess ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-xs space-y-3">
              <div className="flex items-center gap-2 text-emerald-900 font-bold text-sm">
                <Check className="w-4 h-4 text-emerald-600" />
                <span>Payment Reference Submitted Successfully!</span>
              </div>
              <p className="text-emerald-800 leading-relaxed text-[11px]">
                Your 12-digit UTR payment proof has been queued for administrative verification. Once verified by our desk, your 5-day continuous courtesy buffer and 12-month paid subscription will activate immediately.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs py-2 rounded-lg transition"
                >
                  Return to Dashboard
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Dynamic Pricing Breakdown (Stage 2 Section 7) */}
              <div className="bg-stone-50 border border-stone-200 rounded-xl p-4 space-y-2.5 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-stone-600">Annual Base Price ({selectedCount} category)</span>
                  <span className="font-semibold text-stone-900">₹{basePrice.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-stone-600">
                  <span>Applicable GST ({gstPercent}%)</span>
                  <span className="font-semibold text-stone-900">₹{gstAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-stone-200 text-sm font-bold text-stone-900">
                  <span>Total Payable:</span>
                  <span className="text-amber-800 font-mono">₹{totalPayable} / year</span>
                </div>
              </div>

              {/* Official UPI Details & Instructions */}
              <div className="border border-stone-200 rounded-xl p-4 space-y-3 text-xs">
                <span className="font-bold text-stone-900 block">Manual UPI Payment Instructions</span>

                <div className="bg-stone-50 p-3 rounded-lg border border-stone-200 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-stone-500 text-[11px]">Official UPI ID:</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-bold text-stone-900">{upiId}</span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(upiId);
                          setCopiedUpi(true);
                          setTimeout(() => setCopiedUpi(false), 2000);
                        }}
                        className="text-stone-600 hover:text-stone-900 p-1 bg-stone-200/70 rounded"
                        title="Copy UPI ID"
                      >
                        {copiedUpi ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-stone-500 text-[11px]">Beneficiary Name:</span>
                    <span className="font-medium text-stone-800">{beneficiaryName}</span>
                  </div>
                </div>

                <div className="text-[11px] text-stone-600 space-y-1 leading-relaxed">
                  <p>1. Transfer <strong>₹{totalPayable}</strong> to the official UPI ID above via Google Pay, PhonePe, Paytm, BHIM, or your bank app.</p>
                  <p>2. Locate the 12-digit <strong>UTR</strong> on your transaction receipt.</p>
                  <p>3. Enter your UTR below and submit for verification.</p>
                </div>
              </div>

              {/* UTR Submission Form or Customer Registration Prompt */}
              {customer ? (
                <form onSubmit={handleSubmitUtr} className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-800 mb-1">
                      Enter 12-Digit UPI UTR / Payment Reference
                    </label>
                    <input
                      type="text"
                      value={utrNumber}
                      onChange={(e) => setUtrNumber(e.target.value)}
                      placeholder="e.g. 429812345678"
                      className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs font-mono focus:border-stone-800 outline-hidden"
                      required
                      disabled={isSubmitting}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting || !utrNumber.trim()}
                    className="w-full bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white font-semibold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-1.5"
                  >
                    <span>{isSubmitting ? 'Submitting Reference...' : 'Submit Payment Proof'}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </form>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 space-y-2 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-950">
                    <User className="w-4 h-4 text-amber-700" />
                    <span>Please register your subscriber account first</span>
                  </div>
                  <p className="text-[11px] text-stone-600">
                    To link your payment reference and Telegram delivery to your account, please register with your name and mobile number.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenCustomerRegister();
                    }}
                    className="bg-amber-700 hover:bg-amber-800 text-white font-semibold text-xs px-3.5 py-1.5 rounded-lg transition"
                  >
                    Register Subscriber Account
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
