import React from 'react';
import { ShieldCheck, Sparkles, User, Globe } from 'lucide-react';
import { GlobalSiteSettings, Product, Customer } from '../types';
import { Logo } from './Logo';

interface HeaderProps {
  settings: GlobalSiteSettings;
  product: Product;
  userState: 'trial' | 'expired' | 'subscribed';
  setUserState: (state: 'trial' | 'expired' | 'subscribed') => void;
  onOpenPaywall: () => void;
  customer?: Customer | null;
  onOpenCustomerModal?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  settings,
  product,
  userState,
  setUserState,
  onOpenPaywall,
  customer,
  onOpenCustomerModal,
}) => {
  const gstAmount = Number(((product.basePriceInr * product.gstRatePercent) / 100).toFixed(2));
  const totalAmount = (product.basePriceInr + gstAmount).toFixed(2);

  return (
    <header id="main-header" className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-stone-200">
      {/* Top Utility Strip: Market Edition & Synchronization Schedule */}
      <div className="bg-stone-900 text-stone-200 text-xs py-1.5 px-4">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 font-medium text-amber-400">
              <Globe className="w-3 h-3" /> India Edition
            </span>
            <span className="text-stone-400">•</span>
            <span className="text-stone-300">Briefings Synchronized Daily 6:00 AM – 7:00 AM IST</span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-stone-400">
            <span className="text-amber-400/90 font-medium">Verified Sources</span>
            <span>•</span>
            <span className="text-stone-300">PE/VC & Healthcare Intelligence</span>
          </div>
        </div>
      </div>

      {/* Main Brand & Action Nav */}
      <div className="max-w-5xl mx-auto px-4 py-3 sm:py-4 flex items-center justify-between">
        <div>
          <a href="#" className="inline-block group" aria-label="mydigitasset.com home">
            <Logo size="md" theme="light" showBadge={true} />
          </a>
          <p className="text-xs text-stone-600 mt-1 pl-0.5 font-medium">
            {settings.tagline}
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Customer Account Pill / Button (Section 2, 3) */}
          {customer ? (
            <button
              onClick={onOpenCustomerModal}
              className="inline-flex items-center gap-1.5 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-lg border border-stone-300 transition"
              title="View private subscriber account"
            >
              <User className="w-3.5 h-3.5 text-stone-700" />
              <span className="max-w-[120px] truncate">{customer.fullName}</span>
            </button>
          ) : (
            <button
              onClick={onOpenCustomerModal}
              className="inline-flex items-center gap-1.5 bg-stone-50 hover:bg-stone-100 text-stone-700 text-xs font-medium px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg border border-stone-200 transition"
            >
              <User className="w-3.5 h-3.5 text-stone-500" />
              <span>Subscriber Register</span>
            </button>
          )}

          {userState === 'trial' && (
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs font-semibold text-amber-700 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" /> 3-Day Free Trial
              </span>
              <span className="text-[11px] text-stone-700">₹{totalAmount}/yr after trial</span>
            </div>
          )}

          {userState === 'subscribed' && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
              <ShieldCheck className="w-3.5 h-3.5" /> Active Subscriber
            </span>
          )}

          {userState === 'expired' ? (
            <button
              id="header-subscribe-expired-btn"
              onClick={onOpenPaywall}
              className="bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs sm:text-sm px-3.5 py-2 rounded-lg shadow-sm transition active:scale-95"
            >
              Activate Access (₹{totalAmount})
            </button>
          ) : (
            <button
              id="header-pricing-btn"
              onClick={onOpenPaywall}
              className="border border-stone-300 hover:border-stone-400 bg-stone-50 hover:bg-white text-stone-800 font-medium text-xs sm:text-sm px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-lg transition"
            >
              Subscription Details
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
