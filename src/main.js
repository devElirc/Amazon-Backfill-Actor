// src/main.js
import dotenv from 'dotenv';
dotenv.config();

import { Actor } from 'apify';
import playwright from 'playwright';
import fs from 'fs';
import axios from 'axios';
import selectors from './selectors.js';
import { parseNumberWithSuffix } from './helpers.js';
import { normalizeProduct } from './normalizer.js';
import { validateSchema } from './validators.js';
import minimist from 'minimist';

const DEFAULT_LOCALE = 'US';
const DEFAULT_MAX_REVIEWS_PER_STAR = 5;
const ACTOR_VERSION = '1.1';
const ACTOR_NAME = process.env.ACTOR_NAME || 'amazon_backfill_actor_v1';
const SOURCE_SUBMITTED_BY = 'apify';
const NAV_TIMEOUT = 60000;
const NAV_RETRIES = 3;
const GOTO_WAIT = 'domcontentloaded';
const NOW = () => new Date().toISOString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry wrapper for async actions.
 * attempts: number of times to try (>=1)
 * backoffMs: base backoff between attempts (multiplied)
 */
async function withRetries(actionName, fn, attempts = 3, backoffMs = 1000) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            console.warn(`[withRetries] ${actionName} failed (attempt ${i + 1}/${attempts}): ${String(err)}`);
            if (i < attempts - 1) {
                await sleep(backoffMs * (i + 1));
            }
        }
    }
    throw lastErr;
}

function extractASINFromURL(url) {
    if (!url || typeof url !== 'string') return null;

    const patterns = [
        /\/([A-Z0-9]{10})(?:[/?]|$)/i,
        /dp\/([A-Z0-9]{10})/i,
        /gp\/product\/([A-Z0-9]{10})/i,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1].toUpperCase();
    }
    return null;
}

/**
 * Normalize Amazon product URL to parent dp URL when possible.
 */
function normalizeAmazonUrl(inUrl) {
    if (!inUrl) return null;
    try {
        const u = new URL(inUrl);
        const asin = extractASINFromURL(inUrl);
        if (asin) {
            return `https://${u.hostname}/dp/${asin}`;
        }
        u.search = '';
        return u.toString();
    } catch (err) {
        const asin = (inUrl || '').match(/^[A-Z0-9]{10}$/i);
        if (asin) return `https://www.amazon.com/dp/${asin[0].toUpperCase()}`;
        return inUrl;
    }
}

/**
 * Build per-ASIN success envelope matching your example output.
 * We'll return objects that look like the example item.
 */
function buildSuccessEnvelope(envelope, resultLog) {
    return {
        success: true,
        schema_version: envelope.schema_version || '1.1',
        data_type: envelope.data_type || 'product_full',
        source: envelope.source || {},
        product: envelope.product || {},
        meta: envelope.meta || {},
        log: resultLog || {},
    };
}

/**
 * Build per-ASIN error envelope (keeps shape similar to success but with success:false)
 */
function buildErrorEnvelope(errCode, err, source = {}, resultLog = {}) {
    return {
        success: false,
        schema_version: '1.1',
        data_type: 'product_full',
        source: {
            platform: source.platform || 'amazon',
            asin: source.asin || null,
            product_url: source.product_url || null,
            type: source.type || 'apify_actor',
            actor: source.actor || 'amazon-backfill-actor',
        },
        product: {},
        meta: {
            actor_version: ACTOR_VERSION,
            scraped_at: NOW(),
        },
        error: true,
        error_code: errCode,
        error_message: err ? (err.message || String(err)) : errCode,
        log: resultLog || {},
    };
}

