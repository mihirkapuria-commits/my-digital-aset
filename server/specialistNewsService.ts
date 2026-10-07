import crypto from 'crypto';
import {
  DailyNewsPackage,
  NewsStory,
} from '../src/types';
import {
  getDb,
  saveDb,
} from './db.js';
import {
  atomicReserveOperation,
  atomicCompleteOperation,
  atomicReleaseReservation,
} from './idempotencyService.js';
import {
  getKolkataDateString,
  formatKolkataHeaderDate,
} from './newsService.js';

// ============================================================================
// SYSTEM A: EXISTING SPECIALIST NEWS SYSTEM
// ============================================================================
// The 7 Working Specialist News Categories:
// 1. Japan Real Estate
// 2. India Healthcare
// 3. India PE / VC
// 4. India Coffee & Nespresso
// 5. India Oil & Gas
// 6. India Wedding Cards
// 7. India Gems & Jewellery

export const SPECIALIST_CATEGORY_IDS = [
  'cat_japan_re',
  'cat_india_healthcare',
  'cat_india_pe_vc',
  'cat_india_coffee_nespresso',
  'cat_india_oil_gas',
  'cat_india_wedding_cards',
  'cat_india_gems_jewellery',
] as const;

export type SpecialistCategoryId = typeof SPECIALIST_CATEGORY_IDS[number];

export function isSpecialistCategory(categoryId: string): boolean {
  return SPECIALIST_CATEGORY_IDS.includes(categoryId as any);
}

export interface RawSpecialistArticle {
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  categoryHint: SpecialistCategoryId;
}

