import { GoogleGenAI } from '@google/genai';
import { NewsStory } from '../src/types.js';
import { getDb } from './db.js';
import { normalizeArticleUrl } from './liveSourceIngestion.js';
import { RawCollectedArticle } from './newsService.js';

/**
 * ============================================================================
 * MYDIGITASSET 7-DAY NEWS DEDUPLICATION ENGINE
 * ============================================================================
 * Prevents delivery of substantially duplicate news when the same underlying
 * event or transaction was already delivered within the previous 7 days.
 *
 * Key Principles:
 * 1. Event-based: Evaluates the underlying story/event, not just headlines or URLs.
 * 2. Cross-publication: Identifies the same event across Reuters, ET, Mint, Bloomberg, etc.
 * 3. Specificity: Distinguishes between different events involving the same company
 *    (e.g., "$500M fundraise" vs "appoints new CEO" are recognized as different events).
 * 4. Strict 7-Day Window: Comparisons apply strictly to [targetDate - 7 days, targetDate - 1 day].
 *    Stories older than 7 days are permitted.
 * 5. Category-Specific: Respects category isolation.
 * 6. Minimum 10 New Stories: Removes duplicates from candidate pools and continues
 *    evaluating subsequent candidates to reach at least 10 eligible stories when available.
 * 7. Zero Hallucination: Delivers available valid stories only when fewer than 10 exist.
 * ============================================================================
 */

export interface DeduplicationMatchResult {
  isDuplicate: boolean;
  reason: string;
  confidence: number;
  matchedStoryId?: string;
  matchedHeadline?: string;
  matchedDate?: string;
}

export interface CandidateDeduplicationSummary {
  eligible: RawCollectedArticle[];
  duplicates: Array<{
    candidate: RawCollectedArticle;
    matchedWith: string;
    matchedDate?: string;
    reason: string;
    confidence: number;
  }>;
  totalConsidered: number;
  duplicatesRemoved: number;
  eligibleRemaining: number;
}

// Common English stopwords to ignore in semantic text comparison
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any',
  'are', 'arent', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'cant', 'cannot', 'could', 'couldnt', 'did', 'didnt',
  'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'isnt', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should',
  'shouldnt', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'until', 'up', 'very', 'was', 'wasnt', 'we', 'were', 'werent', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'wont', 'would',
  'wouldnt', 'you', 'your', 'yours', 'yourself', 'yourselves', 'also', 'says', 'said',
  'amid', 'per', 'via', 'new', 'first', 'today', 'daily', 'report', 'reports', 'news'
]);

// High-confidence business entity aliases
const ENTITY_ALIASES: Record<string, string> = {
  'reserve bank of india': 'rbi',
  'reserve bank': 'rbi',
  'peak xv partners': 'peak xv',
  'peak xv': 'peak xv',
  'reliance retail': 'reliance',
  'reliance industries': 'reliance',
  'hindustan unilever': 'hul',
  'state bank of india': 'sbi',
  'state bank': 'sbi',
  'tata consultancy services': 'tcs',
  'metro cash & carry': 'metro ag',
  'metro cash and carry': 'metro ag',
  'disney star': 'disney',
  'qualcomm ventures': 'qualcomm',
};

