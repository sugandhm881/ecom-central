// functions/get-orders.js
const fetch = require('node-fetch');
const crypto = require('crypto');

if (process.env.NODE_ENV !== 'production') require('dotenv').config();

// Helper to add a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Amazon Authentication Helpers ---
// NOTE: These helpers are duplicated in get-amazon-buyer-info.js
// In a larger project, you might share them in a separate utility file.

global.lwaToken = null;
global.lwaTokenExp = 0;

function hmac(key, value) {
    return crypto.createHmac('sha256', key).update(value).digest();
}

export default async function handler(req, res) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${process.env.DASHBOARD_API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Your original Shopify/Amazon/RapidShyp call logic here
    res.status(200).json({ success: true, data: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function createSignature(stringToSign, dateStamp, service) {
    const kDate = hmac(`AWS4${process.env.AWS_MYSECRET_KEY}`, dateStamp);
    const kRegion = hmac(kDate, process.env.AWS_MYREGION);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    return hmac(kSigning, stringToSign).toString('hex');
}

function createStringToSign(canonicalRequest, service, amzDate, dateStamp) {
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${process.env.AWS_MYREGION}/${service}/aws4_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    return `${algorithm}\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;
}

function createCanonicalRequest(options, host, amzDate, accessToken) {
    const httpRequestMethod = options.method;
    const canonicalURI = options.path;
    const sortedParams = new URLSearchParams();
    if (options.queryParams) {
        Object.keys(options.queryParams).sort().forEach(key => {
            sortedParams.append(key, options.queryParams[key]);
        });
    }
    const canonicalQueryString = sortedParams.toString();
    const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-access-token;x-amz-date';
    const payloadHash = crypto.createHash('sha256').update(options.body ? JSON.stringify(options.body) : '').digest('hex');
    return `${httpRequestMethod}\n${canonicalURI}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
}

function getAwsSignedHeaders(options, accessToken) {
    const service = 'execute-api';
    const host = new URL(process.env.BASE_URL).hostname;
    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substr(0, 8);
    const canonicalRequest = createCanonicalRequest(options, host, amzDate, accessToken);
    const stringToSign = createStringToSign(canonicalRequest, service, amzDate, dateStamp);
    const signature = createSignature(stringToSign, dateStamp, service);
    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_MYACCESS_KEY}/${dateStamp}/${process.env.AWS_MYREGION}/${service}/aws4_request, SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${signature}`;
    return {
        'x-amz-access-token': accessToken,
        'x-amz-date': amzDate,
        'Authorization': authorizationHeader,
        'Content-Type': 'application/json'
    };
}

async function getLwaAccessToken() {
    if (global.lwaToken && global.lwaTokenExp > Date.now()) {
        return global.lwaToken;
    }
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: process.env.REFRESH_TOKEN,
            client_id: process.env.LWA_CLIENT_ID,
            client_secret: process.env.LWA_CLIENT_SECRET
        })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`LWA token error: ${JSON.stringify(data)}`);
    global.lwaToken = data.access_token;
    global.lwaTokenExp = Date.now() + 50 * 60 * 1000;
    return data.access_token;
}

async function makeSignedApiRequest(options, maxRetries = 5) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            const accessToken = await getLwaAccessToken();
            const awsHeaders = getAwsSignedHeaders(options, accessToken);
            const query = new URLSearchParams(options.queryParams).toString();
            const url = `${process.env.BASE_URL}${options.path}?${query}`;
            const response = await fetch(url, {
                method: options.method,
                headers: awsHeaders,
                body: options.body ? JSON.stringify(options.body) : undefined
            });

            if (response.ok) {
                const text = await response.text();
                return text ? JSON.parse(text) : {};
            }

            if (response.status !== 429) {
                const text = await response.text();
                throw new Error(`Amazon SP-API failed with status ${response.status}: ${text}`);
            }
            
            const error = new Error("Rate limited by API");
            error.status = 429;
            throw error;
        } catch (error) {
            if (error.status === 429) {
                attempt++;
                if (attempt >= maxRetries) {
                    throw new Error(`Max retries exceeded for ${options.path}. The API is still rate-limiting.`);
                }
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
                console.warn(`Rate limited for ${options.path}. Retrying in ${Math.round(delay/1000)}s...`);
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }
}

// ---------------------- Shopify ----------------------
async function fetchShopifyOrders() {
    const { SHOPIFY_TOKEN, SHOPIFY_SHOP_URL } = process.env;
    if (!SHOPIFY_TOKEN || !SHOPIFY_SHOP_URL) return [];
    const now = new Date();
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const createdAtMin = firstDayLastMonth.toISOString();
    const fields = 'id,name,created_at,total_price,financial_status,fulfillment_status,cancelled_at,shipping_address,line_items,tags,refunds';
    let allOrders = [];
    let nextUrl = `https://${SHOPIFY_SHOP_URL}/admin/api/2024-07/orders.json?status=any&limit=250&created_at_min=${createdAtMin}&fields=${fields}`;
    
    while (nextUrl) {
        const response = await fetch(nextUrl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Accept': 'application/json' } });
        if (!response.ok) {
             console.error(`Shopify API Error: ${response.statusText}`);
             break;
        }
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        allOrders = allOrders.concat(data.orders || []);
        const linkHeader = response.headers.get('link');
        nextUrl = null;
        if (linkHeader && linkHeader.includes('rel="next"')) {
            const nextLink = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (nextLink) nextUrl = nextLink[1];
        }
    }
    return allOrders.map(order => {
        let status = "Processing";
        if (order.cancelled_at) status = "Cancelled";
        else if (order.fulfillment_status === 'fulfilled') status = "Shipped";
        else if (!order.fulfillment_status) status = "New";
        const paymentMethod = order.financial_status === 'paid' ? 'Prepaid' : 'COD';
        const totalRefunded = (order.refunds || []).reduce((sum, refund) => sum + (refund.transactions?.reduce((tSum, t) => (t.kind === 'refund' && t.status === 'success' ? tSum + parseFloat(t.amount) : tSum), 0) || 0), 0);
        const netTotal = parseFloat(order.total_price || 0) - totalRefunded;
        return {
            platform: "Shopify", id: order.name, originalId: order.id,
            date: new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
            name: order.shipping_address ? `${order.shipping_address.first_name} ${order.shipping_address.last_name}`.trim() : 'N/A',
            total: netTotal, status: status,
            items: (order.line_items || []).map(item => ({ name: item.name, sku: item.sku || 'N/A', qty: item.quantity })),
            address: order.shipping_address ? `${order.shipping_address.address1 || ''}, ${order.shipping_address.city || ''}`.trim() : 'No address',
            paymentMethod
        };
    });
}

// ---------------------- Amazon ----------------------
function mapAmazonStatus(status) {
    switch (status) {
        case 'Pending': case 'Unshipped': return 'New';
        case 'PartiallyShipped': return 'Processing';
        case 'Shipped': return 'Shipped';
        case 'Canceled': return 'Cancelled';
        default: return 'Processing';
    }
}

async function fetchAmazonOrders() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const createdAfter = thirtyDaysAgo.toISOString();
    let allAmazonOrders = [];
    let nextToken = null;

    try {
        do {
            const queryParams = nextToken ? { NextToken: nextToken } : { MarketplaceIds: process.env.MARKETPLACE_ID, CreatedAfter: createdAfter };
            const options = { method: 'GET', path: '/orders/v0/orders', queryParams };
            const data = await makeSignedApiRequest(options);
            const ordersPayload = data.Orders || data.payload?.Orders || [];
            allAmazonOrders = allAmazonOrders.concat(ordersPayload);
            nextToken = data.NextToken || data.payload?.NextToken;
        } while (nextToken);

        console.log(`✅ Fast fetch complete: ${allAmazonOrders.length} Amazon orders found.`);
        
        return allAmazonOrders.map(order => ({
            platform: "Amazon",
            id: order.AmazonOrderId,
            originalId: order.AmazonOrderId,
            date: new Date(order.PurchaseDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
            name: 'N/A', // Name will be fetched on-demand by the frontend app
            total: parseFloat(order.OrderTotal?.Amount || 0),
            status: mapAmazonStatus(order.OrderStatus),
            items: [],
            address: order.ShippingAddress ? `${order.ShippingAddress.AddressLine1 || ''}, ${order.ShippingAddress.City || ''}`.trim() : 'No address',
            paymentMethod: order.PaymentMethod || 'N/A'
        }));
    } catch (e) {
        console.error("Amazon fetch error:", e.message);
        return [];
    }
}

// ---------------------- Netlify Handler ----------------------
exports.handler = async function(event, context) {
    const { user } = context.clientContext;
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    try {
        const [shopifyOrders, amazonOrders] = await Promise.all([
            fetchShopifyOrders(), 
            fetchAmazonOrders()
        ]);
        
        let allOrders = [...shopifyOrders, ...amazonOrders];
        allOrders.sort((a, b) => new Date(b.date) - new Date(a.date));

        return { statusCode: 200, body: JSON.stringify(allOrders) };
    } catch (err) {
        console.error("CRITICAL ERROR in get-orders:", err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};