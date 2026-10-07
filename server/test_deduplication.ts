import crypto from 'crypto';
import { initDb, getDb, registerOrLoginCustomer } from './db.js';
import { processVerifiedPayment } from './paymentService.js';
import { generateTelegramConnectionToken, connectTelegramAccount } from './telegramService.js';
import {
  generateCategoryDailyNews,
  RawCollectedArticle,
} from './newsService.js';
import {
  isSameUnderlyingEvent,
  getHistoricalDeliveredStories,
  filterEligibleCandidateArticles,
  calculateDateDiffDays,
} from './deduplicationService.js';
import { deliverCategoryNewsToCustomer } from './deliveryService.js';
import { DailyNewsPackage, NewsStory } from '../src/types.js';

let passed = 0;
let failed = 0;

function assertTest(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    if (detail) console.log(`     └─ ${detail}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    if (detail) console.error(`     └─ ERROR: ${detail}`);
    failed++;
  }
}

export async function runDeduplicationTests() {
  console.log('\n======================================================================');
  console.log('MYDIGITASSET 7-DAY NEWS DEDUPLICATION TEST SUITE');
  console.log('======================================================================\n');

  // Ensure deterministic fast test execution
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    initDb();
    const db = getDb();

    // --------------------------------------------------------------------------
    // TEST 1: Same Story + Same Headline -> Blocked
    // --------------------------------------------------------------------------
    console.log('--- TEST 1: Same Story + Same Headline -> Blocked ---');
    const story1A = {
      headline: 'Company X raises $500M in India from international investors',
      summary: 'Fintech unicorn Company X announced a $500 million equity funding round.',
      sourceName: 'Reuters',
      sourceUrl: 'https://economictimes.indiatimes.com/tech/startups/company-x-raises-500m',
    };
    const story1B = {
      headline: 'Company X raises $500M in India from international investors',
      summary: 'Fintech unicorn Company X announced a $500 million equity funding round.',
      sourceName: 'Reuters',
      sourceUrl: 'https://economictimes.indiatimes.com/tech/startups/company-x-raises-500m',
    };
    const res1 = isSameUnderlyingEvent(story1A, story1B);
    assertTest(
      res1.isDuplicate === true,
      '1. Same story with same headline and URL is identified as duplicate',
      `Reason: ${res1.reason}, Confidence: ${res1.confidence}`
    );

    // --------------------------------------------------------------------------
    // TEST 2: Same Underlying Story + Different Headline -> Blocked
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 2: Same Underlying Story + Different Headline -> Blocked ---');
    const story2A = {
      headline: 'Company X raises $500M in India',
      summary: 'Venture-backed unicorn Company X announced a landmark $500M primary capital round.',
      sourceName: 'Reuters',
      sourceUrl: 'https://economictimes.indiatimes.com/company-x-reuters',
    };
    const story2B = {
      headline: 'Company X secures $500M funding',
      summary: 'Company X has successfully secured $500 million in growth equity funding.',
      sourceName: 'The Economic Times',
      sourceUrl: 'https://economictimes.indiatimes.com/company-x-et',
    };
    const res2 = isSameUnderlyingEvent(story2A, story2B);
    assertTest(
      res2.isDuplicate === true,
      '2. Same underlying story with different headlines is identified as duplicate',
      `Reason: ${res2.reason}, Confidence: ${res2.confidence}`
    );

    // --------------------------------------------------------------------------
    // TEST 3: Same Underlying Story + Different Publication -> Blocked
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 3: Same Underlying Story + Different Publication -> Blocked ---');
    const story3A = {
      headline: 'Company X raises $500M in India',
      summary: 'Company X announced a $500M capital raise today.',
      sourceName: 'Reuters',
      sourceUrl: 'https://economictimes.indiatimes.com/reuters-x',
    };
    const story3B = {
      headline: 'Company X completes $500M fundraise',
      summary: 'Bloomberg reports Company X concluded its $500M funding round.',
      sourceName: 'Mint',
      sourceUrl: 'https://www.livemint.com/bloomberg-x',
    };
    const res3 = isSameUnderlyingEvent(story3A, story3B);
    assertTest(
      res3.isDuplicate === true,
      '3. Same underlying event reported by different publications is identified as duplicate',
      `Reason: ${res3.reason}, Confidence: ${res3.confidence}`
    );

    // --------------------------------------------------------------------------
    // TEST 4: Same Story Older Than 7 Days -> Allowed
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 4: Same Story Older Than 7 Days -> Allowed ---');
    const diffDay8 = calculateDateDiffDays('2026-10-09', '2026-10-01');
    const diffDay7 = calculateDateDiffDays('2026-10-08', '2026-10-01');
    const diffDay1 = calculateDateDiffDays('2026-10-02', '2026-10-01');

    assertTest(
      diffDay8 === 8 && diffDay7 === 7 && diffDay1 === 1,
      '4a. Date difference math correctly calculates day windows',
      `Day 9 vs Day 1: ${diffDay8} days, Day 8 vs Day 1: ${diffDay7} days, Day 2 vs Day 1: ${diffDay1} days`
    );

    // Set up mock historical story in DB for category cat_india_startups on 2026-10-01
    const historicalStoryOld: NewsStory = {
      storyId: 'sty_hist_day1_001',
      packageId: 'pkg_hist_day1_001',
      newsDate: '2026-10-01',
      categoryId: 'cat_india_startups',
      position: 1,
      headline: 'Company X raises $500M in India',
      summary: 'Fintech unicorn Company X announced a $500M round.',
      sourceName: 'The Economic Times',
      sourceUrl: 'https://economictimes.indiatimes.com/company-x-old',
      sentimentType: 'constructive',
      createdAt: '2026-10-01T06:00:00Z',
    };
    const histPkgOld: DailyNewsPackage = {
      packageId: 'pkg_hist_day1_001',
      newsDate: '2026-10-01',
      categoryId: 'cat_india_startups',
      categoryName: 'India Startups',
      generationStatus: 'success',
      storyCount: 1,
      createdAt: '2026-10-01T06:00:00Z',
      updatedAt: '2026-10-01T06:00:00Z',
    };

    db.newsStories = db.newsStories.filter((s) => s.storyId !== 'sty_hist_day1_001');
    db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => p.packageId !== 'pkg_hist_day1_001');
    db.newsStories.push(historicalStoryOld);
    db.dailyNewsPackages.push(histPkgOld);

    // Check historical window on Day 9 (2026-10-09): 8 days later -> must be empty (older than 7 days)
    const windowDay9 = getHistoricalDeliveredStories('cat_india_startups', '2026-10-09', 7);
    // Check historical window on Day 5 (2026-10-05): 4 days later -> must include the story
    const windowDay5 = getHistoricalDeliveredStories('cat_india_startups', '2026-10-05', 7);

    const candidateDay9: RawCollectedArticle = {
      title: 'Company X completes $500M fundraise',
      summary: 'Company X concluded its $500 million fundraise.',
      sourceName: 'Mint',
      sourceUrl: 'https://www.livemint.com/company-x-new',
      publishedAt: '2026-10-09T05:00:00Z',
      categoryHint: 'cat_india_startups',
    };

    const dedupDay9 = filterEligibleCandidateArticles([candidateDay9], windowDay9);
    const dedupDay5 = filterEligibleCandidateArticles([candidateDay9], windowDay5);

    assertTest(
      dedupDay9.eligible.length === 1 && dedupDay5.eligible.length === 0,
      '4b. Story older than 7 days is ALLOWED; story within 7 days is BLOCKED',
      `Day 9 eligible: ${dedupDay9.eligible.length} (allowed), Day 5 eligible: ${dedupDay5.eligible.length} (blocked)`
    );

    // --------------------------------------------------------------------------
    // TEST 5: Different Event Involving Same Company -> Allowed
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 5: Different Event Involving Same Company -> Allowed ---');
    const storyFundraise = {
      headline: 'Company X raises $500M in Series D round',
      summary: 'Fintech unicorn Company X secured $500 million in growth funding.',
      sourceName: 'The Economic Times',
      sourceUrl: 'https://economictimes.indiatimes.com/x-fundraise',
    };
    const storyCeoAppointment = {
      headline: 'Company X appoints a new CEO to lead international expansion',
      summary: 'Company X has appointed Jane Doe as Chief Executive Officer to direct global operations.',
      sourceName: 'Mint',
      sourceUrl: 'https://www.livemint.com/x-ceo',
    };
    const res5 = isSameUnderlyingEvent(storyFundraise, storyCeoAppointment);
    assertTest(
      res5.isDuplicate === false,
      '5. Different event involving the same company is recognized as DISTINCT and ALLOWED',
      `Reason: ${res5.reason}, isDuplicate: ${res5.isDuplicate}`
    );

    // --------------------------------------------------------------------------
    // TEST 6: Duplicate Candidate Removed and Another Eligible Story Selected
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 6: Duplicate Candidate Removed and Another Eligible Story Selected ---');
    // Candidate 0 is a duplicate of Day 1's Company X raise ($500M)
    // Candidates 1 to 10 are completely distinct verified companies and events
    const candidatesTest6: RawCollectedArticle[] = [
      {
        title: 'Company X secures $500M funding in India', // DUPLICATE of Day 1
        summary: 'Company X finalized its $500M funding round.',
        sourceName: 'The Economic Times',
        sourceUrl: 'https://economictimes.indiatimes.com/x-dup-candidate',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Mindgrove Technologies raises $65M Series A for edge AI silicon chips',
        summary: 'Mindgrove announced a major venture round led by global semiconductor investors.',
        sourceName: 'Mint',
        sourceUrl: 'https://www.livemint.com/mindgrove-65m',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Zepto achieves quarterly EBITDA profitability across automated fulfillment centers',
        summary: 'Quick commerce platform Zepto reported positive operating earnings in top cities.',
        sourceName: 'Inc42',
        sourceUrl: 'https://inc42.com/zepto-profitable-q2',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Innovaccer signs $40M health system data contract with private hospital networks',
        summary: 'Innovaccer expanded its healthcare cloud platform across South Asian hospital chains.',
        sourceName: 'The Economic Times',
        sourceUrl: 'https://economictimes.indiatimes.com/innovaccer-40m-contract',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'DeHaat expands digital agriculture marketplace to 2.5 million farmers',
        summary: 'AgriTech leader DeHaat added regional farmer centers for soil testing and crop buybacks.',
        sourceName: 'Financial Express',
        sourceUrl: 'https://www.financialexpress.com/dehaat-expansion-farmers',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Razorpay files Draft Red Herring Prospectus for domestic stock exchange listing',
        summary: 'Payments unicorn Razorpay formally initiated SEBI regulatory filing for initial public offering.',
        sourceName: 'Business Standard',
        sourceUrl: 'https://www.business-standard.com/razorpay-drhp-ipo',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Garuda Aerospace secures INR 280 crore defense border surveillance contract',
        summary: 'Garuda Aerospace closed government contract for surveillance unmanned aerial vehicles.',
        sourceName: 'The Hindu BusinessLine',
        sourceUrl: 'https://www.thehindubusinessline.com/garuda-aerospace-contract',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Udaan reduces operational cash burn by 42% on optimized logistics networks',
        summary: 'B2B platform Udaan reached near cash break-even across warehouse facilities.',
        sourceName: 'Moneycontrol',
        sourceUrl: 'https://www.moneycontrol.com/udaan-burn-reduction',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'String Bio operationalizes commercial alternative protein facility in Hyderabad',
        summary: 'String Bio commissioned methane gas fermentation plant for animal feed proteins.',
        sourceName: 'Mint',
        sourceUrl: 'https://www.livemint.com/string-bio-plant',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Ather Energy secures $120M pre-IPO investment round from sovereign funds',
        summary: 'Electric scooter manufacturer Ather Energy bolstered manufacturing scale ahead of public offering.',
        sourceName: 'The Economic Times',
        sourceUrl: 'https://economictimes.indiatimes.com/ather-energy-funding',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Lenskart completes $200M secondary share transaction valuing eyewear maker at $5B',
        summary: 'Lenskart institutional partners concluded secondary stake purchase to expand omnichannel presence.',
        sourceName: 'Inc42',
        sourceUrl: 'https://inc42.com/lenskart-secondary-sale',
        publishedAt: '2026-10-04T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
    ];

    // Clean any prior package for this test date
    db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === 'cat_india_startups' && p.newsDate === '2026-10-04'));
    db.newsStories = db.newsStories.filter((s) => !(s.categoryId === 'cat_india_startups' && s.newsDate === '2026-10-04'));

    const genTest6 = await generateCategoryDailyNews('cat_india_startups', '2026-10-04', {
      candidatePool: candidatesTest6,
      customHistoricalStories: [historicalStoryOld],
    });

    const dupRemoved = (genTest6.package?.dedupCount || 0) === 1;
    const reached10Stories = genTest6.stories?.length === 10;
    const noCompanyXInStories = !genTest6.stories?.some((s) => s.headline.includes('Company X secures $500M'));

    assertTest(
      genTest6.success && dupRemoved && reached10Stories && noCompanyXInStories,
      '6. Duplicate candidate removed, subsequent candidate selected, package reaches exactly 10 stories',
      `Success: ${genTest6.success}, Deduplicated count: ${genTest6.package?.dedupCount}, Story count: ${genTest6.stories?.length}`
    );

    // --------------------------------------------------------------------------
    // TEST 7: 10 Valid New Stories -> Exactly 10 Selected
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 7: 10 Valid New Stories -> Exactly 10 Selected ---');
    const bankingCompanies = [
      'State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Kotak Mahindra Bank', 'Axis Bank',
      'Punjab National Bank', 'Bank of Baroda', 'IndusInd Bank', 'Federal Bank', 'IDFC First Bank',
      'Yes Bank', 'Bandhan Bank'
    ];
    const candidatesTest7: RawCollectedArticle[] = bankingCompanies.map((comp, i) => ({
      title: `${comp} reports ${10 + i}% growth in quarterly retail deposits`,
      summary: `${comp} expanded its branch network and registered strong customer deposit inflows.`,
      sourceName: 'Business Standard',
      sourceUrl: `https://www.business-standard.com/banking-${i + 1}-results`,
      publishedAt: '2026-10-06T05:00:00Z',
      categoryHint: 'cat_india_banking_fintech',
    }));

    db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === 'cat_india_banking_fintech' && p.newsDate === '2026-10-06'));
    db.newsStories = db.newsStories.filter((s) => !(s.categoryId === 'cat_india_banking_fintech' && s.newsDate === '2026-10-06'));

    const genTest7 = await generateCategoryDailyNews('cat_india_banking_fintech', '2026-10-06', {
      candidatePool: candidatesTest7,
      customHistoricalStories: [],
    });

    assertTest(
      genTest7.success && genTest7.stories?.length === 10 && genTest7.package?.generationStatus === 'success',
      '7. When sufficient candidates exist, exactly 10 stories are selected per category target limit',
      `Stories selected: ${genTest7.stories?.length}, Status: ${genTest7.package?.generationStatus}`
    );

    // --------------------------------------------------------------------------
    // TEST 8: Only 8 Valid New Stories Available -> Exactly 8 Delivered, No Fabrication
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 8: Only 8 Valid New Stories Available -> Exactly 8 Delivered, No Fabrication ---');
    const energyEntities = [
      'Tata Power', 'Adani Green', 'ReNew Energy', 'Suzlon Energy',
      'Azure Power', 'Hero Future Energies', 'NTPC Green', 'Waaree Energies'
    ];
    const candidatesTest8: RawCollectedArticle[] = energyEntities.map((ent, i) => ({
      title: `${ent} commissions ${100 + i * 20} MW clean energy project in regional grid`,
      summary: `${ent} connected its renewable energy project to the national transmission network.`,
      sourceName: 'Mint',
      sourceUrl: `https://www.livemint.com/energy-project-${i + 1}`,
      publishedAt: '2026-10-07T05:00:00Z',
      categoryHint: 'cat_india_energy_renewables',
    }));

    db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === 'cat_india_energy_renewables' && p.newsDate === '2026-10-07'));
    db.newsStories = db.newsStories.filter((s) => !(s.categoryId === 'cat_india_energy_renewables' && s.newsDate === '2026-10-07'));

    const genTest8 = await generateCategoryDailyNews('cat_india_energy_renewables', '2026-10-07', {
      candidatePool: candidatesTest8,
      customHistoricalStories: [],
    });

    assertTest(
      genTest8.success && genTest8.stories?.length === 8 && genTest8.package?.generationStatus === 'partial',
      '8. When only 8 valid candidates exist, exactly 8 stories are delivered without fabricating fake news',
      `Stories delivered: ${genTest8.stories?.length}, Status: ${genTest8.package?.generationStatus}`
    );

    // --------------------------------------------------------------------------
    // TEST 9: Source Failure Does Not Break Deduplication
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 9: Source Failure Does Not Break Deduplication ---');
    const candidatesTest9: RawCollectedArticle[] = [
      {
        title: 'Company X completes $500M fundraise', // duplicate of Day 1
        summary: 'Company X closed its $500M fundraise.',
        sourceName: 'Mint',
        sourceUrl: 'https://www.livemint.com/x-fundraise-surviving',
        publishedAt: '2026-10-05T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
      {
        title: 'Independent Enterprise Software Provider secures major government digitization pact',
        summary: 'Enterprise software provider closed a multi-year cloud contract.',
        sourceName: 'Business Standard',
        sourceUrl: 'https://www.business-standard.com/surviving-story-2',
        publishedAt: '2026-10-05T05:00:00Z',
        categoryHint: 'cat_india_startups',
      },
    ];

    const windowDay5Test9 = getHistoricalDeliveredStories('cat_india_startups', '2026-10-05', 7);
    const dedupTest9 = filterEligibleCandidateArticles(candidatesTest9, windowDay5Test9);

    assertTest(
      dedupTest9.duplicatesRemoved === 1 && dedupTest9.eligibleRemaining === 1,
      '9. Deduplication functions cleanly with isolated sources, pruning duplicates without failure',
      `Duplicates removed: ${dedupTest9.duplicatesRemoved}, Eligible remaining: ${dedupTest9.eligibleRemaining}`
    );

    // --------------------------------------------------------------------------
    // TEST 10: Existing Idempotency Still Works
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 10: Existing Idempotency Still Works ---');
    const countPkgsBefore = db.dailyNewsPackages.filter(
      (p) => p.categoryId === 'cat_india_startups' && p.newsDate === '2026-10-04'
    ).length;
    const countStoriesBefore = db.newsStories.filter(
      (s) => s.categoryId === 'cat_india_startups' && s.newsDate === '2026-10-04'
    ).length;

    // Re-run generation for same date and category
    const rerun10 = await generateCategoryDailyNews('cat_india_startups', '2026-10-04');

    const countPkgsAfter = db.dailyNewsPackages.filter(
      (p) => p.categoryId === 'cat_india_startups' && p.newsDate === '2026-10-04'
    ).length;
    const countStoriesAfter = db.newsStories.filter(
      (s) => s.categoryId === 'cat_india_startups' && s.newsDate === '2026-10-04'
    ).length;

    assertTest(
      rerun10.success && countPkgsBefore === countPkgsAfter && countStoriesBefore === countStoriesAfter,
      '10. Idempotency guarantee preserved: repeated generation returns existing package without duplicate records',
      `Packages: ${countPkgsBefore} -> ${countPkgsAfter}, Stories: ${countStoriesBefore} -> ${countStoriesAfter}`
    );

    // --------------------------------------------------------------------------
    // TEST 11: Existing Telegram Delivery Behavior Remains Unchanged
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 11: Existing Telegram Delivery Behavior Remains Unchanged ---');
    const custUniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const custRes11 = registerOrLoginCustomer({
      fullName: 'Customer Test Deduplication 11',
      email: `cust11_dedup_${custUniqueSuffix}@example.com`,
      mobileCountryCode: '+91',
      mobileNumber: `98${Math.floor(10000000 + Math.random() * 90000000)}`,
      selectedCategoryIds: ['cat_india_startups'],
    });
    processVerifiedPayment({
      customerId: custRes11.customer.customerId,
      gatewayReference: `UTR_DEDUP_TEST_11_${custUniqueSuffix}`,
      categoryIds: ['cat_india_startups'],
      paymentStatus: 'successful',
      paymentDate: '2026-10-03T10:00:00.000Z',
    });
    const tok11 = generateTelegramConnectionToken(custRes11.customer.customerId);
    connectTelegramAccount(tok11.token, `tg_chat_dedup_11_${custUniqueSuffix}`, `dedup_11_${custUniqueSuffix}`);

    const deliv1 = await deliverCategoryNewsToCustomer({
      customerId: custRes11.customer.customerId,
      categoryId: 'cat_india_startups',
      newsDate: '2026-10-04',
      referenceDate: new Date('2026-10-04T01:00:00.000Z'),
    });

    const deliv2 = await deliverCategoryNewsToCustomer({
      customerId: custRes11.customer.customerId,
      categoryId: 'cat_india_startups',
      newsDate: '2026-10-04',
      referenceDate: new Date('2026-10-04T01:00:00.000Z'),
    });

    assertTest(
      deliv1.status === 'sent' && deliv2.status === 'skipped',
      '11. Telegram delivery succeeds cleanly for deduplicated package, and subsequent run is skipped',
      `First delivery: ${deliv1.status}, Repeated delivery: ${deliv2.status}`
    );

    // --------------------------------------------------------------------------
    // TEST 12: Existing Category Isolation Remains Intact
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 12: Existing Category Isolation Remains Intact ---');
    // Story delivered in cat_india_startups (Company X raises $500M)
    // An unrelated story in cat_india_banking_fintech (State Bank credit growth)
    const windowStartups = getHistoricalDeliveredStories('cat_india_startups', '2026-10-04', 7);
    const windowFintech = getHistoricalDeliveredStories('cat_india_banking_fintech', '2026-10-04', 7);

    const candidateBanking: RawCollectedArticle = {
      title: 'State Bank of India introduces new SME credit facilities',
      summary: 'SBI rolled out specialized working capital programs for rural microenterprises.',
      sourceName: 'Business Standard',
      sourceUrl: 'https://www.business-standard.com/sbi-sme-facilities',
      publishedAt: '2026-10-04T05:00:00Z',
      categoryHint: 'cat_india_banking_fintech',
    };

    const dedupBanking = filterEligibleCandidateArticles([candidateBanking], windowFintech);

    assertTest(
      windowStartups.some((s) => s.headline.includes('Company X')) &&
      !windowFintech.some((s) => s.headline.includes('Company X')) &&
      dedupBanking.eligible.length === 1,
      '12. Category isolation preserved: historical events in Startups do not block Fintech stories',
      `Fintech candidate eligible: ${dedupBanking.eligible.length === 1}`
    );

    // --------------------------------------------------------------------------
    // SUMMARY
    // --------------------------------------------------------------------------
    console.log('\n======================================================================');
    console.log(`DEDUPLICATION TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================================\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } finally {
    if (savedKey) process.env.GEMINI_API_KEY = savedKey;
  }
}

if (process.argv[1]?.endsWith('test_deduplication.ts')) {
  runDeduplicationTests().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}
