// functions/get-orders.js

exports.handler = async function(event, context) {
    // --- SECURITY: Protect the function ---
    const { user } = context.clientContext;
    if (!user) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    console.log("Function 'get-orders' started (v6 - Net Revenue Fix).");
    const { SHOPIFY_TOKEN, SHOPIFY_SHOP_URL } = process.env;

    if (!SHOPIFY_TOKEN || !SHOPIFY_SHOP_URL) {
        return { statusCode: 500, body: JSON.stringify({ error: "API credentials are not configured." }) };
    }

    const shopifyApiUrl = `https://${SHOPIFY_SHOP_URL}/admin/api/2024-07/orders.json?status=any&limit=250&order=created_at desc`;
    
    let allOrders = [];
    let pageCount = 0;
    let nextUrl = shopifyApiUrl;

    try {
        while (nextUrl && pageCount < 100) { 
            const response = await fetch(nextUrl, {
                headers: { 
                    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                    'Accept': 'application/json' 
                }
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Shopify API Error: ${response.status} - ${errorBody}`);
            }

            const data = await response.json();
            allOrders = allOrders.concat(data.orders);

            const linkHeader = response.headers.get('link');
            nextUrl = null;
            if (linkHeader) {
                const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
                if (nextLink) {
                    nextUrl = nextLink.match(/<([^>]+)>/)[1];
                }
            }
            pageCount++;
        }
        
        console.log(`Finished fetching. Total orders found: ${allOrders.length}`);

        const formattedOrders = allOrders.map(order => {
            let status = "Processing";
            if (order.cancelled_at) status = "Cancelled";
            else if (order.fulfillment_status === 'fulfilled') status = "Shipped";
            else if (!order.fulfillment_status) status = "New";

            const paymentMethod = order.financial_status === 'paid' ? 'Prepaid' : 'COD';
            
            const totalRefunded = order.refunds.reduce((refundSum, refund) => {
                const transactionTotal = refund.transactions.reduce((transactionSum, transaction) => {
                    if (transaction.kind === 'refund' && transaction.status === 'success') {
                        return transactionSum + parseFloat(transaction.amount);
                    }
                    return transactionSum;
                }, 0);
                return refundSum + transactionTotal;
            }, 0);

            const netTotal = parseFloat(order.total_price) - totalRefunded;

            return {
                platform: "Shopify",
                id: order.name,
                originalId: order.id,
                date: order.created_at.split('T')[0],
                name: order.shipping_address ? `${order.shipping_address.first_name} ${order.shipping_address.last_name}`.trim() : 'N/A',
                total: netTotal,
                status: status,
                items: order.line_items.map(item => ({ name: item.name, sku: item.sku || 'N/A', qty: item.quantity, image: null })),
                address: order.shipping_address ? `${order.shipping_address.address1}, ${order.shipping_address.city}` : 'No address',
                paymentMethod: paymentMethod
            }
        });

        return { statusCode: 200, body: JSON.stringify(formattedOrders) };

    } catch (error) {
        console.error("CRITICAL ERROR in get-orders function:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};