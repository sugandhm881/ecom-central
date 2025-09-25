// functions/get-amazon-buyer-info.js
const fetch = require('node-fetch');
const crypto = require('crypto');

if (process.env.NODE_ENV !== 'production') require('dotenv').config();

// --- Amazon Authentication Helpers (These are required here too) ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
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


exports.handler = async function(event, context) {
    const { user } = context.clientContext;
    if (!user) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const { orderId } = event.queryStringParameters;
    if (!orderId) {
        return { statusCode: 400, body: JSON.stringify({ error: "orderId is required" }) };
    }

    try {
        const options = {
            method: 'GET',
            path: `/orders/v0/orders/${orderId}/buyerInfo`,
            queryParams: {}
        };
        const data = await makeSignedApiRequest(options);
        return {
            statusCode: 200,
            body: JSON.stringify({ name: data.payload?.BuyerName || 'N/A' })
        };
    } catch (error) {
        console.error(`Error fetching buyer info for ${orderId}:`, error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};