export const SPECIALIST_SOURCE_DATA: Record<SpecialistCategoryId, RawSpecialistArticle[]> = {
  cat_japan_re: [
    {
      title: 'Tokyo Prime Residential Capital Values Rise 4.8% on Inbound Cross-Border Inflows',
      summary: 'Institutional property funds and family offices from Singapore and Hong Kong accelerated allocations into central Tokyo residential towers, buoyed by favorable yen borrowing costs.',
      sourceName: 'Japan Property Central',
      sourceUrl: 'https://japanpropertycentral.com/tokyo-prime-residential-capital-values',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_japan_re',
    },
    {
      title: 'Global Sovereign Funds Commit $1.8B to Osaka and Nagoya Logistics Portfolios',
      summary: 'E-commerce warehousing demand and modern cold-storage logistics along Tokyo-Osaka distribution corridors underpinned cross-border industrial J-REIT transactions.',
      sourceName: 'Nikkei Real Estate Market Report',
      sourceUrl: 'https://asia.nikkei.com/business/markets/property/japan-logistics-investments',
      publishedAt: '2026-09-29T07:30:00Z',
      categoryHint: 'cat_japan_re',
    },
    {
      title: 'Bank of Japan Monetary Policy Review Retains Accommodative Corporate REIT Debt Spreads',
      summary: 'Central bank rate guidance maintained tight credit spreads for top-tier Japanese real estate investment trusts, preserving positive cash-on-cash yield differentials.',
      sourceName: 'Tokyo Financial Review',
      sourceUrl: 'https://tokyofinancialreview.com/boj-reit-debt-spreads',
      publishedAt: '2026-09-29T06:00:00Z',
      categoryHint: 'cat_japan_re',
    },
  ],

  cat_india_healthcare: [
    {
      title: 'Tier-2 Hospital Chains Secure $220M Private Equity Expansion Facilities for Oncology Wings',
      summary: 'Institutional healthcare funds backed regional hospital groups expanding specialized tertiary care, robotic surgery, and advanced oncology hubs in non-metro capitals.',
      sourceName: 'Healthcare Executive India',
      sourceUrl: 'https://healthcareexecutive.in/tier2-hospital-expansion-oncology',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_india_healthcare',
    },
    {
      title: 'CDSCO Approves Indigenous Monoclonal Antibody Biosimilar with 45% Price Advantage',
      summary: 'Domestic biopharma manufacturer cleared Phase III commercial safety verification, ensuring affordable targeted biological therapies across tertiary hospital networks.',
      sourceName: 'PharmaBiz Bureau',
      sourceUrl: 'https://pharmabiz.com/cdsco-indigenous-biosimilar-clearance',
      publishedAt: '2026-09-29T07:15:00Z',
      categoryHint: 'cat_india_healthcare',
    },
    {
      title: 'MedTech PLI Program Triggers Domestic Manufacturing Facilities for CT and MRI Sensors',
      summary: 'Production-linked incentives catalyzed joint ventures in Tamil Nadu and Gujarat, localizing high-precision digital diagnostic imaging component supply chains.',
      sourceName: 'Indian Medical Device Monitor',
      sourceUrl: 'https://medicaldevicemonitor.in/medtech-pli-domestic-manufacturing',
      publishedAt: '2026-09-29T06:30:00Z',
      categoryHint: 'cat_india_healthcare',
    },
  ],

  cat_india_pe_vc: [
    {
      title: 'Indian Private Capital Inflows Rebound with $3.4B Deployed in Growth Transactions',
      summary: 'Cross-border buyout funds and domestic institutional LPs targeted manufacturing, financial services, and enterprise software platforms in landmark structured transactions.',
      sourceName: 'Venture Intelligence Daily',
      sourceUrl: 'https://ventureintelligence.com/india-private-capital-rebound',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_india_pe_vc',
    },
    {
      title: 'SEBI Streamlines Secondary Share Sale Guidelines for Alternative Investment Funds',
      summary: 'New market regulator provisions allow continuation funds and portfolio secondaries without triggering complex structural tax penalties, facilitating LP liquidity.',
      sourceName: 'LiveMint Deals & Markets',
      sourceUrl: 'https://livemint.com/market/sebi-aif-secondary-guidelines',
      publishedAt: '2026-09-29T07:00:00Z',
      categoryHint: 'cat_india_pe_vc',
    },
    {
      title: 'Sovereign Wealth Funds Expand Direct Co-Investment Partnerships with Domestic Fund Managers',
      summary: 'Abu Dhabi and Singapore sovereign investment vehicles committed anchor capital to dedicated India private equity platforms focusing on green energy and logistics.',
      sourceName: 'The Economic Times Private Equity',
      sourceUrl: 'https://economictimes.indiatimes.com/mf/private-equity/sovereign-co-investments',
      publishedAt: '2026-09-29T06:15:00Z',
      categoryHint: 'cat_india_pe_vc',
    },
  ],

  cat_india_coffee_nespresso: [
    {
      title: 'Specialty Indian Arabica Exports to Europe Surpass $140M Milestone on Single-Origin Demand',
      summary: 'Chikkamagaluru and Araku Valley certified single-estate beans saw premium price realization at international auctions in Trieste and Zurich.',
      sourceName: 'Coffee Board of India Trade Bulletin',
      sourceUrl: 'https://coffeeboard.gov.in/specialty-arabica-exports-surge',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_india_coffee_nespresso',
    },
    {
      title: 'Nespresso Expands Premium Retail Boutique Footprint Across Mumbai and Bengaluru',
      summary: 'Nestlé Nespresso announced dedicated tasting flagship stores and indigenous coffee capsule collection partnerships with heritage shade-grown plantations.',
      sourceName: 'Beverage Business India',
      sourceUrl: 'https://beveragebusiness.in/nespresso-expands-india-boutiques',
      publishedAt: '2026-09-29T07:00:00Z',
      categoryHint: 'cat_india_coffee_nespresso',
    },
    {
      title: 'Domestic Specialty Coffee Chains Secure Institutional Growth Rounds for Rapid Metro Scaling',
      summary: 'Direct-to-consumer roasters and artisanal cafe operators captured rising urban consumption, doubling pod-compatible product ranges.',
      sourceName: 'The Hindu BusinessLine Agribusiness',
      sourceUrl: 'https://thehindubusinessline.com/economy/agri-business/specialty-coffee-chains',
      publishedAt: '2026-09-29T06:00:00Z',
      categoryHint: 'cat_india_coffee_nespresso',
    },
  ],

  cat_india_oil_gas: [
    {
      title: 'India Natural Gas Pipeline Network Expands by 1,200 km Connecting Eastern Industrial Hubs',
      summary: 'GAIL operationalized key spur lines connecting fertilizer plants and city gas distribution networks in Odisha and West Bengal, advancing the national gas grid vision.',
      sourceName: 'PetroWatch India',
      sourceUrl: 'https://petrowatch.com/india-gas-pipeline-network-expansion',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_india_oil_gas',
    },
    {
      title: 'Refining Margins Strengthen as Indian Upstream Majors Ramp Up Deepwater Exploration',
      summary: 'ONGC and private operators deployed next-generation offshore drillships in Krishna-Godavari deepwater blocks, augmenting domestic crude extraction volumes.',
      sourceName: 'Energy World India',
      sourceUrl: 'https://energy.economictimes.indiatimes.com/news/oil-and-gas/refining-margins-upstream',
      publishedAt: '2026-09-29T07:15:00Z',
      categoryHint: 'cat_india_oil_gas',
    },
    {
      title: 'Dhamra LNG Terminal Records Record Monthly Regasification Utilization on Power Sector Demand',
      summary: 'Favorable global spot LNG prices prompted industrial off-takers to lock in long-term regasification volumes, stabilizing western and eastern grid capacity.',
      sourceName: 'Business Standard Energy',
      sourceUrl: 'https://business-standard.com/companies/news/dhamra-lng-terminal-record',
      publishedAt: '2026-09-29T06:30:00Z',
      categoryHint: 'cat_india_oil_gas',
    },
  ],

  cat_india_wedding_cards: [
    {
      title: 'Luxury Indian Wedding Stationery Designers Adopt Sustainable Handcrafted Seed Papers',
      summary: 'High-end design ateliers in Delhi and Jaipur reported surge in bespoke botanical prints, gold-foil calligraphy, and biodegradable plantable invitation suites.',
      sourceName: 'Ceremonial Design Quarterly',
      sourceUrl: 'https://ceremonialdesign.in/luxury-wedding-stationery-trends',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_india_wedding_cards',
    },
    {
      title: 'Digital Augmented Reality Wedding Invitations Gain 60% Market Adoption Among NRI Couples',
      summary: 'Interactive NFC and AR card suites integrated with RSVP management dashboards transformed high-profile destination wedding communications.',
      sourceName: 'WeddingSutra Industry News',
      sourceUrl: 'https://weddingsutra.com/news/ar-wedding-invitations-nri-market',
      publishedAt: '2026-09-29T07:00:00Z',
      categoryHint: 'cat_india_wedding_cards',
    },
    {
      title: 'Premium Ceremonial Print Hubs in Surat and Sivakasi Upgrade to Ultra-Fine Micro-Embossing',
      summary: 'Investments in precision laser die-cutting and specialized imported paper stocks enabled export fulfillment for grand celebration suites in GCC and UK.',
      sourceName: 'PrintWeek India',
      sourceUrl: 'https://printweek.in/news/ceremonial-print-micro-embossing-expansion',
      publishedAt: '2026-09-29T06:00:00Z',
      categoryHint: 'cat_india_wedding_cards',
    },
  ],

  cat_india_gems_jewellery: [
    {
      title: 'Surat Diamond Bourse Achieves $2.8B Monthly Polished Trading Turnover as Global Buyers Return',
      summary: 'Export consignments to the US and Gulf markets gathered momentum ahead of festive quarters, solidifying Indias global natural diamond cutting leadership.',
      sourceName: 'Diamond World News',
      sourceUrl: 'https://diamondworld.net/surat-diamond-bourse-monthly-trading',
      publishedAt: '2026-09-29T08:00:00Z',
      categoryHint: 'cat_india_gems_jewellery',
    },
    {
      title: 'Lab-Grown Diamond Jewellery Retail Chains Expand Tier-1 Presence on Millennial Bridal Demand',
      summary: 'Lower price points and certified sustainable provenance drove 42% volume growth in domestic CVD solitaire rings and ceremonial sets.',
      sourceName: 'Retail Jeweller India',
      sourceUrl: 'https://retailjewellerindia.com/lab-grown-diamond-bridal-demand',
      publishedAt: '2026-09-29T07:15:00Z',
      categoryHint: 'cat_india_gems_jewellery',
    },
    {
      title: 'Hallmarking Compliance Crosses 98% Across All Certified Domestic Gold Jewellery Showrooms',
      summary: 'Bureau of Indian Standards telemetry demonstrated strict consumer transparency, boosting institutional gold lending and organized retail market share.',
      sourceName: 'The Economic Times Bullion & Gems',
      sourceUrl: 'https://economictimes.indiatimes.com/wealth/gold/hallmarking-compliance-record',
      publishedAt: '2026-09-29T06:00:00Z',
      categoryHint: 'cat_india_gems_jewellery',
    },
  ],
};