// Event action synonym classes
const ACTION_CLASSES: Record<string, string[]> = {
  FUNDING: [
    'raises', 'raising', 'raised', 'funding', 'fundraise', 'fundraising', 'secures',
    'secured', 'securing', 'seed fund', 'series a', 'series b', 'series c', 'series d',
    'closes fund', 'venture fund', 'capital round', 'investment', 'invests', 'invested',
    'valuation', 'infusion', 'capital raise', 'equity round'
  ],
  LEADERSHIP: [
    'appoints', 'appointed', 'appointing', 'names', 'named', 'ceo', 'chief executive',
    'managing director', 'md', 'cfo', 'coo', 'cto', 'resigns', 'resigned', 'steps down',
    'stepped down', 'steps aside', 'quits', 'elevation', 'elevates', 'elevated',
    'hires', 'hired', 'leadership'
  ],
  EARNINGS: [
    'ebitda', 'profitability', 'profitable', 'profit', 'profits', 'revenue', 'revenues',
    'quarterly', 'earnings', 'loss', 'losses', 'margins', 'q1', 'q2', 'q3', 'q4',
    'financial results', 'net profit', 'turnaround'
  ],
  ACQUISITION: [
    'acquire', 'acquires', 'acquired', 'acquisition', 'buy', 'buys', 'bought', 'buying',
    'buyout', 'takeover', 'merger', 'stake', 'majority stake', 'deal to buy', 'purchases'
  ],
  REGULATION: [
    'penalty', 'penalize', 'penalizes', 'penalized', 'fine', 'fines', 'fined', 'bars',
    'barred', 'ban', 'banned', 'regulatory action', 'dark pattern', 'ed raids', 'cbi',
    'probe', 'investigation', 'scrutiny', 'notices', 'show cause', 'sebi', 'rbi penalty'
  ],
  POLICY_MACRO: [
    'repo rate', 'policy rate', 'interest rate', 'mpc', 'monetary policy', 'inflation',
    'cpi', 'gdp', 'gst collection', 'forex reserves', 'pmi', 'sovereign rating',
    'trade deficit', 'current account deficit'
  ],
  CONTRACT_ORDER: [
    'order', 'orders', 'contract', 'supply order', 'bags order', 'wins order', 'agreement',
    'pact', 'mou', 'tender', 'turbines supply'
  ],
  EXPANSION_LAUNCH: [
    'launches', 'launch', 'launched', 'unveils', 'unveiled', 'inaugurates', 'expands',
    'expansion', 'opens', 'rollout', 'enters market', 'dark stores'
  ],
};

// Generic geographic, industry, currency, or metric acronyms that should NOT be used alone as distinct corporate entities
export const GENERIC_ENTITIES = new Set([
  'india', 'indian', 'indias', 'south india', 'north india', 'delhi', 'mumbai', 'bengaluru', 'bangalore',
  'hyderabad', 'chennai', 'pune', 'gurugram', 'noida', 'rajasthan', 'gujarat', 'maharashtra',
  'karnataka', 'kerala', 'tamil nadu', 'asia', 'south asia', 'global', 'domestic', 'national',
  'startup', 'startups', 'company', 'companies', 'enterprise', 'enterprises', 'firm', 'firms',
  'bank', 'banks', 'lender', 'lenders', 'government', 'centre', 'state', 'regulator', 'regulators',
  'sector', 'industry', 'market', 'markets', 'platform', 'platforms',
  'sme', 'inr', 'rs', 'usd', 'gdp', 'cpi', 'gst', 'fmcg', 'b2b', 'ai', 'ipo', 'drhp', 'ebitda',
  'q1', 'q2', 'q3', 'q4', 'cr', 'crore', 'lakh', 'million', 'billion', 'mw'
]);

/**
 * Normalizes text: lowercases, removes punctuation, trims whitespace
 */
export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s$%.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes headline for exact/near-exact identity comparison
 */
