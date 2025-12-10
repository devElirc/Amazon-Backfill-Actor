// src/selectors.js
export default {
    // -------------------------
    //  CORE PRODUCT FIELDS
    // -------------------------
    title: [
        "#productTitle",
        "#titleSection #title",
        "h1#title",
        "span#title"
    ],

    brand: [
        "#bylineInfo",
        "#brand",
        ".po-brand .a-span9",
        ".a-link-normal.contributorNameID",
        "#poExpander .a-span9"
    ],

    // -------------------------
    //  BULLET POINTS
    // -------------------------
    bullets: [
        "#feature-bullets ul li",
        ".a-expander-content ul li",
        ".a-unordered-list .a-list-item",
        "#poExpander ul li"
    ],

    // -------------------------
    //  DESCRIPTIONS
    // -------------------------
    description: [
        "#productDescription p",
        "#productDescription",
        "#aplus_feature_div",
        "#aplus3p_feature_div",
        "#enhanced-product-description",
        ".celwidget .aplus-v2",
        ".aplus",
        "#detailBullets_feature_div"
    ],

    // -------------------------
    //  CATEGORY (Breadcrumbs)
    // -------------------------
    category_path_selector: [
        "#wayfinding-breadcrumbs_feature_div ul li a",
        ".a-breadcrumb .a-list-item a"
    ],

    // -------------------------
    //  PRICING
    // -------------------------
    price: [
        "#corePrice_feature_div .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#price_inside_buybox",
        ".a-price .a-offscreen"
    ],

    list_price: [
        "#listPriceValue",
        "#priceblock_listprice",
        ".a-price.a-text-price .a-offscreen"
    ],

    currency: [
        "[data-asin-currency-code]",
        ".a-price-symbol"
    ],

    // -------------------------
    //  RATINGS
    // -------------------------
    rating_avg: [
        "#acrPopover .a-icon-alt",
        'span[data-hook="rating-out-of-text"]'
    ],

    total_ratings: [
        "#acrCustomerReviewText",
        "#acrCustomerReviewLink span"
    ],

    rating_breakdown: [
        "#histogramTable tr",
        ".a-histogram-row"
    ],

    // -------------------------
    //  MEDIA — IMAGES & VIDEO
    // -------------------------

    //
    // PRIMARY IMAGE (HERO)
    //
    main_image: [
        "#landingImage",
        "#imgTagWrapperId img",
        "#main-image-container img",
        ".dp-main-image-container img",
        "img[data-old-hires]",
        "img[src*='SL'][src*='_AC_']"
    ],

    //
    // GALLERY IMAGES (ALL IMAGES)
    //
    image_gallery: [
        // Classic gallery
        "#altImages img",
        ".imageThumb img",

        // New 2024 UX3 viewer
        "#imageBlock_feature_div img",
        ".iv-gallery img",
        ".iv-image-viewer img",
        ".iv-image-container img",
        "div[data-a-image-name] img",

        // Dynamic images
        ".a-dynamic-image",
        "img[data-a-dynamic-image]",

        // Variant images
        ".twister-plus-swatch img",
        ".swatchSelect img",
        "[data-dp-asin] img",

        // Fallback
        ".apm-centerthirdcol-image img"
    ],

    //
    // VIDEO THUMBNAILS
    //
    video_thumbnails: [
        ".vse-video-grid-item img",
        ".vse-video-player img",
        "li[data-video-url] img",
        ".videoThumbContainer img",
        "img[src*='video']",
        "img[alt*='video']"
    ],

    //
    // VIDEO METADATA BLOCKS
    //
    video_containers: [
        ".vse-video-player",
        ".vse-video-grid-item",
        "div[data-video-id]",
        "div[data-video-url]"
    ],

    // -------------------------
    //  REVIEWS
    // -------------------------
    reviews_link: [
        "a[data-hook='see-all-reviews-link-foot']",
        "a[data-hook='see-all-reviews-link']",
        "#reviews-medley-footer a"
    ],

    reviews: [
        "[data-hook='review']",
        ".review",
        ".a-section.review"
    ],

    review_rating: [
        "[data-hook='review-star-rating'] span.a-icon-alt",
        ".review-rating .a-icon-alt"
    ],

    review_body: [
        "[data-hook='review-body']",
        ".review-text-content span"
    ]
};