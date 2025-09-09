// functions/update-status.js

exports.handler = async function(event, context) {
    // Security check: only allow POST requests for updating data
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { SHOPIFY_TOKEN, SHOPIFY_SHOP_URL } = process.env;
    const { orderId, newStatus } = JSON.parse(event.body);

    try {
        let response;
        let successResult;

        // --- NEW LOGIC: Handle different statuses ---

        if (newStatus === 'Processing') {
            console.log(`Processing Order ID: ${orderId}`);
            // To "process" an order, we create a fulfillment in Shopify
            const locationsUrl = `https://${SHOPIFY_SHOP_URL}/admin/api/2024-07/locations.json`;
            const locationsResponse = await fetch(locationsUrl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
            const locationsData = await locationsResponse.json();
            const locationId = locationsData.locations[0].id;

            const fulfillmentUrl = `https://${SHOPIFY_SHOP_URL}/admin/api/2024-07/orders/${orderId}/fulfillments.json`;
            const fulfillmentBody = { fulfillment: { location_id: locationId, notify_customer: false } };

            response = await fetch(fulfillmentUrl, {
                method: 'POST',
                headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(fulfillmentBody)
            });
            
            successResult = { success: true, newStatus: 'Processing' };

        } else if (newStatus === 'Cancelled') {
            console.log(`Cancelling Order ID: ${orderId}`);
            // To "cancel" an order, we call the cancel endpoint
            const cancelUrl = `https://${SHOPIFY_SHOP_URL}/admin/api/2024-07/orders/${orderId}/cancel.json`;
            
            response = await fetch(cancelUrl, {
                method: 'POST',
                headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({}) // Sending an empty body is usually sufficient
            });

            successResult = { success: true, newStatus: 'Cancelled' };

        } else {
            // If the status is something else (like 'Shipped'), return our original error
            throw new Error('This status update is not supported yet.');
        }

        // --- Check Shopify's Response ---
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Shopify API Error (${response.status}): ${errorBody}`);
        }

        console.log(`Successfully updated order ${orderId} to ${newStatus}`);
        return { statusCode: 200, body: JSON.stringify(successResult) };

    } catch (error) {
        console.error("CRITICAL ERROR in update-status function:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};