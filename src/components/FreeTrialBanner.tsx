import React from 'react';
import { Sparkles, AlertCircle, ShieldCheck, ArrowRight } from 'lucide-react';
import { Product } from '../types';

interface FreeTrialBannerProps {
  userState: 'trial' | 'expired' | 'subscribed';
  product: Product;
  onOpenPaywall: () => void;
}

export const FreeTrialBanner: React.FC<FreeTrialBannerProps> = ({
  userState,
  product,
  onOpenPaywall,
}) => {
  const gstAmount = Number(((product.basePriceInr * product.gstRatePercent) / 100).toFixed(2));
  const totalAmount = (product.basePriceInr + gstAmount).toFixed(2);

  if (userState === 'subscribed') {
    return (
      <div id="trial-banner-subscribed" className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 sm:p-4 mb-6 flex items-center justify-between gap-3 text-stone-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs sm:text-sm font-semibold text-emerald-900">
              Annual Membership Active
            </p>
            <p className="text-xs text-stone-600">
              Unrestricted daily access to India PE/VC & Startups and Healthcare briefings (synchronized 6:00 AM – 7:00 AM IST).
            </p>
          </div>
        </div>
        <button
          onClick={onOpenPaywall}
          className="text-xs text-emerald-800 hover:text-emerald-950 font-medium underline underline-offset-2 shrink-0"
        >
          View Receipt & GST
        </button>
      </div>
    );
  }

  if (userState === 'expired') {
    return (
      <div id="trial-banner-expired" className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 sm:p-5 mb-6 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center shrink-0 mt-0.5">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase font-bold tracking-wider text-amber-800 bg-amber-200/70 px-2 py-0.5 rounded">
                  Free Trial Concluded
                </span>
                <span className="text-xs text-stone-500 font-medium">3 Days Completed</span>
              </div>
              <h3 className="text-sm sm:text-base font-bold text-stone-900 mt-1 font-serif">
                Subscribe for ₹{totalAmount} / year to continue reading
              </h3>
              <p className="text-xs text-stone-600 mt-0.5 max-w-xl">
                Base price: ₹{product.basePriceInr.toFixed(2)} + 18% GST (₹{gstAmount.toFixed(2)}). Instant activation via Phone/UPI.
              </p>
            </div>
          </div>
          <button
            id="expired-banner-cta"
            onClick={onOpenPaywall}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs sm:text-sm px-4 py-2.5 rounded-lg shadow-xs transition active:scale-95 shrink-0"
          >
            <span>Complete Subscription</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  // Default: Free Trial Day 1
  return (
    <div id="trial-banner-active" className="bg-gradient-to-r from-stone-900 to-stone-800 text-white rounded-xl p-4 sm:p-5 mb-6 shadow-xs border border-stone-800">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0 mt-0.5 border border-amber-500/30">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase font-bold tracking-wider text-amber-400 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-800/40">
                3-Day Free Trial
              </span>
              <span className="text-xs text-stone-300">Day 1 of 3 Active</span>
            </div>
            <p className="text-sm font-medium text-stone-100 mt-1">
              Enjoy complimentary access to today's curated intelligence.
            </p>
            <p className="text-xs text-stone-400 mt-0.5">
              No credit card or payment required during trial. ₹{totalAmount}/yr (incl. 18% GST) thereafter.
            </p>
          </div>
        </div>

        <button
          id="trial-banner-details-btn"
          onClick={onOpenPaywall}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-stone-700 hover:bg-stone-600 text-stone-100 font-medium text-xs px-3.5 py-2 rounded-lg border border-stone-600 transition shrink-0"
        >
          <span>Subscription Info</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
