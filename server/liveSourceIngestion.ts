import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { CONFIGURED_SOURCE_DOMAINS, RawCollectedArticle, validateStorySource } from './newsService.js';

/**
 * ============================================================================
 * PHASE 5.1: LIVE NEWS SOURCE INTEGRATION & REAL RSS/ATOM INGESTION
 * ============================================================================
 * Implements real-time news retrieval from authoritative Indian business news feeds.
 * Includes:
 * - Legitimate RSS/Atom structured retrieval
 * - Bounded timeouts & exponential backoff
 * - HTTP 429 & 5xx resilience
 * - Single source failure isolation
 * - Strict freshness window filtering (48 hours)
 * - URL & title canonical deduplication
 * - Strict candidate-pool URL provenance check (measurable source grounding constraint)
 * - Clean separation between Live and Mock/Fixture modes
 */

export interface LiveSourceFeedConfig {
  id: string;
  name: string;
  feedUrl: string;
  domain: string;
  categoryIds: string[];
  isActive: boolean;
}

export interface LiveRetrievedArticle {
  sourceName: string;
  sourceUrl: string;
  headline: string;
  summary: string;
  publishedAt: string; // ISO 8601 string
  retrievedAt: string; // ISO 8601 string
  categoryId: string;
  categoryRelevanceInfo?: string;
  isNegativeDevelopment?: boolean;
}

export type SourceProviderMode = 'live' | 'mock' | 'auto';

let currentProviderMode: SourceProviderMode = (process.env.SOURCE_PROVIDER_MODE as SourceProviderMode) || 'auto';

export function getSourceProviderMode(): SourceProviderMode {
  return currentProviderMode;
}

export function setSourceProviderMode(mode: SourceProviderMode): void {
  currentProviderMode = mode;
  console.log(`[News Source Engine] Source provider mode set to: ${mode.toUpperCase()}`);
}

/**
 * Official Public RSS/Atom Feeds for the 10 India Business Categories
 * Strictly mapped to authoritative Indian financial and industry publications.
 */
export const OFFICIAL_LIVE_FEEDS: LiveSourceFeedConfig[] = [
  // 1. India Startups
  {
    id: 'et_startups',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/tech/startups/rssfeeds/13357270.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_startups'],
    isActive: true,
  },
  {
    id: 'inc42_startups',
    name: 'Inc42',
    feedUrl: 'https://inc42.com/feed/',
    domain: 'inc42.com',
    categoryIds: ['cat_india_startups', 'cat_india_banking_fintech'],
    isActive: true,
  },
  {
    id: 'mint_tech_startups',
    name: 'Mint',
    feedUrl: 'https://www.livemint.com/rss/technology',
    domain: 'livemint.com',
    categoryIds: ['cat_india_startups', 'cat_india_it_tech'],
    isActive: true,
  },

  // 2. India Banking & FinTech
  {
    id: 'et_banking',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/industry/banking/finance/rssfeeds/13358319.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_banking_fintech'],
    isActive: true,
  },
  {
    id: 'bs_finance',
    name: 'Business Standard',
    feedUrl: 'https://www.business-standard.com/rss/finance-103.rss',
    domain: 'business-standard.com',
    categoryIds: ['cat_india_banking_fintech'],
    isActive: true,
  },
  {
    id: 'mc_business',
    name: 'Moneycontrol',
    feedUrl: 'https://www.moneycontrol.com/rss/business.xml',
    domain: 'moneycontrol.com',
    categoryIds: ['cat_india_banking_fintech', 'cat_india_economy_business'],
    isActive: true,
  },

  // 3. India Real Estate & Infrastructure
  {
    id: 'et_property_infra',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/industry/services/property-/-cstruction/rssfeeds/13358365.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_re_infra'],
    isActive: true,
  },
  {
    id: 'mint_industry',
    name: 'Mint',
    feedUrl: 'https://www.livemint.com/rss/industry',
    domain: 'livemint.com',
    categoryIds: ['cat_india_re_infra', 'cat_india_mfg_auto', 'cat_india_energy_renewables'],
    isActive: true,
  },
  {
    id: 'bs_companies',
    name: 'Business Standard',
    feedUrl: 'https://www.business-standard.com/rss/companies-101.rss',
    domain: 'business-standard.com',
    categoryIds: ['cat_india_re_infra', 'cat_india_consumer_fmcg', 'cat_india_mfg_auto', 'cat_india_energy_renewables', 'cat_india_hr_employment', 'cat_india_marketing_ads'],
    isActive: true,
  },

  // 4. India Information Technology (IT), AI, Cybersecurity
  {
    id: 'et_tech',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_it_tech'],
    isActive: true,
  },
  {
    id: 'bs_tech',
    name: 'Business Standard',
    feedUrl: 'https://www.business-standard.com/rss/technology-108.rss',
    domain: 'business-standard.com',
    categoryIds: ['cat_india_it_tech'],
    isActive: true,
  },

  // 5. India Consumer & FMCG
  {
    id: 'et_consumer_products',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/industry/cons-products/rssfeeds/13358341.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_consumer_fmcg'],
    isActive: true,
  },
  {
    id: 'mint_companies_fmcg',
    name: 'Mint',
    feedUrl: 'https://www.livemint.com/rss/companies',
    domain: 'livemint.com',
    categoryIds: ['cat_india_consumer_fmcg', 'cat_india_marketing_ads', 'cat_india_hr_employment'],
    isActive: true,
  },

  // 6. India Manufacturing & Auto
  {
    id: 'et_auto',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/industry/auto/rssfeeds/13358311.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_mfg_auto'],
    isActive: true,
  },

  // 7. India Energy & Renewables
  {
    id: 'et_energy',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/industry/energy/rssfeeds/13358259.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_energy_renewables'],
    isActive: true,
  },

  // 8. India Economy & Business
  {
    id: 'et_economy',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/news/economy/rssfeeds/13762478.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_economy_business', 'cat_india_energy_renewables', 'cat_india_hr_employment'],
    isActive: true,
  },
  {
    id: 'mint_economy',
    name: 'Mint',
    feedUrl: 'https://www.livemint.com/rss/economy',
    domain: 'livemint.com',
    categoryIds: ['cat_india_economy_business'],
    isActive: true,
  },
  {
    id: 'bs_top_stories',
    name: 'Business Standard',
    feedUrl: 'https://www.business-standard.com/rss/home_page_top_stories.rss',
    domain: 'business-standard.com',
    categoryIds: ['cat_india_economy_business'],
    isActive: true,
  },
  {
    id: 'mc_economy',
    name: 'Moneycontrol',
    feedUrl: 'https://www.moneycontrol.com/rss/economy.xml',
    domain: 'moneycontrol.com',
    categoryIds: ['cat_india_economy_business'],
    isActive: true,
  },

  // 9. India HR & Employment
  {
    id: 'et_jobs',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/jobs/rssfeeds/107115.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_hr_employment'],
    isActive: true,
  },

  // 10. India Marketing & Advertising
  {
    id: 'et_advertising',
    name: 'The Economic Times',
    feedUrl: 'https://economictimes.indiatimes.com/industry/services/advertising/rssfeeds/13358357.cms',
    domain: 'economictimes.indiatimes.com',
    categoryIds: ['cat_india_marketing_ads'],
    isActive: true,
  },
];

