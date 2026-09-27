import { useState, useMemo, useEffect } from 'react';
import { 
  initialProduct, 
  initialCategories, 
  initialNewsArticles, 
  initialSiteSettings 
} from './data/initialData';
import { Product, Category, NewsArticle, GlobalSiteSettings } from './types';
import { Header } from './components/Header';
import { CategoryFilter } from './components/CategoryFilter';
import { FreeTrialBanner } from './components/FreeTrialBanner';
import { NewsCard } from './components/NewsCard';
import { AdSenseSlot } from './components/AdSenseSlot';
import { PaywallModal } from './components/PaywallModal';
import { AdminPortal } from './components/AdminPortal';
import { Footer } from './components/Footer';
import { Newspaper, Sparkles, Filter } from 'lucide-react';

export default function App() {
  const [product, setProduct] = useState<Product>(initialProduct);
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [articles, setArticles] = useState<NewsArticle[]>(initialNewsArticles);
  const [settings, setSettings] = useState<GlobalSiteSettings>(initialSiteSettings);

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [userState, setUserState] = useState<'trial' | 'expired' | 'subscribed'>('trial');
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);

  // Check whether current URL is private Admin path (/admin)
  const [isAdminPath, setIsAdminPath] = useState<boolean>(() => {
    return window.location.pathname.startsWith('/admin');
  });

  // Listen for browser navigation / popstate
  useEffect(() => {
    const handleLocationChange = () => {
      setIsAdminPath(window.location.pathname.startsWith('/admin'));
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  // Fetch persisted settings from server
  useEffect(() => {
    fetch('/api/site-settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.settings) {
          setSettings((prev) => ({ ...prev, ...data.settings }));
        }
      })
      .catch(() => {});
  }, []);

  // Filtered articles based on selected category tab
  const filteredArticles = useMemo(() => {
    if (!selectedCategoryId) return articles;
    return articles.filter((a) => a.categoryId === selectedCategoryId);
  }, [articles, selectedCategoryId]);

  // Article count badge calculator per category
  const articleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    articles.forEach((a) => {
      counts[a.categoryId] = (counts[a.categoryId] || 0) + 1;
    });
    return counts;
  }, [articles]);

  const activeCategoryObj = useMemo(() => {
    if (!selectedCategoryId) return null;
    return categories.find((c) => c.id === selectedCategoryId);
  }, [categories, selectedCategoryId]);

  const handlePaymentSubmitted = (txnRef: string) => {
    setUserState('subscribed');
  };

  // If navigating directly to private Admin URL
  if (isAdminPath) {
    return (
      <AdminPortal
        settings={settings}
        onUpdateSettings={setSettings}
        product={product}
        onUpdateProduct={setProduct}
        categories={categories}
        onUpdateCategories={setCategories}
        onExitAdmin={() => {
          window.history.pushState({}, '', '/');
          setIsAdminPath(false);
        }}
      />
    );
  }

  // ====================================================
  // PUBLIC WEBSITE (NO Admin buttons, menus, or links)
  // ====================================================
  return (
    <div className="min-h-screen flex flex-col bg-stone-100/60 font-sans text-stone-900 selection:bg-amber-100 selection:text-amber-900">
      {/* 1. Public Header with branding and edition badge */}
      <Header
        settings={settings}
        product={product}
        userState={userState}
        setUserState={setUserState}
        onOpenPaywall={() => setIsPaywallOpen(true)}
      />

      {/* 2. Category Tab Navigation */}
      <CategoryFilter
        categories={categories}
        selectedCategoryId={selectedCategoryId}
        onSelectCategory={setSelectedCategoryId}
        articleCounts={articleCounts}
      />

      {/* 3. Main Content Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 sm:py-8">
        {/* Optional Homepage AdSense Banner */}
        <AdSenseSlot
          config={settings.adsense}
          placement="homepageBanner"
          slotId="home-top"
        />

        {/* Dynamic Free Trial / Subscription Status Banner */}
        <FreeTrialBanner
          userState={userState}
          product={product}
          onOpenPaywall={() => setIsPaywallOpen(true)}
        />

        {/* Section Header */}
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1 mb-6 pb-3 border-b border-stone-200">
          <div>
            <div className="flex items-center gap-2">
              <Newspaper className="w-4 h-4 text-stone-700" />
              <h2 className="text-lg sm:text-xl font-bold font-serif text-stone-900 tracking-tight">
                {activeCategoryObj ? activeCategoryObj.name : "Today's Curated Intelligence"}
              </h2>
            </div>
            <p className="text-xs text-stone-500 mt-0.5">
              {activeCategoryObj?.description ||
                'Executive summaries hand-selected and distilled for decision-makers in India.'}
            </p>
          </div>

          <span className="text-[11px] font-medium text-stone-500 shrink-0">
            Showing {filteredArticles.length} briefing{filteredArticles.length === 1 ? '' : 's'}
          </span>
        </div>

        {/* Articles Feed */}
        {filteredArticles.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-2xl border border-stone-200 p-8">
            <Filter className="w-8 h-8 text-stone-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-stone-800">No briefings found in this category</p>
            <p className="text-xs text-stone-500 mt-1">Select another category or view all briefings.</p>
            <button
              onClick={() => setSelectedCategoryId(null)}
              className="mt-4 text-xs font-semibold text-amber-700 hover:text-amber-800 underline underline-offset-2 cursor-pointer"
            >
              View All Categories
            </button>
          </div>
        ) : (
          <div className="space-y-4 sm:space-y-5">
            {filteredArticles.map((article, index) => {
              const showInFeedAd = index === 1;

              return (
                <div key={article.id}>
                  <NewsCard
                    article={article}
                    isLocked={userState === 'expired'}
                    onUnlockClick={() => setIsPaywallOpen(true)}
                  />

                  {showInFeedAd && (
                    <AdSenseSlot
                      config={settings.adsense}
                      placement="inFeedSeparator"
                      slotId={`feed-${index}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Synchronization reassurance note */}
        <div className="mt-8 text-center bg-white border border-stone-200 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-stone-800">
            <Sparkles className="w-3.5 h-3.5 text-amber-600" />
            <span>Updated Daily: 6:00 AM – 7:00 AM IST</span>
          </div>
          <p className="text-xs text-stone-600 mt-1 max-w-lg mx-auto">
            Briefings are synchronized every morning from 6:00 AM to 7:00 AM from verified international and domestic sources.
          </p>
        </div>
      </main>

      {/* 4. Public Footer (No Admin options or owner links) */}
      <Footer
        settings={settings}
        product={product}
        onOpenPaywall={() => setIsPaywallOpen(true)}
      />

      {/* 5. Paywall / Checkout Modal */}
      <PaywallModal
        isOpen={isPaywallOpen}
        onClose={() => setIsPaywallOpen(false)}
        product={product}
        paymentConfig={settings.payment}
        onPaymentSubmitted={handlePaymentSubmitted}
      />
    </div>
  );
}
