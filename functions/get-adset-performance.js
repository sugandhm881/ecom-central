// functions/get-adset-performance.js
const fetch = require('node-fetch');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

// --- MAIN HANDLER ---
exports.handler = async function (event, context) {
    const { user } = context.clientContext;
    if (!user) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const {
        SHOPIFY_TOKEN, SHOPIFY_SHOP_URL,
        FACEBOOK_ACCESS_TOKEN, FACEBOOK_AD_ACCOUNT_ID,
        RAPIDSHYP_API_KEY
    } = process.env;

    if (!SHOPIFY_TOKEN || !SHOPIFY_SHOP_URL || !FACEBOOK_ACCESS_TOKEN || !FACEBOOK_AD_ACCOUNT_ID) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Server configuration error: API credentials missing." })
        };
    }

    // Handle input
    let since, until;
    if (event.httpMethod === "GET") {
        const params = event.queryStringParameters || {};
        since = params.since;
        until = params.until;
    } else if (event.httpMethod === "POST") {
        const body = JSON.parse(event.body || "{}");
        since = body.startDate || body.since;
        until = body.endDate || body.until;
    }

    if (!since || !until) {
        return {
            statusCode: 400,
            headers: corsHeaders(),
            body: JSON.stringify({ error: "Start date and end date are required" })
        };
    }

    try {
        console.log(`🚀 Fetching data for: ${since} to ${until}`);

        const [fbAds, shopifyOrders] = await Promise.all([
            getFacebookAds(FACEBOOK_AD_ACCOUNT_ID, FACEBOOK_ACCESS_TOKEN, since, until),
            getShopifyOrdersWithFulfillments(SHOPIFY_SHOP_URL, SHOPIFY_TOKEN, since)
        ]);

        console.log(`📊 ${fbAds.length} Facebook ads & ${shopifyOrders.length} Shopify orders`);

        // --- RapidShyp statuses ---
        const rapidshypStatuses = await getRealRapidShypStatuses(RAPIDSHYP_API_KEY, shopifyOrders);
        console.log(`📦 RapidShyp statuses: ${Object.keys(rapidshypStatuses).length}`);

        // Build ad map
        const fbAdMap = fbAds.reduce((map, ad) => {
            map[ad.ad_id] = ad;
            return map;
        }, {});

        // Init performance buckets
        const performanceData = {};
        fbAds.forEach(ad => {
            if (!performanceData[ad.adset_id]) {
                performanceData[ad.adset_id] = createEmptyBucket(ad.adset_id, ad.adset_name);
            }
            if (!performanceData[ad.adset_id].terms[ad.ad_id]) {
                performanceData[ad.adset_id].terms[ad.ad_id] = createEmptyBucket(ad.ad_id, ad.ad_name);
                performanceData[ad.adset_id].terms[ad.ad_id].spend = ad.spend;
            }
        });

        const UNATTRIBUTED_ID = 'unattributed';
        performanceData[UNATTRIBUTED_ID] = createEmptyBucket(UNATTRIBUTED_ID, "Unattributed / Organic");
        performanceData[UNATTRIBUTED_ID].terms['unattributed-ad'] = createEmptyBucket('unattributed-ad', 'N/A');

        // Orders list we return
        const enrichedOrders = [];

        // --- Process each order ---
        shopifyOrders.forEach(order => {
            const utmContent = (order.note_attributes || []).find(n => n.name === "utm_content")?.value;
            let matchedAd = null;

            if (utmContent && /^[0-9]+$/.test(utmContent)) {
                matchedAd = fbAdMap[utmContent];
            } else if (utmContent) {
                matchedAd = Object.values(fbAdMap).find(ad =>
                    ad.adset_name.toLowerCase() === utmContent.toLowerCase()
                );
            }

            // Get RapidShyp/Shopify status
            const status = getRealOrderStatus(order, rapidshypStatuses);

            const orderId = order.name.replace('#', '');
            const rapidshypStatusRaw = rapidshypStatuses[orderId]
                ? String(rapidshypStatuses[orderId]).trim().toUpperCase()
                : null;

            order.status = status; // unified status
            order.rapidshypStatus = status === "RTO" ? "RTO" : null;

            enrichedOrders.push({
                id: order.id,
                name: order.name,
                total: parseFloat(order.total_price) || 0,
                status: order.status,
                rapidshypStatus: order.rapidshypStatus
            });

            // Which bucket
            let adsetBucket, termBucket;
            if (matchedAd && performanceData[matchedAd.adset_id]) {
                adsetBucket = performanceData[matchedAd.adset_id];
                termBucket = adsetBucket.terms[matchedAd.ad_id];
            } else {
                adsetBucket = performanceData[UNATTRIBUTED_ID];

                let sourceName = (order.note_attributes || []).find(n => n.name === "utm_source")?.value;
                if (!sourceName) {
                    if (order.referring_site) {
                        if (order.referring_site.includes("facebook")) sourceName = "Facebook";
                        else if (order.referring_site.includes("google")) sourceName = "Google";
                        else if (order.referring_site.includes("instagram")) sourceName = "Instagram";
                        else if (order.referring_site.includes("bing")) sourceName = "Bing";
                        else if (order.referring_site.includes("t.co") || order.referring_site.includes("twitter")) sourceName = "Twitter/X";
                        else sourceName = "Other";
                    } else {
                        sourceName = "direct";
                    }
                }

                if (!adsetBucket.terms[sourceName]) {
                    adsetBucket.terms[sourceName] = createEmptyBucket(sourceName, sourceName);
                }
                termBucket = adsetBucket.terms[sourceName];
            }

            // Update counts
            adsetBucket.totalOrders++;
            termBucket.totalOrders++;

            if (status !== 'Cancelled' && status !== 'RTO') {
                const orderRevenue = parseFloat(order.total_price) || 0;
                adsetBucket.revenue += orderRevenue;
                termBucket.revenue += orderRevenue;
            }

            if (status === 'Delivered') {
                adsetBucket.deliveredOrders++;
                termBucket.deliveredOrders++;
            } else if (status === 'RTO') {
                adsetBucket.rtoOrders++;
                termBucket.rtoOrders++;
            } else if (status === 'Cancelled') {
                adsetBucket.cancelledOrders++;
                termBucket.cancelledOrders++;
            } else if (status === 'In-Transit') {
                adsetBucket.inTransitOrders++;
                termBucket.inTransitOrders++;
            } else if (status === 'Processing') {
                adsetBucket.processingOrders++;
                termBucket.processingOrders++;
            }
        });

        // Calc metrics
        const result = Object.values(performanceData).map(adset => {
            adset.spend = Object.values(adset.terms).reduce((acc, term) => acc + term.spend, 0);
            adset.rtoPercentage = adset.totalOrders > 0
                ? ((adset.rtoOrders / adset.totalOrders) * 100).toFixed(1) : '0.0';
            adset.cpo = adset.totalOrders > 0
                ? (adset.spend / adset.totalOrders).toFixed(2) : '0.00';
            adset.roas = adset.spend > 0
                ? (adset.revenue / adset.spend).toFixed(2) : '0.00';

            adset.terms = Object.values(adset.terms).map(term => {
                term.rtoPercentage = term.totalOrders > 0
                    ? ((term.rtoOrders / term.totalOrders) * 100).toFixed(1) : '0.0';
                term.cpo = term.totalOrders > 0
                    ? (term.spend / term.totalOrders).toFixed(2) : '0.00';
                term.roas = term.spend > 0
                    ? (term.revenue / term.spend).toFixed(2) : '0.00';
                return term;
            });

            return adset;
        }).sort((a, b) => b.spend - a.spend);

        return {
            statusCode: 200,
            headers: corsHeaders(),
            body: JSON.stringify({
                adsetPerformance: result,
                termPerformance: result.flatMap(adset =>
                    adset.terms.map(term => ({
                        ...term,
                        adsetName: adset.name
                    }))
                ),
                orders: enrichedOrders   // 🚀 now available to frontend
            }),
        };

    } catch (err) {
        console.error("❌ ERROR get-adset-performance:", err);
        return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
    }
};

