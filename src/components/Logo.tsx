import React from 'react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  theme?: 'light' | 'dark'; // 'light' is for light backgrounds, 'dark' is for dark backgrounds
  showBadge?: boolean;
  showDomainExtension?: boolean;
  className?: string;
  badgeText?: string;
}

export const Logo: React.FC<LogoProps> = ({
  size = 'md',
  theme = 'light',
  showBadge = true,
  showDomainExtension = true,
  className = '',
  badgeText = 'Daily News',
}) => {
  // Determine sizing scales
  const iconDimensions = {
    sm: { width: 28, height: 28, viewBox: '0 0 40 40' },
    md: { width: 36, height: 36, viewBox: '0 0 40 40' },
    lg: { width: 44, height: 44, viewBox: '0 0 40 40' },
    xl: { width: 56, height: 56, viewBox: '0 0 40 40' },
  }[size];

  const textSizes = {
    sm: 'text-base sm:text-lg',
    md: 'text-xl sm:text-2xl',
    lg: 'text-2xl sm:text-3xl',
    xl: 'text-3xl sm:text-4xl',
  }[size];

  const badgeSizes = {
    sm: 'text-[9px] px-1 py-0.2',
    md: 'text-[10px] sm:text-[11px] px-1.5 py-0.5',
    lg: 'text-xs px-2 py-0.5',
    xl: 'text-xs px-2.5 py-1',
  }[size];

  const isDark = theme === 'dark';

  return (
    <div className={`inline-flex items-center gap-2.5 sm:gap-3 group select-none ${className}`}>
      {/* Dynamic Geometric Digital Asset Emblem */}
      <div className="relative shrink-0 transition-transform duration-200 group-hover:scale-105">
        <svg
          width={iconDimensions.width}
          height={iconDimensions.height}
          viewBox={iconDimensions.viewBox}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="drop-shadow-sm"
        >
          <defs>
            {/* Ambient Base Shadow */}
            <linearGradient id={`mda-bg-${size}-${theme}`} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor={isDark ? '#292524' : '#1c1917'} />
              <stop offset="100%" stopColor={isDark ? '#0c0a09' : '#09090b'} />
            </linearGradient>

            {/* Glowing Amber / Gold Facet Gradients */}
            <linearGradient id={`mda-facet-top-${size}-${theme}`} x1="20" y1="6" x2="20" y2="18" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#FEF3C7" />
              <stop offset="50%" stopColor="#FBBF24" />
              <stop offset="100%" stopColor="#F59E0B" />
            </linearGradient>

            <linearGradient id={`mda-facet-left-${size}-${theme}`} x1="9" y1="14" x2="20" y2="32" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F59E0B" />
              <stop offset="60%" stopColor="#D97706" />
              <stop offset="100%" stopColor="#92400E" />
            </linearGradient>

            <linearGradient id={`mda-facet-right-${size}-${theme}`} x1="31" y1="14" x2="20" y2="32" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#D97706" />
              <stop offset="60%" stopColor="#B45309" />
              <stop offset="100%" stopColor="#78350F" />
            </linearGradient>

            <filter id={`mda-glow-${size}-${theme}`} x="2" y="2" width="36" height="36" filterUnits="userSpaceOnUse">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Squircle Housing with Subtle Border */}
          <rect
            width="40"
            height="40"
            rx="10"
            fill={`url(#mda-bg-${size}-${theme})`}
            className="transition-colors"
          />
          <rect
            x="0.75"
            y="0.75"
            width="38.5"
            height="38.5"
            rx="9.25"
            stroke="#F59E0B"
            strokeOpacity={isDark ? "0.4" : "0.3"}
            strokeWidth="1.2"
          />

          {/* Isometric Digital Asset Node / Monogram Motif */}
          <g filter={`url(#mda-glow-${size}-${theme})`}>
            {/* Top Facet */}
            <path
              d="M20 8L30 14L20 20L10 14Z"
              fill={`url(#mda-facet-top-${size}-${theme})`}
            />

            {/* Left Facet */}
            <path
              d="M10 14L20 20V32L10 26Z"
              fill={`url(#mda-facet-left-${size}-${theme})`}
            />

            {/* Right Facet */}
            <path
              d="M20 20L30 14V26L20 32Z"
              fill={`url(#mda-facet-right-${size}-${theme})`}
            />

            {/* Dynamic Digital Core Circuitry */}
            <circle cx="20" cy="20" r="2.2" fill="#FEF3C7" />
            <path
              d="M20 12V28"
              stroke="#FFFBEB"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeOpacity="0.85"
            />
            <path
              d="M15 17L25 23"
              stroke="#FFFBEB"
              strokeWidth="0.8"
              strokeLinecap="round"
              strokeOpacity="0.6"
            />
          </g>
        </svg>
      </div>

      {/* Brand Typography */}
      <div className="flex flex-col">
        <div className="flex items-baseline gap-1.5 sm:gap-2">
          <span
            className={`font-serif font-extrabold tracking-tight ${textSizes} ${
              isDark ? 'text-white' : 'text-stone-900'
            }`}
          >
            mydigitasset
            {showDomainExtension && (
              <span className={isDark ? 'text-amber-400' : 'text-amber-600'}>
                .com
              </span>
            )}
          </span>

          {showBadge && (
            <span
              className={`uppercase tracking-wider font-bold rounded border ${badgeSizes} ${
                isDark
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  : 'bg-stone-100 text-stone-700 border-stone-200'
              }`}
            >
              {badgeText}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
