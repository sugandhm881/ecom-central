// functions/get-label-link.js

exports.handler = async function(event, context) {
    const { SHOPIFY_SHOP_URL } = process.env;
    const { orderId } = event.queryStringParameters; // Get orderId from URL

    if (!orderId) {
        return { statusCode: 400, body: 'Order ID is required.' };
    }

    // Construct the direct link to the Shopify order page
    const adminUrl = `https://${SHOPIFY_SHOP_URL.replace('.myshopify.com', '')}.myshopify.com/admin/orders/${orderId}`;
    
    // Send the link back to the frontend
    return {
        statusCode: 200,
        body: JSON.stringify({ labelUrl: adminUrl }),
    };
};