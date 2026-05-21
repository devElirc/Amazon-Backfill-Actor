import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import playwright from 'playwright';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import selectors from './selectors.js';
import { normalizeProduct } from './normalizer.js';
import { validateSchema } from './validators.js';

const DEFAULT_LOCALE = 'US';
const DEFAULT_MAX_REVIEWS_PER_STAR = 5;
const ACTOR_VERSION = '1.1';
const ACTOR_NAME = process.env.ACTOR_NAME || 'amazon_backfill_actor_v1';
const NAV_TIMEOUT = 60000;
const NAV_RETRIES = 3;
const GOTO_WAIT = 'domcontentloaded';
const NOW = () => new Date().toISOString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
            actor: source.actor || ACTOR_NAME,
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

function normalizeReviewsFlat(reviewsByStar) {
    const out = [];
    for (const [star, reviews] of Object.entries(reviewsByStar || {})) {
        for (const r of reviews) {
            if (!r || !r.body) continue;
            const rating = Number(star);
            const verified_purchase = typeof r.verified === 'string' && /verified/i.test(r.verified);

            let normalizedDate = null;
            if (r.date) {
                const m = r.date.match(/on\s+(.*)$/i);
                if (m) {
                    const d = new Date(m[1]);
                    if (!Number.isNaN(d.getTime())) {
                        normalizedDate = d.toISOString().slice(0, 10);
                    }
                }
            }

            out.push({
                reviewer: r.reviewer || null,
                rating,
                title: r.title || null,
                body: r.body || null,
                date: normalizedDate,
                verified_purchase,
            });
        }
    }
    return out;
}

