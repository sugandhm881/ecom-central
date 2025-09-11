// functions/get-label-link.js

exports.handler = async function(event, context) {
    // --- SECURITY: Protect the function ---
    const { user } = context.clientContext;
    if (!user) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const { RAPIDSHYP_API_KEY, SHOPIFY_TOKEN, SHOPIFY_SHOP_URL } = process.env;
    const { orderId } = event.queryStringParameters;

    if (!orderId) {
        return { statusCode: 400, body: 'Order ID is required.' };
    }

    const RAPIDSHYP_API_URL = 'https://api.rapidshyp.com/rapidshyp/apis/v1/';

    try {
        console.log(`Fetching Shopify order details for internal ID: ${orderId}`);
        const orderDetailsUrl = `https://${SHOPIFY_SHOP_URL}/admin/api/2024-07/orders/${orderId}.json`;
        const shopifyOrderResponse = await fetch(orderDetailsUrl, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Accept': 'application/json' }
        });

        if (!shopifyOrderResponse.ok) {
            throw new Error(`Failed to fetch order details from Shopify: ${await shopifyOrderResponse.text()}`);
        }
        const { order } = await shopifyOrderResponse.json();
        const publicOrderName = order.name;

        console.log(`Fetching label for public order name: ${publicOrderName} from RapidShyp.`);
        
        const response = await fetch(`${RAPIDSHYP_API_URL}labels?order_id=${publicOrderName}`, {
            headers: {
                'Authorization': `Bearer ${RAPIDSHYP_API_KEY}`
            }
        });

        if (!response.ok) {
            throw new Error(`RapidShyp API failed with status ${response.status} for order ${publicOrderName}`);
        }

        const labelBuffer = await response.arrayBuffer();
        const labelData = Buffer.from(labelBuffer).toString('base64');
        const mimeType = response.headers.get('content-type') || 'application/pdf';

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                labelData: labelData,
                mimeType: mimeType
            }),
        };

    } catch(error) {
        console.error("CRITICAL ERROR in get-label-link function:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};