export function normalizeHeadline(headline: string): string {
  return (headline || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Tokenizes text into meaningful content words (stripping stopwords and short tokens)
 */
export function tokenizeContent(text: string): Set<string> {
  const norm = normalizeText(text);
  const rawWords = norm.split(' ');
  const tokens = new Set<string>();
  for (const w of rawWords) {
    const clean = w.trim();
    if (clean.length > 2 && !STOPWORDS.has(clean)) {
      tokens.add(clean);
    }
  }
  return tokens;
}

/**
 * Extracts named entities and corporate subjects from headline & summary
 */
export function extractEntities(headline: string, summary: string): Set<string> {
  const combined = `${headline} ${summary}`;
  const entities = new Set<string>();

  // Extract multi-word or single-word capitalized names (e.g. "Peak XV Partners", "Zepto", "Company X")
  const capitalizedRegex = /\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*\b/g;
  let match;
  while ((match = capitalizedRegex.exec(combined)) !== null) {
    const ent = match[0].trim().toLowerCase();
    if (ent.length > 1 && !STOPWORDS.has(ent)) {
      const alias = ENTITY_ALIASES[ent] || ent;
      entities.add(alias);
    }
  }

  // Check known acronyms and multi-word aliases with word boundaries
  for (const [rawAlias, canonical] of Object.entries(ENTITY_ALIASES)) {
    const escaped = rawAlias.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (regex.test(combined)) {
      entities.add(canonical);
    }
  }

  return entities;
}

/**
 * Extracts numeric metrics, monetary values, and percentages
 */
export function extractMetrics(headline: string, summary: string): Set<string> {
  const combined = `${headline} ${summary}`.toLowerCase();
  const metrics = new Set<string>();

  // US Dollar amounts (e.g., $500M, $1.2B, $65 million, 500 million)
  const usdRegex = /(?:\$|usd\s*)(\d+(?:\.\d+)?)\s*(b(?:illion)?|m(?:illion)?|k)?/gi;
  let usdMatch;
  while ((usdMatch = usdRegex.exec(combined)) !== null) {
    const val = usdMatch[1];
    const unit = (usdMatch[2] || '').toLowerCase().startsWith('b') ? 'b' : 'm';
    metrics.add(`${val}${unit}_usd`);
  }

  // Bare million / billion mentions with numbers (e.g. "500m", "500 million", "1.2 billion")
  const bareNumRegex = /\b(\d+(?:\.\d+)?)\s*(million|billion)\b/gi;
  let bareMatch;
  while ((bareMatch = bareNumRegex.exec(combined)) !== null) {
    const val = bareMatch[1];
    const unit = bareMatch[2].toLowerCase().startsWith('b') ? 'b' : 'm';
    metrics.add(`${val}${unit}_usd`);
  }

  // INR amounts (e.g. Rs 2,850 cr, INR 1.94 lakh crore, 3,800 crore)
  const inrRegex = /(?:inr|rs\.?|₹)?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(lakh\s*crore|crore|cr|lakh)/gi;
  let inrMatch;
  while ((inrMatch = inrRegex.exec(combined)) !== null) {
    const val = inrMatch[1].replace(/,/g, '');
    const unit = inrMatch[2].toLowerCase().replace(/\s+/g, '');
    metrics.add(`${val}_${unit}_inr`);
  }

  // Percentages (e.g. 6.5%, 7.2%, 16.5%)
  const pctRegex = /\b(\d+(?:\.\d+)?)\s*%/g;
  let pctMatch;
  while ((pctMatch = pctRegex.exec(combined)) !== null) {
    metrics.add(`${pctMatch[1]}pct`);
  }

  // Physical units (e.g. 380 MW, 450 MW)
  const mwRegex = /\b(\d+)\s*mw\b/gi;
  let mwMatch;
  while ((mwMatch = mwRegex.exec(combined)) !== null) {
    metrics.add(`${mwMatch[1]}mw`);
  }

  return metrics;
}

/**
 * Classifies the semantic event actions in the story with strict word boundaries
 */
export function extractActionClasses(headline: string, summary: string): Set<string> {
  const norm = `${headline} ${summary}`.toLowerCase();
  const matchedActions = new Set<string>();

  for (const [actionClass, keywords] of Object.entries(ACTION_CLASSES)) {
    for (const kw of keywords) {
      const escaped = kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
      if (regex.test(norm)) {
        matchedActions.add(actionClass);
        break;
      }
    }
  }

  return matchedActions;
}

/**
 * Calculates day difference between two YYYY-MM-DD dates in UTC
 * Returns targetDate - historicalDate in whole days.
 */
export function calculateDateDiffDays(targetDateStr: string, historicalDateStr: string): number {
  const parseToUtc = (dStr: string) => {
    // Only accept strictly valid YYYY-MM-DD date prefixes
    const cleanDate = (dStr || '').split('_')[0].trim();
    const parts = cleanDate.split('-');
    if (parts.length !== 3) return NaN;
    const [y, m, d] = parts.map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
    if (m < 1 || m > 12 || d < 1 || d > 31) return NaN;
    return Date.UTC(y, m - 1, d);
  };
  try {
    const targetUtc = parseToUtc(targetDateStr);
    const histUtc = parseToUtc(historicalDateStr);
    if (!Number.isFinite(targetUtc) || !Number.isFinite(histUtc)) {
      return NaN;
    }
    return Math.round((targetUtc - histUtc) / (24 * 3600 * 1000));
  } catch {
    return NaN;
  }
}

/**
 * Retrieves all stories delivered for a category within the previous 7 days:
 * Strictly: 1 <= (targetDate - storyDate) <= windowDays (default: 7)
 * Stories older than 7 days (diff > 7) or on the same date (diff <= 0) are excluded.
 */
export function getHistoricalDeliveredStories(
  categoryId: string,
  targetNewsDate: string,
  windowDays: number = 7
): NewsStory[] {
  const db = getDb();
  if (!db || !Array.isArray(db.newsStories)) {
    return [];
  }

  return db.newsStories.filter((s) => {
    if (s.categoryId !== categoryId) return false;
    if (!s.newsDate) return false;

    const diffDays = calculateDateDiffDays(targetNewsDate, s.newsDate);
    // Comparison window is strictly the previous 7 days (1 to 7 days inclusive)
    if (!Number.isFinite(diffDays) || diffDays < 1 || diffDays > windowDays) {
      return false;
    }

    // Only include stories from successful or partial packages
    const pkg = db.dailyNewsPackages.find((p) => p.packageId === s.packageId);
    if (pkg && pkg.generationStatus !== 'success' && pkg.generationStatus !== 'partial') {
      return false;
    }

    return true;
  });
}

/**
 * Evaluates whether two stories describe the exact same underlying event/transaction.
 *
 * Rules:
 * - Exact canonical URL match -> DUPLICATE
 * - Near-identical headline match -> DUPLICATE
 * - Same primary entity + same metric + matching action class -> DUPLICATE (across publications)
 * - Same primary entity + DIFFERENT action classes & zero shared metrics -> NOT DUPLICATE (e.g. raises $500M vs appoints CEO)
 * - Multiple shared entities + matching action class -> DUPLICATE
 * - High token overlap of salient concepts -> DUPLICATE
 */
export function isSameUnderlyingEvent(
  storyA: { headline: string; summary: string; sourceUrl?: string; sourceName?: string },
  storyB: { headline: string; summary: string; sourceUrl?: string; sourceName?: string }
): DeduplicationMatchResult {
  // 1. Exact canonical URL matching (fast path)
  if (storyA.sourceUrl && storyB.sourceUrl) {
    const canonA = normalizeArticleUrl(storyA.sourceUrl);
    const canonB = normalizeArticleUrl(storyB.sourceUrl);
    if (canonA === canonB) {
      return {
        isDuplicate: true,
        reason: 'exact_canonical_url_match',
        confidence: 1.0,
      };
    }
  }

  // 2. Exact or near-identical headline matching (fast path)
  const normHeadA = normalizeHeadline(storyA.headline);
  const normHeadB = normalizeHeadline(storyB.headline);
  if (normHeadA && normHeadA === normHeadB) {
    return {
      isDuplicate: true,
      reason: 'exact_normalized_headline_match',
      confidence: 1.0,
    };
  }

  // 3. Entity, metric, and action extraction
  const entitiesA = extractEntities(storyA.headline, storyA.summary);
  const entitiesB = extractEntities(storyB.headline, storyB.summary);
  // Separate specific corporate/brand entities from generic country or industry terms
  const specificEntitiesA = new Set([...entitiesA].filter((e) => !GENERIC_ENTITIES.has(e)));
  const specificEntitiesB = new Set([...entitiesB].filter((e) => !GENERIC_ENTITIES.has(e)));
  const sharedSpecificEntities = new Set([...specificEntitiesA].filter((e) => specificEntitiesB.has(e)));

  const metricsA = extractMetrics(storyA.headline, storyA.summary);
  const metricsB = extractMetrics(storyB.headline, storyB.summary);
  const sharedMetrics = new Set([...metricsA].filter((m) => metricsB.has(m)));

  const actionsA = extractActionClasses(storyA.headline, storyA.summary);
  const actionsB = extractActionClasses(storyB.headline, storyB.summary);
  const sharedActions = new Set([...actionsA].filter((a) => actionsB.has(a)));

  // If both mention the same specific corporate entity:
  if (sharedSpecificEntities.size > 0) {
    // Sub-case A: Shared specific entity + shared metric + matching action
    // E.g. "Company X raises $500M" vs "Company X secures $500M funding"
    if (sharedMetrics.size > 0 && sharedActions.size > 0) {
      return {
        isDuplicate: true,
        reason: 'same_entity_metric_and_action',
        confidence: 0.98,
      };
    }

    // Sub-case B: Shared specific entity + shared metric (high financial fingerprint match)
    if (sharedMetrics.size > 0) {
      return {
        isDuplicate: true,
        reason: 'same_entity_and_financial_metric',
        confidence: 0.95,
      };
    }

    // Sub-case C: Disjoint event actions and zero shared metrics
    // E.g. "Company X raises $500M" vs "Company X appoints a new CEO"
    const hasDisjointActions = actionsA.size > 0 && actionsB.size > 0 && sharedActions.size === 0;
    if (hasDisjointActions && sharedMetrics.size === 0) {
      return {
        isDuplicate: false,
        reason: 'same_company_different_event_actions',
        confidence: 0.05,
      };
    }

    // Sub-case D: Zero shared metrics and zero shared actions: different events unless high token overlap
    if (sharedMetrics.size === 0 && sharedActions.size === 0) {
      const tokensA = tokenizeContent(`${storyA.headline} ${storyA.summary}`);
      const tokensB = tokenizeContent(`${storyB.headline} ${storyB.summary}`);
      const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
      const minSize = Math.min(tokensA.size, tokensB.size);
      const overlapRatio = minSize > 0 ? intersection.size / minSize : 0;
      if (overlapRatio < 0.60) {
        return {
          isDuplicate: false,
          reason: 'same_company_different_unrelated_event',
          confidence: 0.1,
        };
      }
    }

    // Sub-case E: Multiple shared specific entities + matching action class
    // E.g. "Reliance Retail to acquire Metro Cash & Carry" vs "Reliance signs deal to buy wholesale firm Metro Cash & Carry"
    if (sharedSpecificEntities.size >= 2 && sharedActions.size > 0) {
      return {
        isDuplicate: true,
        reason: 'multiple_shared_entities_matching_action',
        confidence: 0.92,
      };
    }

    // Sub-case F: High content token overlap with shared specific entity
    const tokensA = tokenizeContent(`${storyA.headline} ${storyA.summary}`);
    const tokensB = tokenizeContent(`${storyB.headline} ${storyB.summary}`);
    const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
    const minSize = Math.min(tokensA.size, tokensB.size);
    const overlapRatio = minSize > 0 ? intersection.size / minSize : 0;

    if (overlapRatio >= 0.55 && sharedActions.size > 0) {
      return {
        isDuplicate: true,
        reason: 'shared_entity_action_and_high_token_overlap',
        confidence: 0.90,
      };
    }
  }

  // 3.5 Disjoint corporate entities rule:
  // If both stories identify specific corporate entities, but have zero shared corporate entities:
  // (e.g. State Bank of India vs HDFC Bank, or Tata Power vs Adani Green)
  // They are distinct events happening to different companies and must not be deduplicated!
  if (specificEntitiesA.size > 0 && specificEntitiesB.size > 0 && sharedSpecificEntities.size === 0) {
    return {
      isDuplicate: false,
      reason: 'different_corporate_entities',
      confidence: 0.0,
    };
  }

  // 4. Macro policy / industry event matching without specific corporate entity
  // E.g. "RBI holds repo rate at 6.5%" vs "Reserve Bank keeps benchmark rate at 6.5%"
  if (sharedActions.has('POLICY_MACRO') && sharedMetrics.size > 0) {
    return {
      isDuplicate: true,
      reason: 'macro_policy_event_match',
      confidence: 0.95,
    };
  }

  // 5. General token overlap of headline & summary
  const tokensA = tokenizeContent(storyA.headline);
  const tokensB = tokenizeContent(storyB.headline);
  const sharedHeadlineTokens = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const minHeadSize = Math.min(tokensA.size, tokensB.size);
  const headlineRatio = minHeadSize > 0 ? sharedHeadlineTokens.size / minHeadSize : 0;

  if (headlineRatio >= 0.70) {
    return {
      isDuplicate: true,
      reason: 'headline_semantic_token_overlap_high',
      confidence: 0.88,
    };
  }

  return {
    isDuplicate: false,
    reason: 'distinct_underlying_events',
    confidence: 0.0,
  };
}

/**
 * Optional Gemini semantic verification for ambiguous borderline cases.
 * Strictly bounded with a short timeout and structured JSON response validation.
 */
export async function verifyWithGeminiIfAmbiguous(
  candidate: RawCollectedArticle,
  historicalStory: NewsStory
): Promise<DeduplicationMatchResult | null> {
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
  if (!geminiApiKey) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const prompt = `Compare these two business news stories:

Story 1 (Delivered previously on ${historicalStory.newsDate}):
Headline: ${historicalStory.headline}
Summary: ${historicalStory.summary}

Story 2 (Candidate for today):
Headline: ${candidate.title}
Summary: ${candidate.summary}

QUESTION:
Do Story 1 and Story 2 describe the exact same underlying event, transaction, announcement, or development (even if reported by different publications or phrased with different headlines)?
Note: Two different events involving the same company (e.g. a funding round vs an executive appointment) are NOT the same event.

Respond ONLY with a JSON object:
{
  "isSameUnderlyingEvent": boolean,
  "confidence": number (0.0 to 1.0),
  "reason": "brief explanation"
}`;

    const apiPromise = ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini dedup timeout')), 2500)
    );

    const response = await Promise.race([apiPromise, timeoutPromise]);
    const parsed = JSON.parse(response.text || '{}');

    if (typeof parsed.isSameUnderlyingEvent === 'boolean') {
      return {
        isDuplicate: parsed.isSameUnderlyingEvent,
        reason: `gemini_adjudication: ${parsed.reason || 'semantic comparison'}`,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.9,
      };
    }
  } catch (err: any) {
    // Non-blocking fallback to deterministic engine
  }

  return null;
}

