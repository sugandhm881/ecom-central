const fetch = require('node-fetch');

// --- Main handler for the Netlify serverless function ---
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
        const allDates = getDatesBetween(since, until);
        const dailyData = {};
        allDates.forEach(dateStr => {
            dailyData[dateStr] = {
                date: dateStr, spend: 0, totalOrders: 0, revenue: 0,
                deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0
            };
        });

        const [facebookData, shopifyOrders] = await Promise.all([
            getFacebookDailySpend(FACEBOOK_AD_ACCOUNT_ID, FACEBOOK_ACCESS_TOKEN, since, until),
            getShopifyOrders(SHOPIFY_SHOP_URL, SHOPIFY_TOKEN, since) 
        ]);

        for (const date in facebookData) {
            if (dailyData[date]) {
                dailyData[date].spend = facebookData[date];
            }
        }

        shopifyOrders.forEach(order => {
            const orderDateInIST = new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            
            if (dailyData[orderDateInIST]) {
                const orderStatus = getSimulatedLogisticsStatus(order);
                dailyData[orderDateInIST].totalOrders++;
                
                if (orderStatus !== 'Cancelled' && orderStatus !== 'RTO') {
                     dailyData[orderDateInIST].revenue += parseFloat(order.total_price);
                }

                if (orderStatus === 'Delivered') dailyData[orderDateInIST].deliveredOrders++;
                else if (orderStatus === 'RTO') dailyData[orderDateInIST].rtoOrders++;
                else if (orderStatus === 'Cancelled') dailyData[orderDateInIST].cancelledOrders++;
            }
        });
        
        const result = Object.values(dailyData).sort((a, b) => new Date(a.date) - new Date(b.date));

        return {
            statusCode: 200,
            body: JSON.stringify(result),
        };

    } catch (error) {
        console.error("Error in get-ad-performance function:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};

function getDatesBetween(startDate, endDate) {
    const dates = [];
    let currentDate = new Date(startDate);
    const end = new Date(endDate);
    while (currentDate <= end) {
        dates.push(currentDate.toISOString().split('T')[0]);
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dates;
}

async function getFacebookDailySpend(adAccountId, token, since, until) {
    const url = `https://graph.facebook.com/v18.0/act_${adAccountId}/insights?time_range={'since':'${since}','until':'${until}'}&time_increment=1&fields=spend,date_start&access_token=${token}`;
    const response = await fetch(url);
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Facebook API Error: ${errorData.error.message}`);
    }
    const { data } = await response.json();
    const spendData = {};
    if (data) {
        data.forEach(item => {
            spendData[item.date_start] = parseFloat(item.spend) || 0;
        });
    }
    return spendData;
}

async function getShopifyOrders(shopUrl, token, createdAtMin) {
    let allOrders = [];
    let url = `https://${shopUrl}/admin/api/2024-07/orders.json?status=any&limit=250&created_at_min=${createdAtMin}`;
    const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };

    while (url) {
        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(`Shopify API Error: ${response.statusText}`);
        const data = await response.json();
        allOrders = allOrders.concat(data.orders);
        const linkHeader = response.headers.get("link");
        url = null;
        if (linkHeader) {
            const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
            if (nextLink) {
                url = nextLink.match(/<([^>]+)>/)[1];
            }
        }
    }
    return allOrders;
}

function getSimulatedLogisticsStatus(order) {
    if (order.cancelled_at) return 'Cancelled';
    if (order.tags && order.tags.toLowerCase().includes('rto')) return 'RTO';
    if (order.fulfillment_status === 'fulfilled') {
        const orderNum = parseInt(order.id.toString().slice(-2));
        if (orderNum < 80) return 'Delivered';
        return 'In-Transit'; 
    }
    return 'Processing';
}