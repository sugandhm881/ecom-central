// functions/test-amazon-api.js
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}
const fetch = require('node-fetch');
const crypto = require('crypto');

exports.handler = async function(event, context) {
    console.log("--- Starting Amazon API Test ---");

    try {
        const accessToken = await getLwaAccessToken();
        console.log("Successfully fetched LWA Access Token.");

        const options = {
            method: 'GET',
            path: `/orders/v0/orders?MarketplaceIds=${process.env.MARKETPLACE_ID}&CreatedAfter=2023-01-01T00:00:00Z`,
            accessToken: accessToken
        };

        const data = await makeSignedApiRequest(options);
        console.log("Successfully fetched Amazon orders:", data.payload.Orders);

        return {
            statusCode: 200,
            body: JSON.stringify(data.payload.Orders, null, 2)
        };
    } catch (error) {
        console.error("--- Amazon API Test FAILED ---", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: error.message,
                stack: error.stack
            })
        };
    }
};

async function getLwaAccessToken() {
    console.log("Attempting to get LWA Access Token...");
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
    if (!response.ok) {
        throw new Error(`Failed to get LWA access token: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.access_token;
}

async function makeSignedApiRequest(options) {
    const awsHeaders = getAwsSignedHeaders(options);
    const url = `${process.env.BASE_URL}${options.path}`;
    
    console.log("Making signed request to URL:", url);

    const response = await fetch(url, {
        method: options.method,
        headers: awsHeaders,
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error("Amazon SP-API Error:", errorBody);
        throw new Error(`Amazon SP-API request failed with status ${response.status}`);
    }

    return await response.json();
}

function getAwsSignedHeaders(options) {
    const service = 'execute-api';
    const host = new URL(process.env.BASE_URL).hostname;
    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substr(0, 8);

    const canonicalRequest = createCanonicalRequest(options, host, amzDate);
    const stringToSign = createStringToSign(canonicalRequest, service, amzDate, dateStamp);
    const signature = createSignature(stringToSign, dateStamp, service);

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY}/${dateStamp}/${process.env.AWS_REGION}/${service}/aws4_request, SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${signature}`;

    return {
        'x-amz-access-token': options.accessToken,
        'x-amz-date': amzDate,
        'Authorization': authorizationHeader,
        'Content-Type': 'application/json'
    };
}

function createCanonicalRequest(options, host, amzDate) {
    const httpRequestMethod = options.method;
    const canonicalURI = options.path;
    const canonicalQueryString = '';
    const canonicalHeaders = `host:${host}\nx-amz-access-token:${options.accessToken}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-access-token;x-amz-date';
    const payloadHash = crypto.createHash('sha256').update(options.body ? JSON.stringify(options.body) : '').digest('hex');

    return `${httpRequestMethod}\n${canonicalURI}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
}

function createStringToSign(canonicalRequest, service, amzDate, dateStamp) {
    const algorithm = 'AWS4-HMAC-SHA256';
    const requestDate = amzDate;
    const credentialScope = `${dateStamp}/${process.env.AWS_REGION}/${service}/aws4_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

    return `${algorithm}\n${requestDate}\n${credentialScope}\n${hashedCanonicalRequest}`;
}

function createSignature(stringToSign, dateStamp, service) {
    const kDate = hmac(`AWS4${process.env.AWS_SECRET_KEY}`, dateStamp);
    const kRegion = hmac(kDate, process.env.AWS_REGION);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    return hmac(kSigning, stringToSign).toString('hex');
}

function hmac(key, value) {
    return crypto.createHmac('sha256', key).update(value).digest();
}