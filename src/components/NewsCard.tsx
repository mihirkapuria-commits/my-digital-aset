import React from 'react';
import { ExternalLink, Calendar, Lock, Clock } from 'lucide-react';
import { NewsArticle } from '../types';

interface NewsCardProps {
  article: NewsArticle;
  isLocked?: boolean;
  onUnlockClick?: () => void;
}

export const NewsCard: React.FC<NewsCardProps> = ({
  article,
  isLocked = false,
  onUnlockClick,
}) => {
  // Format date nicely e.g., "18 Sep 2026"
  const formattedDate = new Date(article.date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  // Extract synchronization time from createdAt (e.g., 06:35 AM IST)
  const formattedTime = (() => {
    if (!article.createdAt) return null;
    const d = new Date(article.createdAt);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC', // matching our synchronized timestamps
    });
  })();

  return (
    <article
      id={`news-card-${article.id}`}
      className="bg-white rounded-xl border border-stone-200 p-4 sm:p-5 hover:border-stone-300 transition-shadow hover:shadow-xs relative overflow-hidden"
    >
      {/* Category & Date Meta Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500 mb-2.5">
        <span className="font-semibold uppercase tracking-wider text-[11px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200/60">
          {article.categoryName}
        </span>
        <div className="flex items-center gap-2.5 text-stone-600 text-[11px]">
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3 text-stone-400" />
            {formattedDate}
          </span>
          {formattedTime && (
            <span className="flex items-center gap-1 text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200/60 font-mono text-[10px]">
              <Clock className="w-2.5 h-2.5 text-amber-600" />
              Synced {formattedTime} IST
            </span>
          )}
        </div>
      </div>

      {/* Headline */}
      <h3 className="text-base sm:text-lg font-bold text-stone-900 tracking-tight leading-snug font-serif">
        {article.headline}
      </h3>

      {/* Summary or Locked State */}
      {isLocked ? (
        <div className="mt-3 relative">
          <p className="text-sm text-stone-400 select-none filter blur-[3px]">
            {article.summary}
          </p>
          <div className="absolute inset-0 flex items-center justify-center bg-stone-50/70 rounded-md">
            <button
              onClick={onUnlockClick}
              className="inline-flex items-center gap-1.5 bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold px-3 py-1.5 rounded-md shadow-xs transition active:scale-95"
            >
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Unlock with Subscription</span>
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2.5 text-sm text-stone-700 leading-relaxed">
          {article.summary}
        </p>
      )}

      {/* Source Citation & Outbound Link */}
      <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between text-xs">
        <span className="text-stone-600 font-medium">
          Source: <span className="text-stone-700">{article.sourceName}</span>
        </span>
        <a
          href={article.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-800 font-medium hover:underline text-xs"
        >
          <span>Read original</span>
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </article>
  );
};