// Scroll helper to trigger lazy-loaded modules (lighter and safer)
async function autoScroll(page, step = 600, delay = 100) {
    try {
        await page.evaluate(async ({ step, delay }) => {
            await new Promise((resolve) => {
                let total = 0;
                const timer = setInterval(() => {
                    window.scrollBy(0, step);
                    total += step;
                    if (total >= document.body.scrollHeight) {
                        clearInterval(timer);
                        setTimeout(resolve, delay);
                    }
                }, delay);
            });
        }, { step, delay });
    } catch (err) {
        console.warn('autoScroll failed:', String(err));
    }
}

const run = async () => {
    await Actor.init();
    console.log('[run] Actor init @', NOW());

    const argv = minimist(process.argv.slice(2));
    let input = {};
    try {
        input = argv.inputFile
            ? JSON.parse(fs.readFileSync(argv.inputFile, 'utf8'))
            : await Actor.getInput() || {};
    } catch (err) {
        console.warn('[run] Failed loading input, using empty input:', String(err));
        input = {};
    }

    // Normalize input (support legacy single-asin too)
    let asinList = [];
    if (Array.isArray(input.asins) && input.asins.length) {
        asinList = input.asins.map(a => String(a).trim().toUpperCase()).filter(Boolean);
    } else {
        const rawAsin = (input.asin || input.ASIN || input.Asin || '').toString().trim().toUpperCase();
        if (rawAsin) asinList = [rawAsin];
        const rawUrlInput = (input.url || input.product_url || input.productUrl || '').toString().trim();
        if (!asinList.length && rawUrlInput) {
            const detected = extractASINFromURL(rawUrlInput);
            if (detected) asinList = [detected];
        }
    }

    const maxAsinsPerRun = Number.isInteger(input.maxAsinsPerRun) ? input.maxAsinsPerRun
        : (Number.isInteger(input.max_asins_per_run) ? input.max_asins_per_run : 50);

    if (!asinList.length) {
        const err = new Error('No ASINs provided in input.asins or input.asin/url');
        console.error('[run] INVALID_INPUT', err.message);
        const out = {
            runId: process.env.APIFY_RUN_ID || `manual-${Date.now()}`,
            requestedAsins: [],
            results: [buildErrorEnvelope('INVALID_INPUT', err, {}, { start: NOW() })],
        };
        try { await Actor.setValue('OUTPUT', out); } catch (e) { console.error('Failed set OUTPUT', e); }
        await Actor.exit();
        return out;
    }

    // Slice to max
    asinList = asinList.slice(0, maxAsinsPerRun);

    const locale = (input.locale || DEFAULT_LOCALE).toUpperCase();
    const maxReviewsPerStar = Number.isInteger(input.maxReviewsPerStar) ? input.maxReviewsPerStar
        : (Number.isInteger(input.max_reviews_per_star) ? input.max_reviews_per_star : DEFAULT_MAX_REVIEWS_PER_STAR);

    const runId = process.env.APIFY_RUN_ID || `manual-${Date.now()}`;
    const results = [];
    const startTsOverall = Date.now();

    // Launch browser once and reuse context for sequential scrapes
    const proxyServer = process.env.PLAYWRIGHT_PROXY || null;
    let browser = null;
    try {
        const launchOptions = { headless: true };
        browser = await playwright.chromium.launch(launchOptions);

        const contextOptions = {
            userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            locale: locale === 'US' ? 'en-US' : `${locale}`,
        };
        if (proxyServer) {
            contextOptions.proxy = { server: proxyServer };
            console.log('[run] Using proxy server from PLAYWRIGHT_PROXY');
        }

        const context = await browser.newContext(contextOptions);

        // Sequentially process each ASIN
        for (const asin of asinList) {
            const asinStartTs = Date.now();
            const resultLog = { start: NOW(), steps: [] };
            let page = null;
            try {
                const url = `https://www.amazon.com/dp/${asin}`;
                console.log(`[run] Scraping ASIN ${asin} -> ${url}`);

                page = await context.newPage();

                // navigation with retries
                await withRetries('page.goto', async () => {
                    await page.goto(url, { waitUntil: GOTO_WAIT, timeout: NAV_TIMEOUT });
                }, NAV_RETRIES, 2000);

                await page.waitForTimeout(600);

                let html = await page.content();

                // Basic CAPTCHA / block detection
                const blockedPattern = /type the characters you see|are you a human|To discuss automated access|Enter the characters you see|sorry we just need to make sure/i;
                if (blockedPattern.test(html)) {
                    const err = new Error('CAPTCHA or bot-check detected on page');
                    console.error(`[run][${asin}] CAPTCHA detected`);
                    const errEnvelope = buildErrorEnvelope('CAPTCHA_DETECTED', err, { platform: 'amazon', asin, product_url: url }, resultLog);
                    results.push(errEnvelope);
                    await page.close().catch(() => { });
                    continue; // go to next ASIN
                }

                // scroll
                await autoScroll(page, 600, 100);
                await page.waitForTimeout(500);

                // Helper to try selectors list, returns first non-empty trimmed string
                async function trySelectorsText(selList) {
                    if (!Array.isArray(selList)) return null;
                    for (const sel of selList) {
                        try {
                            const v = await page.$eval(sel, el => (el.textContent || '').trim()).catch(() => null);
                            if (v) return v;
                        } catch (e) {
                        }
                    }
                    return null;
                }

                // Helper: try selectors that return attribute (src, data-a-dynamic-image, etc.)
                async function trySelectorAttribute(sel, attr = 'src') {
                    try {
                        const v = await page.$eval(sel, (el, attr) => el.getAttribute(attr) || el[attr] || null, attr).catch(() => null);
                        return v;
                    } catch (e) {
                        return null;
                    }
                }

                const modulesFailed = [];

                // --- Title
                const title = (await trySelectorsText(selectors.title)) || (await page.title()) || null;
                if (!title) modulesFailed.push('title');

                // --- Brand
                let brand = null;
                try {
                    brand = await page.$eval('tr.po-brand td.a-span9 span', el => (el.textContent || '').trim()).catch(() => null);
                    if (!brand) brand = await trySelectorsText(selectors.brand);
                    if (brand) brand = brand.trim();
                    if (!brand) modulesFailed.push('brand');
                } catch (e) {
                    modulesFailed.push('brand');
                }

                // --- Description & bullets
                let description_text = null;
                try {
                    description_text = await trySelectorsText(selectors.description || []);
                    const bullets = await page.$$eval(selectors.bullets[0], els => els.map(e => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
                    if (!description_text && bullets && bullets.length) description_text = bullets.join(' ');
                    if (!description_text) modulesFailed.push('description_text');
                } catch (e) {
                    modulesFailed.push('description_text');
                }

                // --- Categories / breadcrumbs
                let category_path = [];
                try {
                    const catRaw = await page.$$eval(selectors.category_path_selector[0], els => els.map(e => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
                    if (catRaw.length) category_path = catRaw;
                    else modulesFailed.push('category_path');
                } catch (e) {
                    modulesFailed.push('category_path');
                }

                // --- Pricing
                let priceCurrent = null;
                let priceList = null;
                let currency = null;
                try {
                    for (const sel of selectors.price) {
                        const text = await trySelectorAttribute(sel, 'textContent');
                        if (text) {
                            const cleaned = (text || '').replace(/\u00A0/g, ' ');
                            const m = cleaned.match(/([^\d.,]*)([\d,.]+)/);
                            if (m) {
                                currency = (m[1] || '$').trim();
                                priceCurrent = parseFloat(m[2].replace(/,/g, ''));
                                break;
                            }
                        }
                    }

                    for (const sel of selectors.list_price) {
                        const text = await trySelectorAttribute(sel, 'textContent');
                        if (text) {
                            const cleaned = (text || '').replace(/\u00A0/g, ' ');
                            const m = cleaned.match(/([^\d.,]*)([\d,.]+)/);
                            if (m) {
                                if (!currency) currency = (m[1] || '$').trim();
                                priceList = parseFloat(m[2].replace(/,/g, ''));
                                break;
                            }
                        }
                    }

                    // fallback: price a-offscreen
                    if (!priceCurrent) {
                        const offscreen = await page.$$eval('.a-price .a-offscreen', els => els.map(e => e.textContent.trim())).catch(() => []);
                        if (offscreen && offscreen.length) {
                            const m = offscreen[0].match(/([^\d.,]*)([\d,.]+)/);
                            if (m) {
                                currency = (m[1] || '$').trim();
                                priceCurrent = parseFloat(m[2].replace(/,/g, ''));
                            }
                        }
                    }

                    if (priceCurrent === null) modulesFailed.push('price');
                } catch (e) {
                    console.warn('price extraction error', String(e));
                    modulesFailed.push('price');
                }

                // --- Availability
                let availability_status = 'unknown';
                let availability_text = null;
                try {
                    const avail = await trySelectorsText(selectors.availability || ['#availability', '#availability .a-color-state', '#availability .a-color-success']);
                    if (avail) {
                        availability_text = avail;
                        const low = avail.toLowerCase();
                        if (/(in stock|usually ships|available|in-store pickup)/i.test(low)) availability_status = 'in_stock';
                        else if (/(out of stock|unavailable|temporarily out of stock|currently unavailable)/i.test(low)) availability_status = 'out_of_stock';
                        else availability_status = 'unknown';
                    }
                } catch (e) {
                }

                // --- Images & Videos
                let mediaImages = [];
                let mediaVideos = [];

                try {
                    // ===============================
                    // 1. CLICK THUMBNAILS TO LOAD IMAGES
                    // ===============================
                    try {
                        await page.waitForSelector('#altImages', { timeout: 1000 });
                        const thumbnails = await page.$$('#altImages .imageThumbnail');

                        for (let i = 0; i < thumbnails.length; i++) {
                            const thumb = thumbnails[i];
                            await thumb.click();
                            await page.waitForTimeout(100); // wait for main image to update
                        }
                    } catch (err) {
                        console.warn('No thumbnails to click or timeout:', err.message);
                    }

                    // ===============================
                    // 2. EXTRACT IMAGES
                    // ===============================
                    const imagesData = await page.$$eval(
                        'ul.a-horizontal.list.maintain-height li.image',
                        lis => lis
                            .map(li => {
                                const img = li.querySelector('img');
                                return img ? img.getAttribute('data-old-hires') || img.src : null;
                            })
                            .filter(Boolean)
                    );

                    if (imagesData.length > 0) mediaImages = imagesData;


                    // ===============================
                    // 5. VIDEO EXTRACTION (BEST EFFORT)
                    // ===============================
                    mediaVideos = await page
                        .$$eval(
                            'li.a-carousel-card.vse-video-card .vse-video-item, .vse-videos .vse-video-item',
                            items =>
                                items.map((item, index) => {
                                    const img = item.querySelector('img');
                                    return {
                                        thumbnail_url:
                                            img?.getAttribute('data-src') ||
                                            img?.getAttribute('src') ||
                                            null,
                                        video_url:
                                            item.dataset?.videoUrl ||
                                            item.getAttribute('data-video-url') ||
                                            null,
                                        position: index + 1,
                                        type: 'amazon_video',
                                    };
                                })
                        )
                        .catch(() => []);

                } catch (e) {
                    console.warn('Media extraction error:', String(e));
                }


                // --- Ratings & Reviews sampling
                let average_rating = null;
                let total_ratings = 0;
                let rating_breakdown = null;
                try {
                    const avgText = await trySelectorsText(selectors.rating_avg || []);
                    if (avgText) {
                        const m = avgText.match(/([0-9]+(?:[.,][0-9]+)?)/);
                        if (m) average_rating = parseFloat(m[1].replace(',', '.'));
                    }
                    const totalText = await trySelectorsText(selectors.total_ratings || []);
                    if (totalText) {
                        total_ratings = parseInt(totalText.replace(/[^0-9]/g, ''), 10) || 0;
                    }
                    const hist = await page.$$eval('#histogramTable .a-histogram-row, table#histogramTable tr', rows => {
                        const out = {};
                        rows.forEach(r => {
                            const t = (r.textContent || '').trim();
                            const m = t.match(/([1-5])\s*star[s]?\s*[\s\S]*?([0-9,]+)/i);
                            if (m) out[m[1]] = parseInt(m[2].replace(/,/g, ''), 10);
                        });
                        return out;
                    }).catch(() => ({}));
                    if (hist && Object.keys(hist).length) rating_breakdown = hist;
                } catch (e) {
                }

                const reviewsByStar = { '1': [], '2': [], '3': [], '4': [], '5': [] };

                try {
                    const rawReviews = await page.$$eval(
                        'li[data-hook="review"], div[data-hook="cr-widget-FocalReviews"] li[data-hook="review"]',
                        nodes => {
                            return nodes.map(n => {
                                const ratingText =
                                    n.querySelector('[data-hook="review-star-rating"] .a-icon-alt')
                                        ?.textContent
                                        ?.trim() ||
                                    n.querySelector('[data-hook="cmps-review-star-rating"] .a-icon-alt')
                                        ?.textContent
                                        ?.trim() ||
                                    null;

                                let title = null;

                                // Foreign reviews (original language)
                                title =
                                    n.querySelector('[data-hook="review-title"] .cr-original-review-content')
                                        ?.textContent
                                        ?.trim() || null;

                                // Standard US reviews (anchor → last meaningful span)
                                if (!title) {
                                    const titleAnchor = n.querySelector('a[data-hook="review-title"]');
                                    if (titleAnchor) {
                                        const spans = Array.from(titleAnchor.querySelectorAll('span'))
                                            .map(s => s.textContent?.trim())
                                            .filter(Boolean);
                                        title = spans.length ? spans[spans.length - 1] : null;
                                    }
                                }

                                // Final fallback (very rare layouts)
                                if (!title) {
                                    title = n
                                        .querySelector('[data-hook="review-title"]')
                                        ?.textContent
                                        ?.trim() || null;
                                }

                                // Guard: prevent rating text from becoming title
                                if (title && ratingText && title.includes('out of 5 stars')) {
                                    title = null;
                                }

                                const body =
                                    n.querySelector('[data-hook="review-body"] .cr-original-review-content')
                                        ?.textContent
                                        ?.trim() ||
                                    n.querySelector('[data-hook="review-body"] span')
                                        ?.textContent
                                        ?.trim() ||
                                    n.querySelector('.review-text-content span')
                                        ?.textContent
                                        ?.trim() ||
                                    n.querySelector('.reviewText')
                                        ?.textContent
                                        ?.trim() ||
                                    null;

                                return {
                                    reviewer:
                                        n.querySelector('.a-profile-name')
                                            ?.textContent
                                            ?.trim() || null,
                                    ratingText,
                                    title,
                                    date:
                                        n.querySelector('[data-hook="review-date"]')
                                            ?.textContent
                                            ?.trim() || null,
                                    body,
                                    verified:
                                        n.querySelector('[data-hook="avp-badge-linkless"]')
                                            ?.textContent
                                            ?.trim() || null,
                                };
                            });
                        }
                    ).catch(() => []);

                    if (Array.isArray(rawReviews)) {
                        for (const rv of rawReviews) {
                            if (!rv.ratingText) continue;

                            // Locale-safe rating parse
                            const mm = rv.ratingText.match(/([0-9]+(?:[.,][0-9]+)?)/);
                            if (!mm) continue;

                            const num = parseFloat(mm[1].replace(',', '.'));
                            if (Number.isNaN(num)) continue;

                            const star = String(Math.round(Math.max(1, Math.min(5, num))));

                            if (reviewsByStar[star].length < maxReviewsPerStar) {
                                reviewsByStar[star].push({
                                    reviewer: rv.reviewer,
                                    rating: rv.ratingText,
                                    title: rv.title,
                                    date: rv.date,
                                    body: rv.body,
                                    verified: rv.verified,
                                });
                            }
                        }
                    }
                } catch (e) {
                    // intentionally ignored (Amazon DOM volatility)
                }



                // --- Badges
                const badges = {
                    is_prime: false,
                    is_best_seller: false,
                    is_amazon_choice: false,
                    has_coupon: false,
                    has_limited_time_deal: false,
                };
                try {
                    if (await page.$('i.a-icon-prime, .a-icon-prime, .prime-badge')) badges.is_prime = true;
                    if (await page.$('.badge-text, .best-seller, #BESTSELLER, .a-badge-text')) badges.is_best_seller = true;
                    if (await page.$('div#acBadge_feature_div, .amazon-choice, .ac-badge, #AmazonChoiceBadge')) badges.is_amazon_choice = true;
                    if (await page.$('#couponBadge, .badge-coupon, .savingsBadge, .couponBadge')) badges.has_coupon = true;
                    if (await page.$('.dealBadge, #dealBadge, .deal-status-badge, .a-color-price')) badges.has_limited_time_deal = true;
                } catch (e) {
                    // ignore
                }

                // --- Copy
                let bullet_points = [];
                let short_description = description_text || null;
                let long_description_html = null;
                let long_description_text = null;
                try {
                    bullet_points = await page.$$eval(selectors.bullets[0], els => els.map(e => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
                    long_description_html = await page.$eval('#productDescription, #bookDescription_feature_div, #feature-bullets', el => el.innerHTML).catch(() => null);
                    if (long_description_html) {
                        long_description_text = long_description_html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '').replace(/<\/?[^>]+(>|$)/g, '').trim();
                    }
                } catch (e) {
                    // ignore
                }

                // --- Build product object matching your v1.1 skeleton (fits SV spec)
                const product = {
                    asin: asin || extractASINFromURL(url) || null,
                    title: title || null,
                    price: {
                        current: priceCurrent !== null ? priceCurrent : null,
                        previous: priceList !== null ? priceList : null,
                        currency: currency || null,
                    },
                    images: mediaImages,
                    videos: (Array.isArray(mediaVideos) ? mediaVideos.map(v => v.video_url || v.videoUrl || v.video) : []).filter(Boolean),
                    badges: [], // keep original simple boolean badges translated below if needed
                    ratings: {
                        average: average_rating !== null ? average_rating : null,
                        count: total_ratings || null,
                    },
                    reviews_by_star: reviewsByStar,
                    sales: {
                        units_sold: null,
                        usually_kept: null,
                    },

                    // Internal friendly fields (not part of main product block in SV but keep for debugging)
                    _meta_internal: {
                        asin: asin || extractASINFromURL(url) || null,
                        url: url,
                        brand: brand || null,
                        categories: category_path || [],
                        availability: { status: availability_status, text: availability_text || null },
                        copy: {
                            bullet_points,
                            short_description,
                            long_description_html,
                            long_description_text,
                        },
                        rating_breakdown,
                        reviews_by_star: reviewsByStar,
                        badges_detected: badges,
                    }
                };

                // Map simple badges into product.badges (optional)
                const badgesArr = [];
                if (badges.is_prime) badgesArr.push('prime');
                if (badges.is_best_seller) badgesArr.push('best_seller');
                if (badges.is_amazon_choice) badgesArr.push('amazon_choice');
                if (badges.has_coupon) badgesArr.push('coupon');
                if (badges.has_limited_time_deal) badgesArr.push('limited_time_deal');
                product.badges = badgesArr;

                // set proper source block
                const source = {
                    platform: 'amazon',
                    type: "apify_actor",
                    actor: "amazon-backfill-actor",

                    asin: product._meta_internal.asin,
                    product_url: product._meta_internal.url,
                };

                // meta block per spec
                const meta = {
                    scraped_at: NOW(),
                    actor_version: ACTOR_VERSION,
                    scraper_version: ACTOR_VERSION,
                };

                // Validation & normalization hooks (best-effort, do not crash)
                let normalized = product;
                try {
                    if (typeof normalizeProduct === 'function') {
                        normalized = normalizeProduct(product);
                    }
                } catch (e) {
                    console.warn('normalizeProduct error', String(e));
                }

                let validation = { valid: true, errors: [] };
                try {
                    if (typeof validateSchema === 'function') {
                        validation = validateSchema(normalized);
                    }
                } catch (e) {
                    console.warn('validateSchema error', String(e));
                }

                resultLog.validation = validation;
                resultLog.modules_failed = modulesFailed;
                resultLog.total_reviews_scraped = Object.values(reviewsByStar).reduce((s, a) => s + a.length, 0);
                resultLog.timing_ms = Date.now() - asinStartTs;

                // Build envelope matching v1.1 layout from your spec
                const envelope = {
                    schema_version: '1.1',
                    data_type: "product_full",
                    source,
                    product: {
                        asin: normalized.asin,
                        url: normalized.url,
                        title: normalized.title || null,
                        price: {
                            current: normalized.price?.current ?? null,
                            previous: normalized.price?.previous ?? null,
                            currency: normalized.price?.currency ?? null,
                        },
                        media: {
                            images: normalized.images || [],
                            videos: normalized.videos || [],
                        },
                        badges: normalized._meta_internal?.badges_detected || {}, // keep boolean flags
                        social_proof: {
                            rating: {
                                average: normalized.ratings?.average ?? null,
                                count: normalized.ratings?.count ?? null,
                            },
                            reviews_by_star: normalized.reviews_by_star || [],
                        },
                        sales: normalized.sales || { units_sold: null, usually_kept: null },
                    },
                    meta: {
                        scraped_at: NOW(),
                        actor_version: ACTOR_VERSION,
                    },
                };

                // product.images[] (>=1), product.title, product.price.current + currency
                const missingMinimum = [];
                if (!envelope.product.title) missingMinimum.push('product.title');
                if (!Array.isArray(envelope.product.media.images) || envelope.product.media.images.length < 1) missingMinimum.push('product.images[] (min 1)');
                if (envelope.product.price.current === null || !envelope.product.price.currency) missingMinimum.push('product.price.current + currency');

                if (missingMinimum.length) {
                    // If images missing, attempt 1-2 quick retries to get images (lightweight)
                    if (missingMinimum.includes('product.images[] (min 1)')) {
                        try {
                            await autoScroll(page, 600, 300);
                            await page.waitForTimeout(500);
                            const altImgs = await page.$$eval('#altImages img, #imageBlockThumbs img, #imgTagWrapperId img', imgs =>
                                imgs.map(i => i.getAttribute('src') || i.getAttribute('data-src') || i.src).filter(Boolean)
                            ).catch(() => []);
                            if (altImgs && altImgs.length) {
                                envelope.product.media.images = altImgs.filter(Boolean);
                            }
                        } catch (err) {
                            // ignore
                        }
                    }

                    // After retries, if still missing: create error envelope and continue
                    if (missingMinimum.length && (!Array.isArray(envelope.product.media.images) || envelope.product.media.images.length < 1 || !envelope.product.title || envelope.product.price.current === null || !envelope.product.price.currency)) {
                        const errLog = { ...resultLog, missingMinimumAfterRetries: missingMinimum };
                        const errEnvelope = buildErrorEnvelope('INVALID_LAYOUT', new Error('Critical fields missing after scraping: ' + missingMinimum.join(', ')), envelope.source, errLog);
                        // attempt to save partial envelope locally for debugging
                        try { fs.writeFileSync(`output_partial_${asin}.json`, JSON.stringify(envelope, null, 2)); } catch (e) { }
                        results.push(errEnvelope);
                        await page.close().catch(() => { });
                        continue; // next ASIN
                    }
                }

                // Ingest each ASIN individually (non-blocking try/catch)
                // try {
                //     const svHeaders = { 'Content-Type': 'application/json' };
                //     if (process.env['INGEST_API_KEY']) svHeaders['X-API-Key'] = process.env['INGEST_API_KEY'];
                //     const sv_ingest_url = process.env['INGEST_ENDPOINT'];
                //     if (sv_ingest_url) {
                //         const svResp = await axios.post(sv_ingest_url, envelope, {
                //             headers: svHeaders,
                //             timeout: 30000,
                //         });
                //         resultLog.sv_ingest = {
                //             status: svResp.status,
                //             data: (typeof svResp.data === 'object') ? svResp.data : String(svResp.data)
                //         };
                //     } else {
                //         resultLog.sv_ingest = 'skipped';
                //     }
                // } catch (err) {
                //     resultLog.sv_ingest_error = String(err && (err.response ? (err.response.data || err.response.status) : err.message));
                // }

                // final output item for this ASIN
                const finalOutputItem = buildSuccessEnvelope({
                    schema_version: envelope.schema_version,
                    data_type: envelope.data_type,
                    source: envelope.source,
                    product: envelope.product,
                    meta: envelope.meta,
                }, resultLog);

                // persist per-run file and push to results array
                try { fs.writeFileSync(`output_${asin}.json`, JSON.stringify(finalOutputItem, null, 2)); } catch (e) { /* ignore */ }

                results.push(finalOutputItem);

                // close page to release memory
                await page.close().catch(() => { });
            } catch (err) {
                console.error(`[run][${asin}] Fatal error:`, String(err));
                const errEnvelope = buildErrorEnvelope((err && err.message && /captcha/i.test(err.message)) ? 'CAPTCHA_DETECTED' : 'EXCEPTION', err, { platform: 'amazon', asin, product_url: `https://www.amazon.com/dp/${asin}` }, resultLog);
                results.push(errEnvelope);
                try { if (page) await page.close().catch(() => { }); } catch { }
                continue; // move to next asin
            }
        } // end for each ASIN

        // close browser & context
        try { await browser.close().catch(() => { }); } catch (e) { /* ignore */ }

    } catch (err) {
        console.error('[run] Fatal error starting browser or processing loop', String(err));
        // push global fatal error for whole run
        results.push(buildErrorEnvelope('FATAL', err, {}, { start: NOW() }));
        try { if (browser) await browser.close().catch(() => { }); } catch { }
    }

    const finalOutput = {
        runId,
        requestedAsins: asinList,
        results,
        meta: {
            scraped_at: NOW(),
            actor_version: ACTOR_VERSION,
            timing_ms: Date.now() - startTsOverall
        },
    };

    // save final output to Apify
    try {
        await Actor.setValue('OUTPUT', finalOutput);
        // also write local file
        try { fs.writeFileSync('output.json', JSON.stringify(finalOutput, null, 2)); } catch (e) { /* ignore */ }
    } catch (err) {
        console.error('[run] Failed to set OUTPUT', String(err));
        try { fs.writeFileSync('output_failed_setvalue.json', JSON.stringify(finalOutput, null, 2)); } catch (e) { /* ignore */ }
    }

    await Actor.exit();
    return finalOutput;
};

run().catch(async (err) => {
    console.error('Unhandled run error', err);
    try {
        const out = {
            runId: process.env.APIFY_RUN_ID || `manual-${Date.now()}`,
            requestedAsins: [],
            results: [buildErrorEnvelope('UNHANDLED', err, {}, { ts: NOW() })],
        };
        await Actor.setValue('OUTPUT', out).catch(() => { });
    } catch (e) { /* ignore */ }
    try { await Actor.exit(); } catch (e) { /* ignore */ }
});