export async function runScraper(input, options = {}) {
    const outputDir = options.outputDir || process.cwd();
    const writeFiles = options.writeFiles !== false;
    const runId = options.jobId || `manual-${Date.now()}`;

    if (writeFiles) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const safeInput = input && typeof input === 'object' ? input : {};

    let asinList = [];
    if (Array.isArray(safeInput.asins) && safeInput.asins.length) {
        asinList = safeInput.asins.map((a) => String(a).trim().toUpperCase()).filter(Boolean);
    } else {
        const rawAsin = (safeInput.asin || safeInput.ASIN || safeInput.Asin || '').toString().trim().toUpperCase();
        if (rawAsin) asinList = [rawAsin];
        const rawUrlInput = (safeInput.url || safeInput.product_url || safeInput.productUrl || '').toString().trim();
        if (!asinList.length && rawUrlInput) {
            const detected = extractASINFromURL(rawUrlInput);
            if (detected) asinList = [detected];
        }
    }

    const maxAsinsPerRun = Number.isInteger(safeInput.maxAsinsPerRun) ? safeInput.maxAsinsPerRun
        : (Number.isInteger(safeInput.max_asins_per_run) ? safeInput.max_asins_per_run : 50);

    if (!asinList.length) {
        const err = new Error('No ASINs provided in input.asins or input.asin/url');
        const out = {
            runId,
            requestedAsins: [],
            results: [buildErrorEnvelope('INVALID_INPUT', err, {}, { start: NOW() })],
        };
        if (writeFiles) {
            fs.writeFileSync(path.join(outputDir, 'output.json'), JSON.stringify(out, null, 2));
        }
        return out;
    }

    asinList = asinList.slice(0, maxAsinsPerRun);
    const locale = (safeInput.locale || DEFAULT_LOCALE).toUpperCase();
    const maxReviewsPerStar = Number.isInteger(safeInput.maxReviewsPerStar) ? safeInput.maxReviewsPerStar
        : (Number.isInteger(safeInput.max_reviews_per_star) ? safeInput.max_reviews_per_star : DEFAULT_MAX_REVIEWS_PER_STAR);

    const results = [];
    const startTsOverall = Date.now();
    const proxyServer = process.env.PLAYWRIGHT_PROXY || null;
    let browser = null;

    try {
        browser = await playwright.chromium.launch({ headless: true });
        const contextOptions = {
            userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            locale: locale === 'US' ? 'en-US' : `${locale}`,
        };
        if (proxyServer) {
            contextOptions.proxy = { server: proxyServer };
            console.log('[run] Using proxy server from PLAYWRIGHT_PROXY');
        }

        const context = await browser.newContext(contextOptions);

        for (const asin of asinList) {
            const asinStartTs = Date.now();
            const resultLog = { start: NOW(), steps: [] };
            let page = null;
            try {
                const url = `https://www.amazon.com/dp/${asin}`;
                console.log(`[run] Scraping ASIN ${asin} -> ${url}`);
                page = await context.newPage();

                await withRetries('page.goto', async () => {
                    await page.goto(url, { waitUntil: GOTO_WAIT, timeout: NAV_TIMEOUT });
                }, NAV_RETRIES, 2000);
                await page.waitForTimeout(600);

                const html = await page.content();
                const blockedPattern = /type the characters you see|are you a human|To discuss automated access|Enter the characters you see|sorry we just need to make sure/i;
                if (blockedPattern.test(html)) {
                    const err = new Error('CAPTCHA or bot-check detected on page');
                    const errEnvelope = buildErrorEnvelope('CAPTCHA_DETECTED', err, { platform: 'amazon', asin, product_url: url }, resultLog);
                    results.push(errEnvelope);
                    await page.close().catch(() => { });
                    continue;
                }

                await autoScroll(page, 600, 100);
                await page.waitForTimeout(500);

                async function trySelectorsText(selList) {
                    if (!Array.isArray(selList)) return null;
                    for (const sel of selList) {
                        try {
                            const v = await page.$eval(sel, (el) => (el.textContent || '').trim()).catch(() => null);
                            if (v) return v;
                        } catch {
                            // ignore
                        }
                    }
                    return null;
                }

                async function trySelectorAttribute(sel, attr = 'src') {
                    try {
                        const v = await page.$eval(sel, (el, _attr) => el.getAttribute(_attr) || el[_attr] || null, attr).catch(() => null);
                        return v;
                    } catch {
                        return null;
                    }
                }

                const modulesFailed = [];
                const title = (await trySelectorsText(selectors.title)) || (await page.title()) || null;
                if (!title) modulesFailed.push('title');

                let brand = null;
                try {
                    brand = await page.$eval('tr.po-brand td.a-span9 span', (el) => (el.textContent || '').trim()).catch(() => null);
                    if (!brand) brand = await trySelectorsText(selectors.brand);
                    if (brand) brand = brand.trim();
                    if (!brand) modulesFailed.push('brand');
                } catch {
                    modulesFailed.push('brand');
                }

                let description_text = null;
                try {
                    description_text = await trySelectorsText(selectors.description || []);
                    const bullets = await page.$$eval(selectors.bullets[0], (els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
                    if (!description_text && bullets?.length) description_text = bullets.join(' ');
                    if (!description_text) modulesFailed.push('description_text');
                } catch {
                    modulesFailed.push('description_text');
                }

                let category_path = [];
                try {
                    const catRaw = await page.$$eval(selectors.category_path_selector[0], (els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
                    if (catRaw.length) category_path = catRaw;
                    else modulesFailed.push('category_path');
                } catch {
                    modulesFailed.push('category_path');
                }

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
                    if (!priceCurrent) {
                        const offscreen = await page.$$eval('.a-price .a-offscreen', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
                        if (offscreen.length) {
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

                let availability_status = 'unknown';
                let availability_text = null;
                try {
                    const avail = await trySelectorsText(selectors.availability || ['#availability', '#availability .a-color-state', '#availability .a-color-success']);
                    if (avail) {
                        availability_text = avail;
                        const low = avail.toLowerCase();
                        if (/(in stock|usually ships|available|in-store pickup)/i.test(low)) availability_status = 'in_stock';
                        else if (/(out of stock|unavailable|temporarily out of stock|currently unavailable)/i.test(low)) availability_status = 'out_of_stock';
                    }
                } catch {
                    // ignore
                }

                let mediaImages = [];
                let mediaVideos = [];
                const videoModules = { upper_present: false, lower_present: false };
                let audit = { lower_found_total: 0, upper_found_total: 0, influencer_returned: 0 };

                try {
                    await page.waitForSelector('#altImages', { timeout: 1000 });
                    const thumbnails = await page.$$('#altImages .imageThumbnail');
                    for (let i = 0; i < thumbnails.length; i++) {
                        await thumbnails[i].click();
                        await page.waitForTimeout(100);
                    }
                } catch (err) {
                    console.warn('No thumbnails to click or timeout:', err.message);
                }

                const imagesData = await page.$$eval(
                    'ul.a-horizontal.list.maintain-height li.image',
                    (lis) => lis.map((li) => {
                        const img = li.querySelector('img');
                        return img ? img.getAttribute('data-old-hires') || img.src : null;
                    }).filter(Boolean),
                );
                if (imagesData.length > 0) mediaImages = imagesData;

                try {
                    await page.mouse.move(100, 100);
                    await page.mouse.wheel(0, 2000);
                    await page.waitForTimeout(1000);

                    const lowerVideosRaw = await page.$$eval(
                        'div.a-carousel-viewport ol.a-carousel li.a-carousel-card.vse-video-card div.vse-video-item',
                        (items) => items.map((item, index) => {
                            const hls = item.dataset.videoUrl;
                            if (!hls) return null;
                            return {
                                index,
                                hls_url: hls,
                                title: item.dataset.title || item.querySelector('[data-element-id="video-title"]')?.innerText?.trim() || null,
                                duration: item.dataset.duration || item.querySelector('.vse-video-duration')?.innerText?.trim() || null,
                                creator_name: item.dataset.vendorName || item.querySelector('[data-element-id="video-vendor-name"]')?.innerText?.trim() || null,
                                vendor_code: item.dataset.vendorCode || null,
                                creator_type: item.dataset.creatorType || null,
                                video_age: item.dataset.videoAge || null,
                            };
                        }).filter(Boolean),
                    ).catch(() => []);
                    audit.lower_found_total = lowerVideosRaw.length;

                    const lowerInfluencerVideos = lowerVideosRaw.map((v) => {
                        if (v.creator_type !== 'Influencer' || !v.vendor_code || !v.vendor_code.includes(':shop')) return null;
                        const storefront = `https://www.amazon.com/shop/${v.vendor_code.split(':')[0]}`;
                        if (!v.creator_name || !storefront) return null;
                        return {
                            source: 'lower',
                            index: v.index,
                            hls_url: v.hls_url,
                            creator_name: v.creator_name,
                            creator_storefront_url: storefront,
                            carousel: { lower: true, upper: false },
                        };
                    }).filter(Boolean);
                    if (lowerInfluencerVideos.length) {
                        videoModules.lower_present = true;
                        mediaVideos.push(...lowerInfluencerVideos);
                    }

                    const clicked = await page.evaluate(() => {
                        const el = document.querySelector('li.videoThumbnail') || document.querySelector('li[class*="videoThumbnail"]');
                        if (!el) return false;
                        el.scrollIntoView({ block: 'center' });
                        el.click();
                        return true;
                    });

                    if (clicked) {
                        let ready = false;
                        for (let i = 0; i < 20; i++) {
                            const exists = await page.evaluate(() => document.querySelector('[id^="detailpage-imageblock-related-videos"]'));
                            if (exists) {
                                ready = true;
                                break;
                            }
                            await page.waitForTimeout(400);
                        }
                        if (ready) {
                            const container = await page.$('[id^="detailpage-imageblock-related-videos"]');
                            if (container) {
                                const upperVideosRaw = await page.evaluate((el) =>
                                    Array.from(el.querySelectorAll('.vse-video-item')).map((item, index) => {
                                        const hls = item.dataset.videoUrl;
                                        if (!hls) return null;
                                        return {
                                            index,
                                            hls_url: hls,
                                            title: item.dataset.title || item.querySelector('[data-element-id="video-title"]')?.innerText?.trim() || null,
                                            duration: item.dataset.duration || item.querySelector('.vse-video-duration')?.innerText?.trim() || null,
                                            creator_name: item.dataset.vendorName || item.querySelector('[data-element-id="video-vendor-name"]')?.innerText?.trim() || null,
                                            vendor_code: item.dataset.vendorCode || null,
                                            creator_type: item.dataset.creatorType || null,
                                            video_age: item.dataset.videoAge || null,
                                        };
                                    }).filter(Boolean)
                                    , container);

                                audit.upper_found_total = upperVideosRaw.length;
                                const upperInfluencerVideos = upperVideosRaw.map((v) => {
                                    if (v.creator_type !== 'Influencer' || !v.vendor_code || !v.vendor_code.includes(':shop')) return null;
                                    const storefront = `https://www.amazon.com/shop/${v.vendor_code.split(':')[0]}`;
                                    if (!v.creator_name || !storefront) return null;
                                    return {
                                        source: 'upper',
                                        index: v.index,
                                        hls_url: v.hls_url,
                                        creator_name: v.creator_name,
                                        creator_storefront_url: storefront,
                                        carousel: { upper: true, lower: false },
                                    };
                                }).filter(Boolean);
                                if (upperInfluencerVideos.length) {
                                    videoModules.upper_present = true;
                                    mediaVideos.push(...upperInfluencerVideos);
                                }
                            }
                        }
                    }

                    const map = new Map();
                    for (const v of mediaVideos) {
                        const key = crypto.createHash('sha256').update(v.hls_url).digest('hex');
                        if (!map.has(key)) {
                            map.set(key, {
                                video_key: key,
                                hls_url: v.hls_url,
                                title: v.title,
                                duration: v.duration,
                                creator_name: v.creator_name,
                                creator_storefront_url: v.creator_storefront_url,
                                video_age: v.video_age,
                                carousel: { upper: false, lower: false },
                            });
                        }
                        if (v.carousel.upper) map.get(key).carousel.upper = true;
                        if (v.carousel.lower) map.get(key).carousel.lower = true;
                    }
                    mediaVideos = [...map.values()];
                    audit.influencer_returned = mediaVideos.length;
                } catch (e) {
                    console.error('MEDIA EXTRACTION FAILED:', e);
                }

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
                    if (totalText) total_ratings = parseInt(totalText.replace(/[^0-9]/g, ''), 10) || 0;
                    const hist = await page.$$eval('#histogramTable .a-histogram-row, table#histogramTable tr', (rows) => {
                        const out = {};
                        rows.forEach((r) => {
                            const t = (r.textContent || '').trim();
                            const m = t.match(/([1-5])\s*star[s]?\s*[\s\S]*?([0-9,]+)/i);
                            if (m) out[m[1]] = parseInt(m[2].replace(/,/g, ''), 10);
                        });
                        return out;
                    }).catch(() => ({}));
                    if (hist && Object.keys(hist).length) rating_breakdown = hist;
                } catch {
                    // ignore
                }

                const reviewsByStar = { '1': [], '2': [], '3': [], '4': [], '5': [] };
                try {
                    const rawReviews = await page.$$eval(
                        'li[data-hook="review"], div[data-hook="cr-widget-FocalReviews"] li[data-hook="review"]',
                        (nodes) => nodes.map((n) => {
                            const ratingText =
                                n.querySelector('[data-hook="review-star-rating"] .a-icon-alt')?.textContent?.trim() ||
                                n.querySelector('[data-hook="cmps-review-star-rating"] .a-icon-alt')?.textContent?.trim() ||
                                null;
                            let title = n.querySelector('[data-hook="review-title"] .cr-original-review-content')?.textContent?.trim() || null;
                            if (!title) {
                                const titleAnchor = n.querySelector('a[data-hook="review-title"]');
                                if (titleAnchor) {
                                    const spans = Array.from(titleAnchor.querySelectorAll('span')).map((s) => s.textContent?.trim()).filter(Boolean);
                                    title = spans.length ? spans[spans.length - 1] : null;
                                }
                            }
                            if (!title) title = n.querySelector('[data-hook="review-title"]')?.textContent?.trim() || null;
                            if (title && ratingText && title.includes('out of 5 stars')) title = null;

                            const body =
                                n.querySelector('[data-hook="review-body"] .cr-original-review-content')?.textContent?.trim() ||
                                n.querySelector('[data-hook="review-body"] span')?.textContent?.trim() ||
                                n.querySelector('.review-text-content span')?.textContent?.trim() ||
                                n.querySelector('.reviewText')?.textContent?.trim() ||
                                null;
                            return {
                                reviewer: n.querySelector('.a-profile-name')?.textContent?.trim() || null,
                                ratingText,
                                title,
                                date: n.querySelector('[data-hook="review-date"]')?.textContent?.trim() || null,
                                body,
                                verified: n.querySelector('[data-hook="avp-badge-linkless"]')?.textContent?.trim() || null,
                            };
                        }),
                    ).catch(() => []);

                    if (Array.isArray(rawReviews)) {
                        for (const rv of rawReviews) {
                            if (!rv.ratingText) continue;
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
                } catch {
                    // ignore
                }

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
                } catch {
                    // ignore
                }

                let bullet_points = [];
                let short_description = description_text || null;
                let long_description_html = null;
                let long_description_text = null;
                try {
                    bullet_points = await page.$$eval(selectors.bullets[0], (els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
                    long_description_html = await page.$eval('#productDescription, #bookDescription_feature_div, #feature-bullets', (el) => el.innerHTML).catch(() => null);
                    if (long_description_html) {
                        long_description_text = long_description_html
                            .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
                            .replace(/<\/?[^>]+(>|$)/g, '')
                            .trim();
                    }
                } catch {
                    // ignore
                }

                const product = {
                    asin: asin || extractASINFromURL(url) || null,
                    title: title || null,
                    price: {
                        current: priceCurrent !== null ? priceCurrent : null,
                        previous: priceList !== null ? priceList : null,
                        currency: currency || null,
                    },
                    images: mediaImages,
                    videos: mediaVideos,
                    videoModules,
                    audit,
                    badges: [],
                    ratings: {
                        average: average_rating !== null ? average_rating : null,
                        count: total_ratings || null,
                    },
                    reviews_by_star: reviewsByStar,
                    sales: { units_sold: null, usually_kept: null },
                    _meta_internal: {
                        asin: asin || extractASINFromURL(url) || null,
                        url,
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
                    },
                };

                const badgesArr = [];
                if (badges.is_prime) badgesArr.push('prime');
                if (badges.is_best_seller) badgesArr.push('best_seller');
                if (badges.is_amazon_choice) badgesArr.push('amazon_choice');
                if (badges.has_coupon) badgesArr.push('coupon');
                if (badges.has_limited_time_deal) badgesArr.push('limited_time_deal');
                product.badges = badgesArr;

                const source = {
                    platform: 'amazon',
                    type: 'apify_actor',
                    actor: ACTOR_NAME,
                    asin: product._meta_internal.asin,
                    product_url: product._meta_internal.url,
                };

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
                const reviews = normalizeReviewsFlat(reviewsByStar);
                resultLog.timing_ms = Date.now() - asinStartTs;

                const envelope = {
                    schema_version: '1.1',
                    data_type: 'product_full',
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
                        videoModules: normalized.videoModules || {},
                        audit,
                        badges: normalized._meta_internal?.badges_detected || {},
                        social_proof: {
                            rating: {
                                average: normalized.ratings?.average ?? null,
                                count: normalized.ratings?.count ?? null,
                            },
                            reviews,
                            reviews_meta: {
                                source: 'pdp_recent',
                                reviews_found_total: reviews.length,
                                reviews_returned_total: reviews.length,
                            },
                        },
                        sales: normalized.sales || { units_sold: null, usually_kept: null },
                    },
                    meta: {
                        scraped_at: NOW(),
                        actor_version: ACTOR_VERSION,
                    },
                };

                const missingMinimum = [];
                if (!envelope.product.title) missingMinimum.push('product.title');
                if (!Array.isArray(envelope.product.media.images) || envelope.product.media.images.length < 1) missingMinimum.push('product.images[] (min 1)');
                if (envelope.product.price.current === null || !envelope.product.price.currency) missingMinimum.push('product.price.current + currency');

                if (missingMinimum.length) {
                    if (missingMinimum.includes('product.images[] (min 1)')) {
                        try {
                            await autoScroll(page, 600, 300);
                            await page.waitForTimeout(500);
                            const altImgs = await page.$$eval('#altImages img, #imageBlockThumbs img, #imgTagWrapperId img', (imgs) =>
                                imgs.map((i) => i.getAttribute('src') || i.getAttribute('data-src') || i.src).filter(Boolean)).catch(() => []);
                            if (altImgs?.length) envelope.product.media.images = altImgs.filter(Boolean);
                        } catch {
                            // ignore
                        }
                    }

                    if (
                        missingMinimum.length &&
                        (!Array.isArray(envelope.product.media.images) ||
                            envelope.product.media.images.length < 1 ||
                            !envelope.product.title ||
                            envelope.product.price.current === null ||
                            !envelope.product.price.currency)
                    ) {
                        const errLog = { ...resultLog, missingMinimumAfterRetries: missingMinimum };
                        const errEnvelope = buildErrorEnvelope(
                            'INVALID_LAYOUT',
                            new Error(`Critical fields missing after scraping: ${missingMinimum.join(', ')}`),
                            envelope.source,
                            errLog,
                        );
                        if (writeFiles) {
                            fs.writeFileSync(path.join(outputDir, `output_partial_${asin}.json`), JSON.stringify(envelope, null, 2));
                        }
                        results.push(errEnvelope);
                        await page.close().catch(() => { });
                        continue;
                    }
                }

                try {
                    const svHeaders = { 'Content-Type': 'application/json' };
                    if (process.env.INGEST_API_KEY) svHeaders['X-API-Key'] = process.env.INGEST_API_KEY;
                    const sv_ingest_url = process.env.INGEST_ENDPOINT;
                    if (sv_ingest_url) {
                        const svResp = await axios.post(sv_ingest_url, envelope, {
                            headers: svHeaders,
                            timeout: 30000,
                        });
                        resultLog.sv_ingest = {
                            status: svResp.status,
                            data: typeof svResp.data === 'object' ? svResp.data : String(svResp.data),
                        };
                    } else {
                        resultLog.sv_ingest = 'skipped';
                    }
                } catch (err) {
                    resultLog.sv_ingest_error = String(err && (err.response ? (err.response.data || err.response.status) : err.message));
                }

                const finalOutputItem = buildSuccessEnvelope({
                    schema_version: envelope.schema_version,
                    data_type: envelope.data_type,
                    source: envelope.source,
                    product: envelope.product,
                    meta: envelope.meta,
                }, resultLog);

                if (writeFiles) {
                    fs.writeFileSync(path.join(outputDir, `output_${asin}.json`), JSON.stringify(finalOutputItem, null, 2));
                }

                results.push(finalOutputItem);
                await page.close().catch(() => { });
            } catch (err) {
                console.error(`[run][${asin}] Fatal error:`, String(err));
                const errEnvelope = buildErrorEnvelope(
                    (err && err.message && /captcha/i.test(err.message)) ? 'CAPTCHA_DETECTED' : 'EXCEPTION',
                    err,
                    { platform: 'amazon', asin, product_url: `https://www.amazon.com/dp/${asin}` },
                    resultLog,
                );
                results.push(errEnvelope);
                try { if (page) await page.close().catch(() => { }); } catch { }
            }
        }

        try { await browser.close().catch(() => { }); } catch { }
    } catch (err) {
        console.error('[run] Fatal error starting browser or processing loop', String(err));
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
            timing_ms: Date.now() - startTsOverall,
        },
    };

    if (writeFiles) {
        fs.writeFileSync(path.join(outputDir, 'output.json'), JSON.stringify(finalOutput, null, 2));
    }

    return finalOutput;
}
