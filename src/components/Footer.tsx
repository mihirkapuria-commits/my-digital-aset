import React from 'react';
import { Mail, Shield, Globe } from 'lucide-react';
import { GlobalSiteSettings, Product } from '../types';
import { AdSenseSlot } from './AdSenseSlot';

interface FooterProps {
  settings: GlobalSiteSettings;
  product: Product;
  onOpenPaywall: () => void;
  onOpenAdmin: () => void;
}

export const Footer: React.FC<FooterProps> = ({
  settings,
  product,
  onOpenPaywall,
  onOpenAdmin,
}) => {
  const gstAmount = Number(((product.basePriceInr * product.gstRatePercent) / 100).toFixed(2));
  const totalAmount = (product.basePriceInr + gstAmount).toFixed(2);

  return (
    <footer id="main-footer" className="bg-stone-900 text-stone-300 border-t border-stone-800 mt-12">
      {/* Optional AdSense footer slot if enabled */}
      <div className="max-w-5xl mx-auto px-4 pt-4">
        <AdSenseSlot config={settings.adsense} placement="footerBanner" slotId="footer" />
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 sm:py-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand Column */}
          <div className="space-y-3">
            <h3 className="text-lg font-bold font-serif text-white tracking-tight">
              mydigitalasset<span className="text-amber-500">.com</span>
            </h3>
            <p className="text-xs text-stone-400 leading-relaxed max-w-sm">
              High-value, distraction-free daily intelligence curated specifically for decision-makers and investors across India.
            </p>
            <div className="flex items-center gap-2 text-xs text-stone-400">
              <Globe className="w-3.5 h-3.5 text-amber-500" />
              <span>India Edition</span>
              <span>•</span>
              <span>₹ INR Billing</span>
            </div>
          </div>

          {/* Pricing & GST Info */}
          <div className="space-y-2 text-xs">
            <h4 className="font-semibold text-white uppercase tracking-wider text-[11px]">
              Subscription & Billing
            </h4>
            <ul className="space-y-1.5 text-stone-400">
              <li>
                <span className="text-stone-300 font-medium">3-Day Free Trial:</span> Full access with zero payment required.
              </li>
              <li>
                <span className="text-stone-300 font-medium">Annual Subscription:</span> ₹{totalAmount} / year
              </li>
              <li className="text-[11px] text-stone-400">
                (Base: ₹{product.basePriceInr.toFixed(2)} + 18% GST: ₹{gstAmount.toFixed(2)})
              </li>
              <li>
                <button
                  onClick={onOpenPaywall}
                  className="text-amber-400 hover:text-amber-300 underline underline-offset-2 font-medium"
                >
                  Pay via Phone/UPI or View Receipt
                </button>
              </li>
            </ul>
          </div>

          {/* Customer Support & GST Credit Contact */}
          <div className="space-y-2 text-xs">
            <h4 className="font-semibold text-white uppercase tracking-wider text-[11px]">
              GST Credit & Support
            </h4>
            <p className="text-stone-400 leading-relaxed text-xs">
              For tax invoice requests and GST input credit verification, please write to:
            </p>
            <a
              href={`mailto:${settings.payment.gstCreditEmail}?subject=GST%20Input%20Credit%20Inquiry%20-%20mydigitalasset.com`}
              className="inline-flex items-center gap-1.5 text-amber-400 hover:text-amber-300 font-medium"
            >
              <Mail className="w-3.5 h-3.5" />
              <span>{settings.payment.gstCreditEmail}</span>
            </a>
            <p className="text-[11px] text-stone-400 pt-1">
              Include your Name, Phone, Transaction Reference (UTR), and Company GSTIN.
            </p>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-8 pt-6 border-t border-stone-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-stone-400">
          <p>© {new Date().getFullYear()} mydigitalasset.com. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <button
              onClick={onOpenPaywall}
              className="hover:text-stone-300 transition"
            >
              Subscription Details
            </button>
            <span>•</span>
            <button
              onClick={onOpenAdmin}
              className="hover:text-amber-400 flex items-center gap-1 transition"
            >
              <Shield className="w-3 h-3" />
              <span>Owner Access</span>
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
};
