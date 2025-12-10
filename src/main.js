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

const isPublicDeploy = () => {
    // Input may contain public: true, or env PUBLIC=true
    if (process.env.PUBLIC && String(process.env.PUBLIC).toLowerCase() === 'true') return true;
    return false;
};

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
    // common patterns
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
 * Also detect variant urls (with /ref= or /gp/aw/d/...).
 */
function normalizeAmazonUrl(inUrl) {
    if (!inUrl) return null;
    try {
        const u = new URL(inUrl);
        // prefer US domain mapping for now (leave host intact)
        // find ASIN
        const asin = extractASINFromURL(inUrl);
        if (asin) {
            return `https://${u.hostname}/dp/${asin}`;
        }
        // if no asin, return cleaned url (remove query params)
        u.search = '';
        return u.toString();
    } catch (err) {
        // not a valid absolute URL, maybe it's just an asin
        const asin = (inUrl || '').match(/^[A-Z0-9]{10}$/i);
        if (asin) return `https://www.amazon.com/dp/${asin[0].toUpperCase()}`;
        return inUrl;
    }
}

const buildErrorResult = async (errCode, err, asin = null, log = {}) => {
    const result = {
        success: false,
        schema_version: '1.1',
        scraped_at: NOW(),
        error: true,
        error_code: errCode,
        error_message: err ? (err.message || String(err)) : errCode,
        source: {
            platform: 'amazon',
            asin: asin || null,
            product_url: null,
        },
        product: {},
        meta: {
            actor_version: ACTOR_VERSION,
            scraped_at: NOW(),
        },
        log,
    };
    try {
        console.error('[buildErrorResult]', errCode, result.error_message);
        await Actor.setValue('OUTPUT', result);
    } catch (e) {
        console.error('[buildErrorResult] failed to set OUTPUT', String(e));
    }
    return result;
};

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

    // Command-line / input overrides
    const startTs = Date.now();
    const resultLog = {
        start: NOW(),
        steps: [],
    };

    const rawAsin = (input.asin || input.ASIN || input.Asin || '').toString().trim().toUpperCase() || null;
    const rawUrlInput = (input.url || input.product_url || input.productUrl || '').toString().trim() || null;
    let url = null;
    if (rawUrlInput) url = normalizeAmazonUrl(rawUrlInput);
    if (!url && rawAsin) url = `https://www.amazon.com/dp/${rawAsin}`;

    const locale = (input.locale || DEFAULT_LOCALE).toUpperCase();
    const maxReviewsPerStar = Number.isInteger(input.maxReviewsPerStar) ? input.maxReviewsPerStar
        : (Number.isInteger(input.max_reviews_per_star) ? input.max_reviews_per_star : DEFAULT_MAX_REVIEWS_PER_STAR);

    if (!url) {
        return await buildErrorResult('INVALID_INPUT', new Error('Missing URL and ASIN'), rawAsin, resultLog);
    }

    // final ASIN (may be null initially)
    let asin = rawAsin || extractASINFromURL(url);

    // Playwright launch context options (policy: allow proxy via PLAYWRIGHT_PROXY env var)
    const proxyServer = process.env.PLAYWRIGHT_PROXY || null;
    let browser;
    try {
        const launchOptions = { headless: true };
        // No special Playwright launcher changes for Apify; Playwright will run inside actor
        browser = await playwright.chromium.launch(launchOptions);

        // create context with optional proxy and locale
        const contextOptions = {
            userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            locale: locale === 'US' ? 'en-US' : `${locale}`,
        };
        if (proxyServer) {
            contextOptions.proxy = { server: proxyServer };
            console.log('[run] Using proxy server from PLAYWRIGHT_PROXY');
        }

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        // Try navigation with retries (handles transient network / proxy issues)
        await withRetries('page.goto', async () => {
            await page.goto(url, { waitUntil: GOTO_WAIT, timeout: NAV_TIMEOUT });
        }, NAV_RETRIES, 2000);

        // short wait for basic load
        await page.waitForTimeout(600);

        // Save initial raw html (best-effort)
        // try {
        //     const initialHtml = await page.content();
        //     await Actor.setValue('raw.html', initialHtml).catch(() => { });
        // } catch (e) {
        //     console.warn('initial raw html save failed', String(e));
        // }

        let html = await page.content();

        // Basic CAPTCHA / block detection
        const blockedPattern = /type the characters you see|are you a human|To discuss automated access|Enter the characters you see|sorry we just need to make sure/i;
        if (blockedPattern.test(html)) {
            return await buildErrorResult('CAPTCHA_DETECTED', new Error('CAPTCHA or bot-check detected on page'), asin, resultLog);
        }

        // scroll to prime areas
        await autoScroll(page, 600, 100);
        await page.waitForTimeout(500);

        // refresh html and save again
        // try {
        //     html = await page.content();
        //     await Actor.setValue('raw.html', html).catch(() => { });
        // } catch (e) {
        //     console.warn('post-scroll raw html save failed', String(e));
        // }

        // Helper to try selectors list, returns first non-empty trimmed string
        async function trySelectorsText(selList) {
            if (!Array.isArray(selList)) return null;
            for (const sel of selList) {
                try {
                    const v = await page.$eval(sel, el => (el.textContent || '').trim()).catch(() => null);
                    if (v) return v;
                } catch (e) {
                    // ignore
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
            // ignore
        }

        // --- Images & Videos
        let mediaImages = [];
        let mediaVideos = [];
        try {
            // first try dynamic JSON image container
            const dynamicImageData = await page.$eval('#imgTagWrapperId img', img => img.getAttribute('data-a-dynamic-image')).catch(() => null);
            if (dynamicImageData) {
                try {
                    const parsed = JSON.parse(dynamicImageData);
                    mediaImages = Object.keys(parsed).map((url, idx) => ({
                        url,
                        role: idx === 0 ? 'primary' : 'gallery',
                        position: idx + 1,
                        width: parsed[url] && parsed[url][0] ? parsed[url][0] : null,
                        height: parsed[url] && parsed[url][1] ? parsed[url][1] : null,
                    }));
                } catch (e) {
                    // ignore parse error
                }
            }

            // fallback: gallery thumbnails
            if (!mediaImages.length) {
                const altImgs = await page.$$eval('#altImages img, #imageBlockThumbs img', imgs => imgs.map(img => img.src).filter(Boolean)).catch(() => []);
                if (altImgs && altImgs.length) {
                    mediaImages = altImgs
                        .filter(src => !/grey-pixel/.test(src))
                        .map((url, idx) => ({ url, role: idx === 0 ? 'primary' : 'gallery', position: idx + 1 }));
                }
            }

            // richer data from thumbnails
            const mediaImagesRaw = await page.$$eval(
                '#altImages li[data-csa-c-posy] img, #imageBlockThumbs li[data-csa-c-posy] img',
                imgs => {
                    const out = [];
                    const seen = new Set();
                    imgs.forEach(img => {
                        const src = img.getAttribute('src') || img.getAttribute('data-src') || img.src || null;
                        if (!src || seen.has(src) || /grey-pixel/.test(src)) return;
                        seen.add(src);
                        const width = img.naturalWidth || (img.width ? parseInt(img.width, 10) : null) || null;
                        const height = img.naturalHeight || (img.height ? parseInt(img.height, 10) : null) || null;
                        let role = 'gallery';
                        const alt = img.getAttribute('alt') || '';
                        const cls = img.className || '';
                        if (/primary|main|hero|imageblock/i.test(cls + alt)) role = 'primary';
                        if (/variant|color|swatch/i.test(cls + alt)) role = 'variant';
                        if (/infograph|infographic/i.test(src + alt)) role = 'infographic';
                        if (/lifestyle|in use|model/i.test(cls + alt)) role = 'lifestyle';
                        out.push({ url: src, role, position: out.length + 1, width, height });
                    });
                    return out;
                }
            ).catch(() => []);
            if (mediaImagesRaw && mediaImagesRaw.length) {
                // prefer richer raw set
                mediaImages = mediaImagesRaw;
            }

            // video extraction (best-effort)
            mediaVideos = await page.$$eval(
                'li.a-carousel-card.vse-video-card .vse-video-item, .vse-videos .vse-video-item',
                items => {
                    const out = [];
                    items.forEach((item, index) => {
                        let thumbnail = null;
                        const img = item.querySelector('img');
                        if (img) thumbnail = img.getAttribute('src') || img.getAttribute('data-src') || img.src || null;
                        let videoUrl = item.dataset?.videoUrl || item.getAttribute('data-video-url') || null;
                        out.push({ thumbnail_url: thumbnail, video_url: videoUrl, position: index + 1, type: 'amazon_video' });
                    });
                    return out;
                }
            ).catch(() => []);
        } catch (e) {
            console.warn('images/videos extraction error', String(e));
        }

        // ensure at least one image in array
        if (!Array.isArray(mediaImages)) mediaImages = [];
        if (!mediaImages.length) {
            // try to use og:image
            try {
                const og = await page.$eval('meta[property="og:image"]', el => el.getAttribute('content')).catch(() => null);
                if (og) mediaImages.push({ url: og, role: 'primary', position: 1 });
            } catch (e) { }
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
            // histogram
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
            // ignore
        }

        const reviewsByStar = { '1': [], '2': [], '3': [], '4': [], '5': [] };
        try {
            const rawReviews = await page.$$eval('li[data-hook="review"], div[data-hook="cr-widget-FocalReviews"] li[data-hook="review"]', nodes => {
                return nodes.map(n => {
                    const getRatingText = () => {
                        const selA = n.querySelector('[data-hook="review-star-rating"] .a-icon-alt');
                        const selB = n.querySelector('[data-hook="cmps-review-star-rating"] .a-icon-alt');
                        return (selA?.textContent || selB?.textContent || null);
                    };
                    const titleEl = n.querySelector('[data-hook="review-title"]') || n.querySelector('.review-title');
                    const bodyEl = n.querySelector('[data-hook="review-body"] span') || n.querySelector('.review-text-content') || n.querySelector('.reviewText');
                    return {
                        reviewer: n.querySelector('.a-profile-name')?.textContent?.trim() || null,
                        ratingText: getRatingText()?.trim() || null,
                        title: titleEl?.textContent?.trim() || null,
                        date: n.querySelector('[data-hook="review-date"]')?.textContent?.trim() || null,
                        body: bodyEl?.textContent?.trim() || null,
                        verified: n.querySelector('[data-hook="avp-badge-linkless"]')?.textContent?.trim() || null,
                    };
                });
            }).catch(() => []);
            if (Array.isArray(rawReviews)) {
                for (const rv of rawReviews) {
                    const rtxt = rv.ratingText || '';
                    const mm = rtxt.match(/([0-9]+(?:[.,][0-9]+)?)/);
                    if (!mm) continue;
                    const num = parseFloat(mm[1].replace(',', '.'));
                    if (Number.isNaN(num)) continue;
                    const star = String(Math.round(Math.max(0.5, Math.min(5, num))));
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
            // ignore
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
            images: (Array.isArray(mediaImages) ? mediaImages.map(i => i.url) : []).filter(Boolean),
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
        resultLog.timing_ms = Date.now() - startTs;

        // Build envelope matching v1.1 layout from your spec
        // Build envelope matching new spec
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


        // Ensure minimum required fields per Backfill Actor spec:
        // product.images[] (>=1), product.title, product.price.current + currency
        const missingMinimum = [];
        if (!envelope.product.title) missingMinimum.push('product.title');
        if (!Array.isArray(envelope.product.images) || envelope.product.images.length < 1) missingMinimum.push('product.images[] (min 1)');
        if (envelope.product.price.current === null || !envelope.product.price.currency) missingMinimum.push('product.price.current + currency');

        if (missingMinimum.length) {
            // If images missing, attempt 1-2 quick retries to get images (lightweight)
            if (missingMinimum.includes('product.images[] (min 1)')) {
                try {
                    // quick retry: re-evaluate gallery selectors
                    await autoScroll(page, 600, 300);
                    await page.waitForTimeout(500);
                    const altImgs = await page.$$eval('#altImages img, #imageBlockThumbs img, #imgTagWrapperId img', imgs =>
                        imgs.map(i => i.getAttribute('src') || i.getAttribute('data-src') || i.src).filter(Boolean)
                    ).catch(() => []);
                    if (altImgs && altImgs.length) {
                        envelope.product.images = altImgs.filter(Boolean);
                    }
                } catch (err) {
                    // ignore
                }
            }

            // After retries, if still missing: return error response but still persist output
            if (missingMinimum.length && (!Array.isArray(envelope.product.images) || envelope.product.images.length < 1 || !envelope.product.title || envelope.product.price.current === null || !envelope.product.price.currency)) {
                const errLog = { ...resultLog, missingMinimumAfterRetries: missingMinimum };
                const built = await buildErrorResult('INVALID_LAYOUT', new Error('Critical fields missing after scraping: ' + missingMinimum.join(', ')), envelope.source.asin, errLog);
                // attach what we have to OUTPUT too
                try { await Actor.setValue('OUTPUT', envelope).catch(() => { }); } catch { }
                if (browser) await browser.close().catch(() => { });
                await Actor.exit();
                return built;
            }
        }

        // If not public mode, ingest to SV endpoint
        // const publicMode = (input.public === true) || isPublicDeploy();
        const publicMode = true;
        if (!publicMode) {
            try {
                const svHeaders = { 'Content-Type': 'application/json' };
                svHeaders['X-API-Key'] = process.env['INGEST_API_KEY'];
                const sv_ingest_url = process.env['INGEST_ENDPOINT'];
                console.log("svHeaders", svHeaders);
                console.log("sv_ingest_url", sv_ingest_url);
                console.log("envelope", envelope);

                const svResp = await axios.post(sv_ingest_url, envelope, {
                    headers: svHeaders,
                    timeout: 30000,
                });

                // FULL LOG
                console.log("++++ FULL AXIOS RESPONSE ++++");
                console.log("status:", svResp.status);
                console.log("statusText:", svResp.statusText);
                console.log("headers:", JSON.stringify(svResp.headers, null, 2));
                console.log("data:", JSON.stringify(svResp.data, null, 2));
                console.log("config:", {
                    url: svResp.config.url,
                    method: svResp.config.method,
                    headers: svResp.config.headers,
                });
                console.log("++++ END RESPONSE ++++");

                resultLog.sv_ingest = {
                    status: svResp.status,
                    data: (typeof svResp.data === 'object') ? svResp.data : String(svResp.data)
                };

            } catch (err) {
                console.log("++++ AXIOS ERROR ++++");

                console.log("message:", err.message);
                if (err.response) {
                    console.log("status:", err.response.status);
                    console.log("headers:", JSON.stringify(err.response.headers, null, 2));
                    console.log("data:", JSON.stringify(err.response.data, null, 2));
                }
                console.log("stack:", err.stack);
                console.log("++++ END ERROR ++++");

                resultLog.sv_ingest_error = String(err);
            }
        } else {
            resultLog.sv_ingest = 'skipped';
        }

        // Always save OUTPUT to Apify
        try {
            const finalOutput = {
                success: true,
                schema_version: '1.1',
                data_type: 'product_full',
                source: envelope.source,
                product: envelope.product,
                meta: envelope.meta,
                log: resultLog,
            };
            await Actor.setValue('OUTPUT', finalOutput);
            // save human readable file
            fs.writeFileSync('output.json', JSON.stringify(finalOutput, null, 2));
            // close browser
            if (browser) await browser.close().catch(() => { });
            await Actor.exit();
            return finalOutput;
        } catch (err) {
            console.warn('set output failed', String(err));
            // Attempt to persist local output file before exit
            try { fs.writeFileSync('output.json', JSON.stringify(envelope, null, 2)); } catch (e) { }
            if (browser) await browser.close().catch(() => { });
            await Actor.exit();
            return envelope;
        }

    } catch (err) {
        console.error('[run] Fatal error', String(err));
        try { if (browser) await browser.close().catch(() => { }); } catch { }
        const code = (err && err.message && /captcha/i.test(err.message)) ? 'CAPTCHA_DETECTED' : 'BLOCKED';
        const built = await buildErrorResult(code, err, extractASINFromURL(url) || null, resultLog);
        await Actor.exit();
        return built;
    }
};

run().catch(err => {
    console.error('Unhandled run error', err);
});
