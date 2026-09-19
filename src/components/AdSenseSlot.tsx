import React from 'react';
import { AdSenseConfiguration } from '../types';

interface AdSenseSlotProps {
  config: AdSenseConfiguration;
  placement: 'homepageBanner' | 'inFeedSeparator' | 'footerBanner';
  slotId?: string;
}

export const AdSenseSlot: React.FC<AdSenseSlotProps> = ({
  config,
  placement,
  slotId = 'slot_default',
}) => {
  // If master toggle is OFF or this specific placement is OFF, do not render anything
  if (!config.isEnabled || !config.placements[placement]) {
    return null;
  }

  return (
    <div
      id={`adsense-${placement}-${slotId}`}
      className="my-8 py-3 px-4 rounded-xl bg-stone-50 border border-stone-200 text-center transition-all"
    >
      {/* Strict Policy Label: Clearly distinct from editorial content */}
      <div className="text-[10px] uppercase font-semibold tracking-widest text-stone-600 mb-2 select-none">
        Advertisement
      </div>

      {/* Ad Container Box with safe margins */}
      <div className="min-h-[100px] sm:min-h-[120px] flex flex-col items-center justify-center p-4 bg-white rounded-lg border border-dashed border-stone-300 text-stone-600">
        <span className="text-xs font-medium text-stone-600">
          Google AdSense Placement
        </span>
        <span className="text-[11px] text-stone-600 mt-0.5">
          {placement === 'homepageBanner' && 'Responsive Top Header Slot'}
          {placement === 'inFeedSeparator' && 'Responsive In-Feed Content Separator'}
          {placement === 'footerBanner' && 'Responsive Bottom Footer Slot'}
        </span>
        <span className="text-[10px] text-stone-600 mt-1 font-mono">
          Publisher: {config.publisherId || 'ca-pub-XXXXXXXXXXXXX'}
        </span>
      </div>

      <div className="text-[10px] text-stone-600 mt-2">
        Ad placements adhere strictly to Google Publisher Policies (spacious buffers & clear labeling).
      </div>
    </div>
  );
};