// --- HELPERS ---
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
}
function createEmptyBucket(id, name) {
    return {
        id, name, spend: 0, totalOrders: 0, revenue: 0,
        deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0,
        inTransitOrders: 0, processingOrders: 0, terms: {}
    };
}
function getShopifyFallbackStatus(order) {
    if (order.cancelled_at) return 'Cancelled';
    if (order.fulfillment_status === 'fulfilled') return 'Delivered';
    if (order.fulfillments && order.fulfillments.length > 0) return 'Processing';
    return 'Processing';
}
async function getRealRapidShypStatuses(apiKey, shopifyOrders) {
    if (!apiKey) return {};
    const statuses = {};
    const ordersWithAwbs = shopifyOrders.filter(o => o.awbs && o.awbs.length > 0);
    await Promise.all(ordersWithAwbs.map(async (order) => {
        const awb = order.awbs[0];
        try {
            const trackingInfo = await trackRapidShypByAwb(apiKey, awb);
            if (trackingInfo && trackingInfo.status) {
                const orderId = order.name.replace('#', '');
                statuses[orderId] = trackingInfo.status;
            }
        } catch (err) {
            console.error(`❌ RapidShyp fetch fail ${awb}:`, err.message);
        }
    }));
    return statuses;
}
async function trackRapidShypByAwb(apiKey, awb) {
    const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";
    const headers = { "rapidshyp-token": apiKey, "Content-Type": "application/json" };
    try {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ awb }) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.success && data.records && data.records.length > 0) {
            const shipment = data.records[0].shipment_details[0];
            return {
                awb,
                status: shipment.current_tracking_status_desc || shipment.current_tracking_status,
                statusDate: shipment.current_status_date,
                courier: shipment.courier_name
            };
        }
        return null;
    } catch (err) {
        console.error(`❌ RapidShyp network error AWB ${awb}:`, err.message);
        return null;
    }
}
function getRealOrderStatus(order, rapidshypStatuses) {
    const orderId = order.name.replace('#', '');
    const realStatus = rapidshypStatuses[orderId];
    if (!realStatus) return getShopifyFallbackStatus(order);

    const normalized = String(realStatus).trim().toUpperCase();
    if (normalized.includes("RTO") || normalized.includes("RETURN")) return "RTO";
    if (normalized.includes("DELIVERED") || normalized === "DEL") return "Delivered";
    if (normalized.includes("OFD") || normalized.includes("OUT FOR DELIVERY") || normalized.includes("OUTSCAN")) return "In-Transit";
    if (normalized.includes("TRANSIT") || normalized.includes("DISPATCH") || normalized.includes("SHIPPED")) return "In-Transit";
    if (normalized.includes("PICKUP") || normalized.includes("PUC") || normalized.includes("MANIFEST")) return "Processing";
    if (normalized.includes("CREATED") || normalized.includes("ASSIGNED") || normalized.includes("WEIGHT")) return "Processing";
    if (normalized.includes("UNDELIVERED") || normalized.includes("NDR") || normalized.includes("REATTEMPT")) return "Processing";
    if (normalized.includes("EXCEPTION") || normalized.includes("LOST") || normalized.includes("DAMAGED")) return "Exception";
    if (normalized.includes("CANCEL")) return "Cancelled";
    return "Processing";
}
async function getShopifyOrdersWithFulfillments(shopUrl, token, createdAtMin) {
    let url = `https://${shopUrl}/admin/api/2024-07/orders.json?status=any&limit=250&created_at_min=${createdAtMin}&fields=id,name,note_attributes,cancelled_at,fulfillment_status,total_price,fulfillments`;
    const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
    let allOrders = [];
    while (url) {
        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(`Shopify API Error: ${response.statusText}`);
        const data = await response.json();
        allOrders = allOrders.concat(data.orders);
        const linkHeader = response.headers.get("link");
        url = null;
        if (linkHeader && linkHeader.includes('rel="next"')) {
            const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            url = match ? match[1] : null;
        }
    }
    return allOrders.map(order => {
        const awbs = order.fulfillments?.filter(f => f.tracking_number).map(f => f.tracking_number) || [];
        return { ...order, awbs };
    });
}
async function getFacebookAds(adAccountId, token, since, until) {
    const url = `https://graph.facebook.com/v18.0/act_${adAccountId}/insights?level=ad&fields=ad_id,ad_name,adset_id,adset_name,campaign_name,spend&time_range={'since':'${since}','until':'${until}'}&limit=1000&access_token=${token}`;
    const response = await fetch(url);
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Facebook API Error: ${errorData.error.message}`);
    }
    const { data } = await response.json();
    return (data || []).map(ad => ({ ...ad, spend: parseFloat(ad.spend) || 0 }));
}