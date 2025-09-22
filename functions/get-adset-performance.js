// functions/get-adset-performance.js
const fetch = require('node-fetch');
const querystring = require('querystring');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

// --- HELPER FUNCTIONS ---

// Cleans a string for forgiving matching by lowercasing and removing separators.
function cleanString(str) {
    // This handles spaces, underscores, and different types of dashes (– vs -)
    return str ? str.toLowerCase().replace(/\s|_|–|-/g, "") : "";
}

// Extracts UTM parameters from a URL string.
function parseUTM(url) {
    if (!url) return {};
    const qIndex = url.indexOf("?");
    if (qIndex === -1) return {};
    return querystring.parse(url.substring(qIndex + 1));
}

// --- NEW, MORE RELIABLE MATCHING LOGIC ---
// This function finds the best Ad Set that matches a given Shopify order.
function matchOrderToAdset(order, fbAdsets) {
    const landingSite = (order.landing_site || "").split('?')[0]; // URL without query params
    const utms = parseUTM(order.landing_site);

    // Create a comprehensive list of potential attribution fields from the order
    const searchFields = [
        order.tags,
        (order.note_attributes || []).map(n => `${n.name}:${n.value}`).join(","),
        utms.utm_campaign,
        utms.utm_content, // Adset name is often in utm_content
        utms.utm_term,
        order.source_name,
        landingSite
    ].filter(Boolean); // Filter out any null or empty values

    const cleanedSearchFields = searchFields.map(cleanString);

    // Loop through all Facebook adsets to find a match
    for (const adset of fbAdsets) {
        // We check against both the adset name and the campaign name for better matching
        const cleanedAdsetName = cleanString(adset.adset_name);
        const cleanedCampaignName = cleanString(adset.campaign_name);

        for (const field of cleanedSearchFields) {
            // If the adset name or campaign name is found within any of the order's fields, we have a match
            if (field.includes(cleanedAdsetName) || field.includes(cleanedCampaignName)) {
                return adset; // Return the entire matched adset object
            }
        }
    }

    return null; // Return null if no match is found
}


// --- MAIN HANDLER ---
exports.handler = async function(event, context) {
    const { user } = context.clientContext;
    if (!user) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const {
        SHOPIFY_TOKEN, SHOPIFY_SHOP_URL,
        FACEBOOK_ACCESS_TOKEN, FACEBOOK_AD_ACCOUNT_ID
    } = process.env;
    
    if (!SHOPIFY_TOKEN || !SHOPIFY_SHOP_URL || !FACEBOOK_ACCESS_TOKEN || !FACEBOOK_AD_ACCOUNT_ID) {
        return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error: API credentials missing." }) };
    }

    const { since, until } = event.queryStringParameters;

    try {
        const [fbAdsets, shopifyOrders] = await Promise.all([
            getFacebookAdsets(FACEBOOK_AD_ACCOUNT_ID, FACEBOOK_ACCESS_TOKEN, since, until),
            getShopifyOrders(SHOPIFY_SHOP_URL, SHOPIFY_TOKEN, since)
        ]);
        
        const performanceData = {};

        // Initialize performance data with all adsets from Facebook
        fbAdsets.forEach(adset => {
            performanceData[adset.adset_id] = {
                id: adset.adset_id,
                name: adset.adset_name,
                spend: adset.spend,
                totalOrders: 0, revenue: 0, deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0,
                // The UI expects a 'terms' array, so we create a single entry representing the adset itself.
                terms: [{
                    id: adset.adset_id, name: "Adset Total", spend: adset.spend, totalOrders: 0, 
                    revenue: 0, deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0
                }]
            };
        });

        // Add a bucket for unattributed orders
        const UNATTRIBUTED_ID = 'unattributed';
        performanceData[UNATTRIBUTED_ID] = {
            id: UNATTRIBUTED_ID, name: "Unattributed / Organic", spend: 0, totalOrders: 0, revenue: 0,
            deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0,
            terms: [{
                id: 'unattributed-ad', name: 'N/A', spend: 0, totalOrders: 0, revenue: 0, 
                deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0
            }]
        };

        // --- MAIN ATTRIBUTION LOOP ---
        shopifyOrders.forEach(order => {
            const matchedAdset = matchOrderToAdset(order, fbAdsets);
            const status = getSimulatedLogisticsStatus(order);
            
            let bucket;
            if (matchedAdset && performanceData[matchedAdset.adset_id]) {
                bucket = performanceData[matchedAdset.adset_id];
            } else {
                bucket = performanceData[UNATTRIBUTED_ID];
            }

            // Update the stats in the chosen bucket
            bucket.totalOrders++;
            if (status !== 'Cancelled' && status !== 'RTO') {
                bucket.revenue += parseFloat(order.total_price) || 0;
            }
            if (status === 'Delivered') { bucket.deliveredOrders++; }
            else if (status === 'RTO') { bucket.rtoOrders++; }
            else if (status === 'Cancelled') { bucket.cancelledOrders++; }
        });
        
        // Final data structuring to ensure the 'terms' array reflects the totals
        const result = Object.values(performanceData).map(adset => {
            if (adset.terms[0]) {
                adset.terms[0].totalOrders = adset.totalOrders;
                adset.terms[0].revenue = adset.revenue;
                adset.terms[0].deliveredOrders = adset.deliveredOrders;
                adset.terms[0].rtoOrders = adset.rtoOrders;
                adset.terms[0].cancelledOrders = adset.cancelledOrders;
            }
            return adset;
        }).sort((a, b) => b.spend - a.spend);

        return {
            statusCode: 200,
            body: JSON.stringify(result),
        };

    } catch (error) {
        console.error("CRITICAL ERROR in get-adset-performance function:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};


// --- API Helper Functions ---

// Fetches Adset-level data from Facebook, including the campaign_name for better matching.
async function getFacebookAdsets(adAccountId, token, since, until) {
    const url = `https://graph.facebook.com/v18.0/act_${adAccountId}/insights?level=adset&fields=adset_id,adset_name,campaign_name,spend&time_range={'since':'${since}','until':'${until}'}&limit=1000&access_token=${token}`;
    const response = await fetch(url);
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Facebook API Error: ${errorData.error.message}`);
    }
    const { data } = await response.json();
    return (data || []).map(adset => ({
        ...adset,
        spend: parseFloat(adset.spend) || 0
    }));
}

// Fetches all necessary fields from Shopify for attribution.
async function getShopifyOrders(shopUrl, token, createdAtMin) {
    let url = `https://${shopUrl}/admin/api/2024-07/orders.json?status=any&limit=250&created_at_min=${createdAtMin}&fields=id,name,tags,note_attributes,landing_site,source_name,cancelled_at,fulfillment_status,total_price`;
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
    return allOrders;
}

// Simulates logistics status based on order data.
function getSimulatedLogisticsStatus(order) {
    if (order.cancelled_at) return 'Cancelled';
    if (order.tags && order.tags.toLowerCase().includes('rto')) return 'RTO';
    if (order.fulfillment_status === 'fulfilled') {
        const orderNum = parseInt((order.id || 0).toString().slice(-2));
        if (orderNum < 80) return 'Delivered';
        return 'In-Transit'; 
    }
    return 'Processing';
}