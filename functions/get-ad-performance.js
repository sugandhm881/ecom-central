// netlify/functions/get-ad-performance.js
const fetch = require('node-fetch');

// --- Main handler for the Netlify serverless function ---
exports.handler = async function(event, context) {
  console.log("⬥ [get-ad-performance] invoked", { time: new Date().toISOString() });

  const { user } = context.clientContext;
  if (!user) {
    console.warn("⬥ [get-ad-performance] Unauthorized: no user in context");
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  console.log("⬥ [get-ad-performance] Netlify user present:", { id: user.sub || user.user_id || null });

  const {
    SHOPIFY_TOKEN, SHOPIFY_SHOP_URL,
    FACEBOOK_ACCESS_TOKEN, FACEBOOK_AD_ACCOUNT_ID
  } = process.env;

  // env checks
  console.log("⬥ [get-ad-performance] env check:", {
    SHOPIFY_SHOP_URL: !!SHOPIFY_SHOP_URL,
    SHOPIFY_TOKEN: !!SHOPIFY_TOKEN,
    FACEBOOK_ACCESS_TOKEN: !!FACEBOOK_ACCESS_TOKEN,
    FACEBOOK_AD_ACCOUNT_ID: !!FACEBOOK_AD_ACCOUNT_ID
  });

  if (!SHOPIFY_TOKEN || !SHOPIFY_SHOP_URL || !FACEBOOK_ACCESS_TOKEN || !FACEBOOK_AD_ACCOUNT_ID) {
    console.error("⬥ [get-ad-performance] Missing one or more required env vars");
    return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error: API credentials missing." }) };
  }

  const { since, until } = event.queryStringParameters || {};
  console.log("⬥ [get-ad-performance] Query params:", { since, until });

  try {
    const allDates = getDatesBetween(since, until);
    console.log(`⬥ [get-ad-performance] Building daily slots for ${allDates.length} day(s)`);

    const dailyData = {};
    allDates.forEach(dateStr => {
      dailyData[dateStr] = {
        date: dateStr, spend: 0, totalOrders: 0, revenue: 0,
        deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0, inTransitOrders: 0, processingOrders: 0
      };
    });

    // Fetch FB & Shopify in parallel
    console.log("⬥ [get-ad-performance] Fetching Facebook spend and Shopify orders in parallel");
    const [facebookData, shopifyOrders] = await Promise.all([
      getFacebookDailySpend(FACEBOOK_AD_ACCOUNT_ID, FACEBOOK_ACCESS_TOKEN, since, until),
      getShopifyOrders(SHOPIFY_SHOP_URL, SHOPIFY_TOKEN, since)
    ]);

    console.log("⬥ [get-ad-performance] Facebook data keys:", Object.keys(facebookData).length);
    console.log("⬥ [get-ad-performance] Shopify orders count:", shopifyOrders.length);

    // merge facebook spend
    for (const date in facebookData) {
      if (dailyData[date]) {
        dailyData[date].spend = facebookData[date];
      }
    }

    // map shopify orders into dailyData
    shopifyOrders.forEach(order => {
      try {
        const orderDateInIST = new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const slot = dailyData[orderDateInIST];
        if (!slot) return; // order outside requested range
        const orderStatus = getSimulatedLogisticsStatus(order);
        slot.totalOrders++;
        if (orderStatus !== 'Cancelled' && orderStatus !== 'RTO') {
          slot.revenue += parseFloat(order.total_price || 0);
        }
        if (orderStatus === 'Delivered') slot.deliveredOrders++;
        else if (orderStatus === 'RTO') slot.rtoOrders++;
        else if (orderStatus === 'Cancelled') slot.cancelledOrders++;
        else if (orderStatus === 'In-Transit') slot.inTransitOrders++;
        else slot.processingOrders++;
      } catch (orderErr) {
        console.warn("⬥ [get-ad-performance] Skipping order due to error:", orderErr.message);
      }
    });

    const result = Object.values(dailyData).sort((a, b) => new Date(a.date) - new Date(b.date));
    console.log("⬥ [get-ad-performance] returning result", { rows: result.length });

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error("⬥ [get-ad-performance] Error:", error);
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
  console.log("⬥ [get-ad-performance] Facebook Insights URL:", url);
  const response = await fetch(url);
  if (!response.ok) {
    let err;
    try { err = await response.json(); } catch(_) { err = { status: response.status, text: await response.text() }; }
    console.error("⬥ [get-ad-performance] Facebook API Error:", err);
    throw new Error(`Facebook API Error: ${err.error?.message || JSON.stringify(err)}`);
  }
  const body = await response.json();
  console.log("⬥ [get-ad-performance] Facebook insights length:", body.data?.length || 0);
  const spendData = {};
  if (body.data) {
    body.data.forEach(item => {
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
    console.log("⬥ [get-ad-performance] fetching shopify page:", url);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.error("⬥ [get-ad-performance] Shopify API failed:", response.status, text);
      throw new Error(`Shopify API Error: ${response.statusText}`);
    }
    const data = await response.json();
    allOrders = allOrders.concat(data.orders || []);
    const linkHeader = response.headers.get("link");
    url = null;
    if (linkHeader) {
      const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
      if (nextLink) {
        url = nextLink.match(/<([^>]+)>/)[1];
        console.log("⬥ [get-ad-performance] next page found:", url);
      }
    }
  }
  return allOrders;
}

function getSimulatedLogisticsStatus(order) {
  try {
    if (order.cancelled_at) return 'Cancelled';
    if (order.tags && order.tags.toLowerCase().includes('rto')) return 'RTO';
    if (order.fulfillment_status === 'fulfilled') {
      const orderNum = parseInt(order.id.toString().slice(-2));
      if (orderNum < 80) return 'Delivered';
      return 'In-Transit';
    }
    return 'Processing';
  } catch (err) {
    console.warn("⬥ [get-ad-performance] Error determining logistics status:", err.message);
    return 'Processing';
  }
}