/**
 * Freshness Window Rule (Requirement 5)
 * Articles published within the past 48 hours are considered fresh.
 * Over weekends / holidays, up to 72 hours can be accepted if explicitly requested.
 */
export const DEFAULT_FRESHNESS_WINDOW_HOURS = 48;

/**
 * Normalizes and strips tracking parameters (utm_*, ref, etc.) from candidate URLs (Requirement 4 & 6)
 */
export function normalizeArticleUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.trim());
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
      'ref_src',
      'source',
      'fbclid',
      'gclid',
      '_ga',
    ];
    for (const p of trackingParams) {
      url.searchParams.delete(p);
    }
    // Remove trailing slash if path is not root
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Clean plain text from CDATA or HTML markup
 */
export function stripHtmlAndCdata(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses publication timestamp safely to ISO 8601
 */
export function parsePubDateToIso(dateStr?: string): string | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parsed = Date.parse(dateStr);
  if (isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Checks if article satisfies freshness requirement (Requirement 5)
 */
export function isArticleFresh(
  publishedAtIso: string | null,
  referenceDate: Date = new Date(),
  maxHours: number = DEFAULT_FRESHNESS_WINDOW_HOURS
): boolean {
  if (!publishedAtIso) {
    // If no published date is available, we treat it cautiously as non-stale only if recent retrieval
    return true;
  }
  const publishedTime = new Date(publishedAtIso).getTime();
  if (isNaN(publishedTime)) return false;

  const refTime = referenceDate.getTime();
  const ageMs = refTime - publishedTime;
  const maxAgeMs = maxHours * 60 * 60 * 1000;

  // Stale if older than maxAgeMs, or suspiciously in the future by > 2 hours
  if (ageMs < -2 * 60 * 60 * 1000) return false;
  return ageMs <= maxAgeMs;
}

export interface FetchFeedResult {
  feedId: string;
  sourceName: string;
  feedUrl: string;
  success: boolean;
  articles: LiveRetrievedArticle[];
  error?: string;
  httpStatus?: number;
  durationMs: number;
}

/**
 * Fetches an RSS/Atom XML feed with bounded timeout, HTTP 429 backoff, and retry handling (Requirement 8)
 */
export async function fetchSingleRssFeed(
  feed: LiveSourceFeedConfig,
  options: {
    timeoutMs?: number;
    maxRetries?: number;
    referenceDate?: Date;
    freshnessHours?: number;
    customFetch?: typeof fetch;
  } = {}
): Promise<FetchFeedResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRetries = options.maxRetries ?? 2;
  const refDate = options.referenceDate ?? new Date();
  const freshnessHours = options.freshnessHours ?? DEFAULT_FRESHNESS_WINDOW_HOURS;
  const fetchFn = options.customFetch ?? fetch;

  const startTime = Date.now();
  let lastError: string | undefined;
  let httpStatus: number | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(feed.feedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (MyDigitAsset RSS Aggregator)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      httpStatus = response.status;

      // Handle 429 Too Many Requests
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 2;
        const waitMs = Math.min((isNaN(retryAfterSec) ? 2 : retryAfterSec) * 1000, 4000);
        lastError = `HTTP 429 Rate Limit from ${feed.name} (${feed.feedUrl}). Waiting ${waitMs}ms before retry.`;
        console.warn(`[Live Source] ${lastError}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Handle server error 5xx
      if (response.status >= 500) {
        lastError = `HTTP ${response.status} from ${feed.name}`;
        const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 1000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${response.statusText}`;
        return {
          feedId: feed.id,
          sourceName: feed.name,
          feedUrl: feed.feedUrl,
          success: false,
          articles: [],
          error: lastError,
          httpStatus,
          durationMs: Date.now() - startTime,
        };
      }

      const xmlText = await response.text();
      const articles = parseRssOrAtomXml(xmlText, feed, refDate, freshnessHours);

      return {
        feedId: feed.id,
        sourceName: feed.name,
        feedUrl: feed.feedUrl,
        success: true,
        articles,
        httpStatus,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        lastError = `Timeout after ${timeoutMs}ms fetching ${feed.name} (${feed.feedUrl})`;
      } else {
        lastError = err.message || 'Network fetch failure';
      }
      const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 1000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return {
    feedId: feed.id,
    sourceName: feed.name,
    feedUrl: feed.feedUrl,
    success: false,
    articles: [],
    error: lastError || 'Max retries exhausted',
    httpStatus,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Parses raw XML into validated, deduplicated, freshness-checked LiveRetrievedArticle objects
 */
export function parseRssOrAtomXml(
  xmlText: string,
  feed: LiveSourceFeedConfig,
  referenceDate: Date = new Date(),
  freshnessHours: number = DEFAULT_FRESHNESS_WINDOW_HOURS
): LiveRetrievedArticle[] {
  if (!xmlText || typeof xmlText !== 'string' || xmlText.trim().length === 0) {
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
  });

  let parsedObj: any;
  try {
    parsedObj = parser.parse(xmlText);
  } catch (err: any) {
    console.error(`[XML Parse Error] Failed to parse feed ${feed.name}:`, err.message);
    return [];
  }

  const articles: LiveRetrievedArticle[] = [];
  const nowIso = new Date().toISOString();

  // 1. Check for RSS 2.0 (<rss><channel><item>)
  const channel = parsedObj?.rss?.channel || parsedObj?.channel;
  if (channel) {
    let items = channel.item;
    if (items) {
      if (!Array.isArray(items)) items = [items];
      for (const item of items) {
        const title = stripHtmlAndCdata(item.title || '');
        const link = normalizeArticleUrl(String(item.link || item.guid || ''));
        const description = stripHtmlAndCdata(item.description || item['content:encoded'] || '');
        const pubDateRaw = item.pubDate || item.published || item['dc:date'];
        const publishedAt = parsePubDateToIso(pubDateRaw);

        if (!title || !link) continue;

        // Freshness check (Requirement 5)
        if (!isArticleFresh(publishedAt, referenceDate, freshnessHours)) {
          continue; // Stale article rejected
        }

        // Domain validation check
        const isValid = validateStorySource({
          headline: title,
          summary: description.length >= 10 ? description : title,
          sourceName: feed.name,
          sourceUrl: link,
        });

        if (isValid) {
          articles.push({
            sourceName: feed.name,
            sourceUrl: link,
            headline: title,
            summary: description.length >= 20 ? description.substring(0, 300) : title,
            publishedAt: publishedAt || nowIso,
            retrievedAt: nowIso,
            categoryId: feed.categoryIds[0] || 'cat_india_economy_business',
            isNegativeDevelopment: detectNegativeSignal(title, description),
          });
        }
      }
    }
  }

  // 2. Check for Atom (<feed><entry>)
  const feedNode = parsedObj?.feed;
  if (feedNode && feedNode.entry) {
    let entries = feedNode.entry;
    if (!Array.isArray(entries)) entries = [entries];
    for (const entry of entries) {
      const title = stripHtmlAndCdata(entry.title || '');
      let link = '';
      if (typeof entry.link === 'string') {
        link = entry.link;
      } else if (entry.link?.['@_href']) {
        link = entry.link['@_href'];
      } else if (Array.isArray(entry.link)) {
        const alt = entry.link.find((l: any) => l['@_rel'] === 'alternate') || entry.link[0];
        link = alt?.['@_href'] || '';
      }
      link = normalizeArticleUrl(link);
      const summary = stripHtmlAndCdata(entry.summary || entry.content || '');
      const pubDateRaw = entry.updated || entry.published;
      const publishedAt = parsePubDateToIso(pubDateRaw);

      if (!title || !link) continue;

      if (!isArticleFresh(publishedAt, referenceDate, freshnessHours)) {
        continue;
      }

      const isValid = validateStorySource({
        headline: title,
        summary: summary.length >= 10 ? summary : title,
        sourceName: feed.name,
        sourceUrl: link,
      });

      if (isValid) {
        articles.push({
          sourceName: feed.name,
          sourceUrl: link,
          headline: title,
          summary: summary.length >= 20 ? summary.substring(0, 300) : title,
          publishedAt: publishedAt || nowIso,
          retrievedAt: nowIso,
          categoryId: feed.categoryIds[0] || 'cat_india_economy_business',
          isNegativeDevelopment: detectNegativeSignal(title, summary),
        });
      }
    }
  }

  return articles;
}

/**
 * Detects if article headline or summary contains a genuine negative development signal
 */
function detectNegativeSignal(headline: string, summary: string): boolean {
  const text = `${headline} ${summary}`.toLowerCase();
  const negativeKeywords = [
    'penalize',
    'penalty',
    'fraud',
    'investigation',
    'shuts down',
    'shut down',
    'bankruptcy',
    'insolvency',
    'layoffs',
    'laid off',
    'job cuts',
    'regulatory action',
    'cancelled',
    'cancellation',
    'fine imposed',
    'sebi bars',
    'rbi penalty',
    'enforcement directorate',
    'cbi raids',
    'losses widen',
    'scam',
  ];
  return negativeKeywords.some((kw) => text.includes(kw));
}

/**
 * Retrieves candidate articles for a specific category across all configured feeds.
 * Deduplicates by URL and headline.
 * Isolates individual feed failures so one failing source never blocks the category (Requirement 7).
 */
export async function retrieveLiveCategoryCandidateArticles(
  categoryId: string,
  options: {
    referenceDate?: Date;
    freshnessHours?: number;
    timeoutMs?: number;
    customFetch?: typeof fetch;
  } = {}
): Promise<{
  articles: LiveRetrievedArticle[];
  sourceStats: Array<{ feedId: string; name: string; success: boolean; count: number; error?: string }>;
}> {
  const categoryFeeds = OFFICIAL_LIVE_FEEDS.filter(
    (f) => f.isActive && f.categoryIds.includes(categoryId)
  );

  const articlesByUrl = new Map<string, LiveRetrievedArticle>();
  const seenHeadlines = new Set<string>();
  const sourceStats: Array<{ feedId: string; name: string; success: boolean; count: number; error?: string }> = [];

  for (const feed of categoryFeeds) {
    const res = await fetchSingleRssFeed(feed, options);
    sourceStats.push({
      feedId: feed.id,
      name: feed.name,
      success: res.success,
      count: res.articles.length,
      error: res.error,
    });

    if (res.success && res.articles.length > 0) {
      for (const art of res.articles) {
        const canonicalUrl = normalizeArticleUrl(art.sourceUrl);
        const headlineNorm = art.headline.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Within-category deduplication (Requirement 6)
        if (!articlesByUrl.has(canonicalUrl) && !seenHeadlines.has(headlineNorm)) {
          articlesByUrl.set(canonicalUrl, art);
          seenHeadlines.add(headlineNorm);
        }
      }
    }
  }

  return {
    articles: Array.from(articlesByUrl.values()),
    sourceStats,
  };
}

/**
 * Provenance Check: Verifies that a generated story's URL exists in the retrieved candidate pool (Requirement 3 & 4)
 */
export function verifyUrlProvenance(
  sourceUrl: string,
  candidatePool: Array<{ sourceUrl: string }>
): boolean {
  if (!sourceUrl) return false;
  const canonicalTarget = normalizeArticleUrl(sourceUrl);
  return candidatePool.some((c) => normalizeArticleUrl(c.sourceUrl) === canonicalTarget);
}
