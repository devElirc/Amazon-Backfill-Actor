// // src/normalizer.js
// function ensureArray(a) { return Array.isArray(a) ? a : (a ? [a] : []); }

// function normalizeProduct(raw) {
//   return {
//     version: raw.version || '1.0.0',
//     source: raw.source || 'amazon',
//     scraped_at: new Date().toISOString(),
//     asin: raw.asin || null,
//     locale: raw.locale || 'US',
//     marketplace: 'amazon.com',
//     product_url: raw.product_url || null,
//     title: raw.title || null,
//     brand: raw.brand || null,
//     category_path: ensureArray(raw.category_path),
//     main_image: raw.main_image || null,
//     all_images: ensureArray(raw.all_images),
//     pricing: raw.pricing || { list_price: null, sale_price: null, currency: 'USD', price_display: null },
//     engagement: raw.engagement || { customers_usually_keep_percentage: null, customers_usually_keep_raw: null, units_sold_display: null, units_sold_numeric_estimate: null },
//     ratings: raw.ratings || { average_rating: null, total_ratings: null },
//     reviews_by_star: raw.reviews_by_star || { '1': [], '2': [], '3': [], '4': [], '5': [] },
//     related_products: raw.related_products || { similar_items: [] }
//   };
// }

// module.exports = { normalizeProduct };


export function normalizeProduct(product) {
    // For MVP, just return the product
    return product;
}