/**
 * Filters raw candidate articles against:
 * 1. Historical stories delivered in the category during the previous 7 days
 * 2. Intra-day duplicate candidates covering the same event within today's pool
 *
 * Continues considering additional eligible candidates until at least 10 genuinely
 * new stories are available (or delivers whatever valid stories are genuinely available).
 */
export function filterEligibleCandidateArticles(
  candidates: RawCollectedArticle[],
  historicalStories: NewsStory[]
): CandidateDeduplicationSummary {
  const eligible: RawCollectedArticle[] = [];
  const duplicates: CandidateDeduplicationSummary['duplicates'] = [];

  for (const candidate of candidates) {
    let isDup = false;
    let dupDetails: DeduplicationMatchResult | null = null;
    let matchedHistorical: NewsStory | undefined;
    let matchedIntraDay: RawCollectedArticle | undefined;

    // Check 1: 7-day historical deduplication check
    for (const hist of historicalStories) {
      const match = isSameUnderlyingEvent(
        {
          headline: candidate.title,
          summary: candidate.summary,
          sourceUrl: candidate.sourceUrl,
          sourceName: candidate.sourceName,
        },
        {
          headline: hist.headline,
          summary: hist.summary,
          sourceUrl: hist.sourceUrl,
          sourceName: hist.sourceName,
        }
      );

      if (match.isDuplicate) {
        isDup = true;
        dupDetails = match;
        matchedHistorical = hist;
        break;
      }
    }

    // Check 2: Intra-day candidate deduplication (consolidate multi-source coverage of same event today)
    if (!isDup) {
      for (const accepted of eligible) {
        const match = isSameUnderlyingEvent(
          {
            headline: candidate.title,
            summary: candidate.summary,
            sourceUrl: candidate.sourceUrl,
            sourceName: candidate.sourceName,
          },
          {
            headline: accepted.title,
            summary: accepted.summary,
            sourceUrl: accepted.sourceUrl,
            sourceName: accepted.sourceName,
          }
        );

        if (match.isDuplicate) {
          isDup = true;
          dupDetails = match;
          matchedIntraDay = accepted;
          break;
        }
      }
    }

    if (isDup && dupDetails) {
      duplicates.push({
        candidate,
        matchedWith: matchedHistorical?.headline || matchedIntraDay?.title || 'Prior story',
        matchedDate: matchedHistorical?.newsDate,
        reason: dupDetails.reason,
        confidence: dupDetails.confidence,
      });
    } else {
      eligible.push(candidate);
    }
  }

  return {
    eligible,
    duplicates,
    totalConsidered: candidates.length,
    duplicatesRemoved: duplicates.length,
    eligibleRemaining: eligible.length,
  };
}
