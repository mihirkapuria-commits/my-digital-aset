import React from 'react';
import { ShieldCheck, Sparkles, User, Settings, Globe } from 'lucide-react';
import { GlobalSiteSettings, Product } from '../types';

interface HeaderProps {
  settings: GlobalSiteSettings;
  product: Product;
  userState: 'trial' | 'expired' | 'subscribed';
  setUserState: (state: 'trial' | 'expired' | 'subscribed') => void;
  onOpenPaywall: () => void;
  onOpenAdmin: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  settings,
  product,
  userState,
  setUserState,
  onOpenPaywall,
  onOpenAdmin,
}) => {
  const gstAmount = Number(((product.basePriceInr * product.gstRatePercent) / 100).toFixed(2));
  const totalAmount = (product.basePriceInr + gstAmount).toFixed(2);

  return (
    <header id="main-header" className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-stone-200">
      {/* Top Utility Strip: Market Edition & User Status Switcher */}
      <div className="bg-stone-900 text-stone-200 text-xs py-1.5 px-4">
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 font-medium text-amber-400">
              <Globe className="w-3 h-3" /> India Edition
            </span>
            <span className="text-stone-400">•</span>
            <span className="text-stone-300">Briefings Synchronized Daily 6:00 AM – 7:00 AM IST</span>
          </div>

          <div className="flex items-center gap-3">
            {/* View switcher to easily preview different user states */}
            <div className="flex items-center gap-1 bg-stone-800 rounded px-2 py-0.5 border border-stone-700">
              <span className="text-[11px] text-stone-400 hidden sm:inline">Preview Mode:</span>
              <button
                id="state-trial-btn"
                onClick={() => setUserState('trial')}
                className={`px-1.5 py-0.5 text-[11px] rounded font-medium transition ${
                  userState === 'trial' ? 'bg-amber-500 text-stone-950' : 'text-stone-300 hover:text-white'
                }`}
              >
                Trial (Day 1)
              </button>
              <button
                id="state-expired-btn"
                onClick={() => setUserState('expired')}
                className={`px-1.5 py-0.5 text-[11px] rounded font-medium transition ${
                  userState === 'expired' ? 'bg-rose-500 text-white' : 'text-stone-300 hover:text-white'
                }`}
              >
                Trial Expired
              </button>
              <button
                id="state-sub-btn"
                onClick={() => setUserState('subscribed')}
                className={`px-1.5 py-0.5 text-[11px] rounded font-medium transition ${
                  userState === 'subscribed' ? 'bg-emerald-500 text-stone-950' : 'text-stone-300 hover:text-white'
                }`}
              >
                Subscribed
              </button>
            </div>

            <button
              id="header-admin-btn"
              onClick={onOpenAdmin}
              className="flex items-center gap-1 text-[11px] bg-stone-800 hover:bg-stone-700 text-stone-200 px-2.5 py-1 rounded font-medium border border-stone-700 transition"
              title="Admin Control Panel"
            >
              <Settings className="w-3 h-3 text-amber-400" />
              <span>Admin Panel</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Brand & Action Nav */}
      <div className="max-w-5xl mx-auto px-4 py-3 sm:py-4 flex items-center justify-between">
        <div>
          <a href="#" className="flex items-baseline gap-1.5 group">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900 font-serif">
              mydigitalasset<span className="text-amber-600">.com</span>
            </h1>
            <span className="text-[11px] uppercase tracking-wider font-semibold text-stone-700 bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
              Daily News
            </span>
          </a>
          <p className="text-xs text-stone-700 mt-0.5">
            {settings.tagline}
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
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
