import React, { useState, useEffect } from 'react';
import { X, Check, Copy, ShieldCheck, Mail, Smartphone, ArrowRight, ArrowLeft } from 'lucide-react';
import { Product, PaymentConfiguration } from '../types';

interface PaywallModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product;
  paymentConfig: PaymentConfiguration;
  onPaymentSubmitted: (txnRef: string) => void;
}

export const PaywallModal: React.FC<PaywallModalProps> = ({
  isOpen,
  onClose,
  product,
  paymentConfig,
  onPaymentSubmitted,
}) => {
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [txnRef, setTxnRef] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

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

  // Dynamic calculations from admin-configurable settings
  const basePrice = product.basePriceInr;
  const gstPercent = product.gstRatePercent;
  const gstAmount = Number(((basePrice * gstPercent) / 100).toFixed(2));
  const totalPayable = (basePrice + gstAmount).toFixed(2);

  const handleCopy = (text: string, type: 'phone' | 'upi') => {
    navigator.clipboard.writeText(text);
    if (type === 'phone') {
      setCopiedPhone(true);
      setTimeout(() => setCopiedPhone(false), 2000);
    } else {
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2000);
    }
  };

  const handleSubmitTxn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!txnRef.trim()) return;
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      setIsSuccess(true);
      onPaymentSubmitted(txnRef);
    }, 800);
  };

  return (
    <div 
      id="paywall-backdrop"
      onClick={(e) => {
        // Clicking the backdrop closes the modal
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/70 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div 
        id="paywall-modal-dialog"
        className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-stone-200 overflow-hidden relative animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Modal Top Header */}
        <div className="bg-stone-900 text-white p-5 sm:p-6 relative">
          <button
            id="close-paywall-top-btn"
            onClick={onClose}
            className="absolute top-4 right-4 text-stone-300 hover:text-white bg-stone-800/80 hover:bg-stone-700 px-2.5 py-1.5 rounded-lg transition flex items-center gap-1.5 text-xs font-semibold border border-stone-700"
            aria-label="Close and return to website"
          >
            <span>Close</span>
            <X className="w-4 h-4" />
          </button>

          <div className="inline-flex items-center gap-1 text-xs font-semibold text-amber-400 bg-stone-800 px-2.5 py-1 rounded-full mb-2.5">
            <ShieldCheck className="w-3.5 h-3.5" /> 1-Year Full Subscription
          </div>
          <h2 className="text-xl sm:text-2xl font-bold font-serif tracking-tight pr-16">
            mydigitalasset.com
          </h2>
          <p className="text-xs sm:text-sm text-stone-300 mt-1">
            Curated daily intelligence across India PE/VC, Startups, and Healthcare. Briefings are synchronized every morning from 6:00 AM to 7:00 AM from verified sources.
          </p>
        </div>

        <div className="p-5 sm:p-6 space-y-5">
          {/* Transparent Price Breakdown */}
          <div className="bg-stone-50 rounded-xl p-4 border border-stone-200 space-y-2 text-sm">
            <div className="flex justify-between text-stone-600">
              <span>Annual Subscription Base Fee</span>
              <span className="font-medium text-stone-900">₹{basePrice.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-stone-600">
              <span>Goods & Services Tax (GST {gstPercent}%)</span>
              <span className="font-medium text-stone-900">₹{gstAmount.toFixed(2)}</span>
            </div>
            <div className="pt-2 border-t border-stone-200 flex justify-between items-baseline">
              <span className="font-bold text-stone-900">Total Amount Payable</span>
              <div className="text-right">
                <span className="text-2xl font-extrabold text-stone-950 font-serif">₹{totalPayable}</span>
                <span className="text-xs text-stone-500 block">/ 1 full year access</span>
              </div>
            </div>
          </div>

          {/* Payment Instructions Card */}
          <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4">
            <h3 className="text-xs uppercase font-bold tracking-wider text-amber-900 mb-2 flex items-center gap-1.5">
              <Smartphone className="w-4 h-4 text-amber-700" />
              Pay Via UPI / PhonePe / GPay / Paytm
            </h3>

            <div className="space-y-2.5 text-xs text-stone-700">
              <div className="flex items-center justify-between bg-white p-2.5 rounded-lg border border-amber-200/80">
                <div>
                  <span className="text-stone-500 block text-[11px]">Phone / UPI Number</span>
                  <span className="font-mono font-bold text-stone-900 text-sm">{paymentConfig.phoneNumber}</span>
                </div>
                <button
                  onClick={() => handleCopy(paymentConfig.phoneNumber, 'phone')}
                  className="flex items-center gap-1 bg-stone-100 hover:bg-stone-200 text-stone-700 px-2.5 py-1 rounded text-xs font-medium transition"
                >
                  {copiedPhone ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedPhone ? 'Copied' : 'Copy'}</span>
                </button>
              </div>

              <div className="flex items-center justify-between bg-white p-2.5 rounded-lg border border-amber-200/80">
                <div>
                  <span className="text-stone-500 block text-[11px]">Beneficiary Name</span>
                  <span className="font-medium text-stone-900 text-sm">{paymentConfig.beneficiaryName}</span>
                </div>
                <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  Verified Owner
                </span>
              </div>
            </div>
          </div>

          {/* Customer Confirmation Form */}
          {!isSuccess ? (
            <form onSubmit={handleSubmitTxn} className="space-y-3">
              <label htmlFor="txn-ref-input" className="block text-xs font-semibold text-stone-800">
                After making payment, enter your UPI Transaction Reference / UTR Number:
              </label>
              <div className="flex gap-2">
                <input
                  id="txn-ref-input"
                  type="text"
                  required
                  placeholder="e.g., 425619873421"
                  value={txnRef}
                  onChange={(e) => setTxnRef(e.target.value)}
                  className="flex-1 bg-stone-50 border border-stone-300 focus:border-stone-800 focus:bg-white rounded-lg px-3 py-2 text-sm text-stone-900 font-mono outline-hidden transition"
                />
                <button
                  id="submit-txn-btn"
                  type="submit"
                  disabled={isSubmitting || !txnRef.trim()}
                  className="bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white font-semibold text-xs px-4 py-2 rounded-lg transition shrink-0 flex items-center gap-1.5"
                >
                  {isSubmitting ? 'Verifying...' : 'Submit UTR'}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-stone-500">
                Your annual access is activated immediately upon reference verification by the administrator.
              </p>
            </form>
          ) : (
            <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-3.5 text-center text-emerald-900 space-y-1">
              <div className="w-8 h-8 rounded-full bg-emerald-200 mx-auto flex items-center justify-center text-emerald-800">
                <Check className="w-5 h-5" />
              </div>
              <p className="text-xs font-bold">Transaction Reference Submitted!</p>
              <p className="text-xs text-stone-600">
                Ref: <span className="font-mono font-bold text-stone-800">{txnRef}</span>
              </p>
              <p className="text-[11px] text-stone-500 mt-1">
                Your subscription has been activated for this preview session.
              </p>
            </div>
          )}

          {/* GST Input Credit Important Customer Notice */}
          <div className="p-3.5 rounded-xl bg-stone-100 border border-stone-200 text-xs text-stone-700 space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold text-stone-900">
              <Mail className="w-4 h-4 text-stone-600" />
              <span>Claiming GST Input Tax Credit?</span>
            </div>
            <p className="text-stone-600 leading-relaxed text-[11px]">
              Customers claiming GST input credit should email{' '}
              <a
                href={`mailto:${paymentConfig.gstCreditEmail}?subject=GST%20Input%20Credit%20Request%20-%20mydigitalasset.com`}
                className="font-semibold text-stone-900 underline underline-offset-2 hover:text-amber-700"
              >
                {paymentConfig.gstCreditEmail}
              </a>{' '}
              with their:
            </p>
            <ul className="list-disc list-inside text-[11px] text-stone-600 space-y-0.5 pl-1">
              <li>Full Name</li>
              <li>Phone Number</li>
              <li>Customer Transaction Reference Number (UTR)</li>
              <li>Registered Email Address & Company GSTIN</li>
            </ul>
          </div>

          {/* Clear "Come Out / Return to Website" Button at the Bottom */}
          <div className="pt-2 border-t border-stone-200 flex flex-col sm:flex-row items-center justify-between gap-2">
            <button
              id="back-to-news-btn"
              type="button"
              onClick={onClose}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 text-stone-700 hover:text-stone-950 hover:bg-stone-100 px-4 py-2.5 rounded-lg border border-stone-300 font-semibold text-xs transition"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to News & Articles</span>
            </button>

            <button
              id="close-bottom-btn"
              type="button"
              onClick={onClose}
              className="w-full sm:w-auto text-xs text-stone-500 hover:text-stone-800 underline underline-offset-4 py-1"
            >
              Close Window
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