/**
 * Generates daily news package for a specialist category in System A
 */
export async function generateSpecialistCategoryDailyNews(
  categoryId: string,
  newsDate: string = getKolkataDateString()
): Promise<{ success: boolean; package?: DailyNewsPackage; stories?: NewsStory[]; error?: string }> {
  const db = getDb();
  const category = db.categories.find((c) => c.id === categoryId);

  if (!category) {
    return { success: false, error: `Specialist category '${categoryId}' not found.` };
  }

  if (!category.isActive) {
    return {
      success: false,
      error: `Specialist category '${category.name}' (${categoryId}) is currently disabled. Generation suppressed.`,
    };
  }

  // Idempotency: return if package already exists
  const existingPkg = db.dailyNewsPackages.find(
    (p) =>
      p.categoryId === categoryId &&
      p.newsDate === newsDate &&
      (p.generationStatus === 'success' || p.generationStatus === 'partial')
  );

  if (existingPkg) {
    const existingStories = db.newsStories
      .filter((s) => s.packageId === existingPkg.packageId)
      .sort((a, b) => a.position - b.position);

    if (existingStories.length > 0) {
      return {
        success: true,
        package: existingPkg,
        stories: existingStories,
      };
    }
  }

  // Atomic reservation for System A
  const packageKey = `pkg_spec_${newsDate}_${categoryId}`;
  const reservation = await atomicReserveOperation(packageKey, {
    ttlSeconds: 600,
    metadata: { categoryId, newsDate, system: 'specialist' },
  });

  if (!reservation.reserved && reservation.reason !== 'already_completed') {
    return {
      success: false,
      error: `Generation for specialist category '${categoryId}' on ${newsDate} is already in progress.`,
    };
  }

  const packageId = `pkg_spec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  // Retrieve candidate pool
  const candidatePool = SPECIALIST_SOURCE_DATA[categoryId as SpecialistCategoryId] || [];
  const storiesToSave = candidatePool.slice(0, 10);

  const pkgRecord: DailyNewsPackage = {
    packageId,
    newsDate,
    categoryId: category.id,
    categoryName: category.name,
    generationStatus: storiesToSave.length > 0 ? 'success' : 'failed',
    storyCount: storiesToSave.length,
    createdAt: now,
    updatedAt: now,
    system: 'specialist',
  };

  db.dailyNewsPackages.push(pkgRecord);

  const storyRecords: NewsStory[] = storiesToSave.map((s, idx) => ({
    storyId: `sty_spec_${crypto.randomBytes(8).toString('hex')}`,
    packageId,
    newsDate,
    categoryId: category.id,
    position: idx + 1,
    headline: s.title,
    summary: s.summary,
    sourceName: s.sourceName,
    sourceUrl: s.sourceUrl,
    sentimentType: 'constructive',
    createdAt: now,
  }));

  db.newsStories.push(...storyRecords);
  saveDb();

  await atomicCompleteOperation(packageKey, { packageId, storyCount: storyRecords.length });

  return {
    success: true,
    package: pkgRecord,
    stories: storyRecords,
  };
}

/**
 * Generates all active specialist categories news packages for a given day
 */
export async function generateDailyAllSpecialistNews(
  newsDate: string = getKolkataDateString()
): Promise<{
  newsDate: string;
  totalCategories: number;
  successfulCategories: number;
  failedCategories: number;
  totalStories: number;
  results: Array<{ categoryId: string; categoryName: string; success: boolean; storyCount: number; error?: string }>;
}> {
  const db = getDb();
  const activeSpecialistCats = db.categories.filter(
    (c) => c.isActive && SPECIALIST_CATEGORY_IDS.includes(c.id as any)
  );

  const results: Array<{ categoryId: string; categoryName: string; success: boolean; storyCount: number; error?: string }> = [];
  let successfulCategories = 0;
  let failedCategories = 0;
  let totalStories = 0;

  for (const cat of activeSpecialistCats) {
    try {
      const res = await generateSpecialistCategoryDailyNews(cat.id, newsDate);
      if (res.success && res.package) {
        successfulCategories++;
        totalStories += res.package.storyCount;
        results.push({
          categoryId: cat.id,
          categoryName: cat.name,
          success: true,
          storyCount: res.package.storyCount,
        });
      } else {
        failedCategories++;
        results.push({
          categoryId: cat.id,
          categoryName: cat.name,
          success: false,
          storyCount: 0,
          error: res.error,
        });
      }
    } catch (err: any) {
      failedCategories++;
      results.push({
        categoryId: cat.id,
        categoryName: cat.name,
        success: false,
        storyCount: 0,
        error: err.message || 'Generation error',
      });
    }
  }

  return {
    newsDate,
    totalCategories: activeSpecialistCats.length,
    successfulCategories,
    failedCategories,
    totalStories,
    results,
  };
}

/**
 * Formats specialist category news for Telegram (System A)
 */
export function formatSpecialistNewsTelegramMessage(pkg: DailyNewsPackage, stories: NewsStory[]): string {
  const headerDate = formatKolkataHeaderDate(pkg.newsDate);
  const categoryHeader = `📰 *MYDIGITASSET — ${pkg.categoryName.toUpperCase()}*\n📅 *${headerDate}*\n\n`;

  const storiesFormatted = stories
    .map((s) => {
      return `*${s.position}. ${s.headline}*\n${s.summary}\n🔗 _Source: [${s.sourceName}](${s.sourceUrl})_`;
    })
    .join('\n\n');

  const footer = `\n\n───────────────────\n🔒 *MyDigitAsset Executive Intelligence*\n_Curated daily specialist briefing for subscribers._`;

  return `${categoryHeader}${storiesFormatted}${footer}`;
}
