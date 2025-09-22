// seller-dashboard/public/app.js
// --- STATE ---
let allOrders = [];
let performanceData = [];
let adsetPerformanceData = [];
let selectedOrderId = null;
let currentView = 'orders-dashboard';
let activePlatformFilter = 'All';
let insightsPlatformFilter = 'All'; 
let activeStatusFilter = 'All';
let activeDatePreset = 'today';
let insightsDatePreset = 'last_7_days';
let adPerformanceDatePreset = 'last_7_days';
let adsetDatePreset = 'last_7_days';
let currentUser = null; 

// --- DOM ELEMENTS (to be initialized on DOMContentLoaded) ---
let loginView, appView, logoutBtn, notificationEl, notificationMessageEl;
let navOrdersDashboard, navOrderInsights, navAdPerformance, navAdsetBreakdown, navSettings;
let ordersDashboardView, orderInsightsView, adPerformanceView, adsetBreakdownView, settingsView;
// Orders
let ordersListEl, statusFilterEl, orderDatePresetFilter, customDateContainer, startDateFilterEl, endDateFilterEl, platformFiltersEl,
    dashboardKpiElements, insightsKpiElements, revenueChartCanvas, platformChartCanvas, paymentChartCanvas,
    insightsDatePresetFilter, insightsCustomDateContainer, insightsStartDateFilterEl, insightsEndDateFilterEl,
    insightsPlatformFiltersEl,
    orderModal, modalBackdrop, modalContent, modalCloseBtn;
// Ad Performance
let adDatePresetFilter, adCustomDateContainer, adStartDateFilterEl, adEndDateFilterEl, performanceTableBody, adKpiElements, spendRevenueChartCanvas, orderStatusChartCanvas;
// Ad Set Breakdown
let adsetDatePresetFilter, adsetCustomDateContainer, adsetStartDateFilterEl, adsetEndDateFilterEl, adsetPerformanceTableBody;
    
let revenueChartInstance, platformChartInstance, paymentChartInstance, spendRevenueChartInstance, orderStatusChartInstance;

let connections = [
    { name: 'Amazon', status: 'Connected', user: 'seller-amz-123' },
    { name: 'Shopify', status: 'Connected', user: 'my-store.myshopify.com' },
    { name: 'Flipkart', status: 'Not Connected', user: null },
];
const platformLogos = {
    Amazon: 'https://www.vectorlogo.zone/logos/amazon/amazon-icon.svg',
    Flipkart: 'https://brandeps.com/logo-download/F/Flipkart-logo-vector-01.svg',
    Shopify: 'https://www.vectorlogo.zone/logos/shopify/shopify-icon.svg',
};

// --- HELPER FUNCTIONS ---
function showNotification(message, isError = false) {
    if (notificationMessageEl) {
        notificationMessageEl.textContent = message;
        notificationEl.className = `fixed top-5 right-5 z-50 text-white py-3 px-5 rounded-lg shadow-xl ${isError ? 'bg-red-500' : 'bg-slate-900'}`;
        notificationEl.classList.add('show');
        setTimeout(() => { notificationEl.classList.remove('show'); }, 3000);
    }
}
const formatCurrency = (amount) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(amount);
const formatNumber = (num) => new Intl.NumberFormat('en-IN').format(num);
const formatPercent = (num) => isFinite(num) ? `${(num * 100).toFixed(1)}%` : '0.0%';
function getStatusBadge(status) {
    switch (status) {
        case 'New': return 'bg-blue-100 text-blue-800';
        case 'Processing': return 'bg-yellow-100 text-yellow-800';
        case 'Shipped': return 'bg-green-100 text-green-800';
        case 'Cancelled': return 'bg-slate-200 text-slate-600';
        default: return 'bg-slate-100 text-slate-800';
    }
}
function createFallbackImage(itemName) {
    const initials = itemName.split(' ').map(word => word[0]).join('').substring(0, 2).toUpperCase();
    return `https://placehold.co/100x100/e2e8f0/64748b?text=${initials}`;
}

// --- API FUNCTIONS ---
async function getAuthHeaders() {
    if (!currentUser || !currentUser.token) {
        netlifyIdentity.open();
        return null;
    }
    return { 'Authorization': `Bearer ${currentUser.token.access_token}` };
}

async function fetchApiData(endpoint, errorMessage) {
    const headers = await getAuthHeaders();
    if (!headers) return [];
    try {
        const response = await fetch(endpoint, { headers });
        if (response.status === 401) {
            showNotification("Session expired. Please log in again.", true);
            netlifyIdentity.logout();
            return [];
        }
        if (!response.ok) {
            let errorJson;
            try {
                errorJson = await response.json();
            } catch (e) {
                const errorText = await response.text();
                throw new Error(`Server error ${response.status}: ${errorText}`);
            }
            throw new Error(errorJson.error || `Server error: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Client-side API Error in ${endpoint}:`, error);
        showNotification(errorMessage, true);
        return [];
    }
}

async function fetchBuyerInfoForModal(orderId) {
    const orderIndex = allOrders.findIndex(o => o.id === orderId);
    if (orderIndex === -1) return;

    const order = allOrders[orderIndex];
    order.name = "Loading...";
    renderOrderDetails(order);

    try {
        const data = await fetchApiData(`/.netlify/functions/get-amazon-buyer-info?orderId=${orderId}`, 'Failed to fetch buyer name.');
        
        // Update the name in our central state
        allOrders[orderIndex].name = data.name || "N/A";
        
        // Re-render the modal with the correct name
        renderOrderDetails(allOrders[orderIndex]);

        // === MODIFICATION: Refresh the main dashboard to show the updated name in the list ===
        if (currentView === 'orders-dashboard') {
            renderAllDashboard();
        }

    } catch (error) {
        console.error("Error fetching buyer info:", error);
        allOrders[orderIndex].name = "Error fetching name";
        renderOrderDetails(allOrders[orderIndex]);
    }
}


const fetchOrdersFromServer = () => fetchApiData(`/.netlify/functions/get-orders`, 'Failed to fetch orders.');
const fetchAdPerformanceData = (since, until) => fetchApiData(`/.netlify/functions/get-ad-performance?since=${since}&until=${until}`, 'Failed to fetch ad performance.');
const fetchAdsetPerformanceData = (since, until) => fetchApiData(`/.netlify/functions/get-adset-performance?since=${since}&until=${until}`, 'Failed to fetch ad set performance.');


async function updateOrderStatusOnServer(orderId, platform, newStatus) {
    const headers = await getAuthHeaders();
    if (!headers) return;
    showNotification(`Updating order to ${newStatus}...`);
    try {
        const response = await fetch(`/.netlify/functions/update-status`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: orderId, newStatus: newStatus })
        });
        if (!response.ok) { throw new Error((await response.json()).error); }
        const result = await response.json();
        const orderIndex = allOrders.findIndex(o => o.originalId === orderId);
        if (orderIndex !== -1) allOrders[orderIndex].status = result.newStatus;
        showNotification("Order status updated successfully!");
        renderAllDashboard();
        closeOrderModal();
    } catch (error) {
        console.error("API Error updating status:", error);
        showNotification(`Error: ${error.message}`, true);
    }
}

async function downloadLabelFromServer(orderId, platform) {
    const headers = await getAuthHeaders();
    if (!headers) return;
    showNotification(`Getting label for order...`);
    try {
        const response = await fetch(`/.netlify/functions/get-label-link?orderId=${orderId}`, { headers });
        if (!response.ok) throw new Error("Failed to get label link.");
        
        const data = await response.json();
        if (data.labelData && data.mimeType) {
            const byteCharacters = atob(data.labelData);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: data.mimeType });
            
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `shipping-label-${orderId}.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
            showNotification("Label download started.");
        } else {
            throw new Error(data.error || "Invalid label data received.");
        }
    } catch (error) {
        showNotification(`Error: ${error.message}`, true);
    }
}

// --- NAVIGATION ---
function navigate(view) {
    currentView = view;
    document.querySelectorAll('.sidebar-link').forEach(link => link.classList.remove('active'));
    document.querySelectorAll('main > div').forEach(v => v.classList.add('view-hidden'));
    
    let activeLink, activeView;

    switch(view) {
        case 'orders-dashboard':
            activeLink = navOrdersDashboard; activeView = ordersDashboardView;
            renderAllDashboard();
            break;
        case 'order-insights':
            activeLink = navOrderInsights; activeView = orderInsightsView;
            renderAllInsights();
            break;
        case 'ad-performance':
            activeLink = navAdPerformance; activeView = adPerformanceView;
            handleAdPerformanceDateChange();
            break;
        case 'adset-breakdown':
            activeLink = navAdsetBreakdown; activeView = adsetBreakdownView;
            handleAdsetDateChange();
            break;
        case 'settings':
            activeLink = navSettings; activeView = settingsView;
            renderSettings();
            break;
    }
    
    if (activeLink) activeLink.classList.add('active');
    if (activeView) activeView.classList.remove('view-hidden');
}

// --- AD PERFORMANCE PAGE FUNCTIONS ---
async function handleAdPerformanceDateChange() {
    const [startDate, endDate] = calculateDateRange(adPerformanceDatePreset, adStartDateFilterEl.value, adEndDateFilterEl.value);
    if (startDate && endDate) {
        const since = startDate.toISOString().split('T')[0];
        const until = endDate.toISOString().split('T')[0];
        performanceData = await fetchAdPerformanceData(since, until);
        renderAdPerformancePage();
    }
}

function renderAdPerformancePage() {
    renderDailyPerformance();
    renderAdPerformanceCharts();
}

function renderDailyPerformance() {
    const totals = performanceData.reduce((acc, day) => {
        acc.spend += day.spend; acc.revenue += day.revenue; acc.orders += day.totalOrders;
        acc.delivered += day.deliveredOrders; acc.rto += day.rtoOrders; acc.cancelled += day.cancelledOrders;
        return acc;
    }, { spend: 0, revenue: 0, orders: 0, delivered: 0, rto: 0, cancelled: 0 });
    const roas = totals.spend > 0 ? (totals.revenue / totals.spend) : 0;

    const renderKpi = (el, title, value) => { el.innerHTML = `<p class="text-sm font-medium text-slate-500">${title}</p><p class="text-3xl font-bold text-slate-800 mt-2">${value}</p>`; };
    renderKpi(adKpiElements.totalSpend, 'Total Spend', formatCurrency(totals.spend));
    renderKpi(adKpiElements.totalRevenue, 'Total Revenue', formatCurrency(totals.revenue));
    renderKpi(adKpiElements.roas, 'ROAS', `${roas.toFixed(2)}x`);
    renderKpi(adKpiElements.delivered, 'Delivered', formatNumber(totals.delivered));
    renderKpi(adKpiElements.rto, 'RTO', formatNumber(totals.rto));
    renderKpi(adKpiElements.cancelled, 'Cancelled', formatNumber(totals.cancelled));

    performanceTableBody.innerHTML = '';
    [...performanceData].reverse().forEach(day => {
        const cpo = day.totalOrders > 0 ? (day.spend / day.totalOrders) : 0;
        const roas = day.spend > 0 ? (day.revenue / day.spend) : 0;
        const rtoRate = day.totalOrders > 0 ? (day.rtoOrders / day.totalOrders) : 0;
        performanceTableBody.innerHTML += `
            <tr class="border-b border-slate-100">
                <td class="py-3 px-4 font-medium">${new Date(day.date).toLocaleDateString('en-GB', { day: 'short', month: 'short' })}</td>
                <td class="py-3 px-4 text-right">${formatCurrency(day.spend)}</td>
                <td class="py-3 px-4 text-right">${formatNumber(day.totalOrders)}</td>
                <td class="py-3 px-4 text-right">${formatCurrency(day.revenue)}</td>
                <td class="py-3 px-4 text-right">${formatCurrency(cpo)}</td>
                <td class="py-3 px-4 text-right font-semibold">${roas.toFixed(2)}x</td>
                <td class="py-3 px-4 text-right text-green-600">${formatNumber(day.deliveredOrders)}</td>
                <td class="py-3 px-4 text-right text-red-600">${formatNumber(day.rtoOrders)}</td>
                <td class="py-3 px-4 text-right text-red-600 font-medium">${formatPercent(rtoRate)}</td>
            </tr>`;
    });
}

function renderAdPerformanceCharts() {
    if (spendRevenueChartInstance) spendRevenueChartInstance.destroy();
    if (orderStatusChartInstance) orderStatusChartInstance.destroy();
    
    const labels = performanceData.map(d => new Date(d.date).toLocaleDateString('en-GB', { day: 'short', month: 'short' }));
    spendRevenueChartInstance = new Chart(spendRevenueChartCanvas, {
        type: 'line', data: { labels, datasets: [
                { label: 'Ad Spend', data: performanceData.map(d => d.spend), borderColor: '#ef4444', backgroundColor: '#fee2e2', fill: true, yAxisID: 'y' },
                { label: 'Revenue', data: performanceData.map(d => d.revenue), borderColor: '#22c55e', backgroundColor: '#dcfce7', fill: true, yAxisID: 'y' }
            ]},
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Spend vs. Revenue' } }, scales: { y: { beginAtZero: true } } }
    });

    const totals = performanceData.reduce((acc, day) => {
        acc.delivered += day.deliveredOrders; acc.rto += day.rtoOrders; acc.cancelled += day.cancelledOrders; return acc;
    }, { delivered: 0, rto: 0, cancelled: 0 });

    orderStatusChartInstance = new Chart(orderStatusChartCanvas, {
        type: 'doughnut', data: { labels: ['Delivered', 'RTO', 'Cancelled'], datasets: [{ data: [totals.delivered, totals.rto, totals.cancelled], backgroundColor: ['#22c55e', '#ef4444', '#64748b'] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Order Status Breakdown' } } }
    });
}

// --- AD SET BREAKDOWN DASHBOARD ---
async function handleAdsetDateChange() {
    const [startDate, endDate] = calculateDateRange(adsetDatePreset, adsetStartDateFilterEl.value, adsetEndDateFilterEl.value);
    if (startDate && endDate) {
        const since = startDate.toISOString().split('T')[0];
        const until = endDate.toISOString().split('T')[0];
        adsetPerformanceData = await fetchAdsetPerformanceData(since, until);
        renderAdsetPerformanceDashboard();
    }
}

function renderAdsetPerformanceDashboard() {
    adsetPerformanceTableBody.innerHTML = '';
     if (adsetPerformanceData.length === 0) {
         adsetPerformanceTableBody.innerHTML = `<tr><td colspan="9" class="p-4 text-center text-slate-500">No ad set data. Ensure ads use 'utm_content={{adset.name}}'.</td></tr>`;
         return;
    }
    adsetPerformanceData.forEach(adset => {
        const totalOrders = adset.totalOrders;
        const cpo = totalOrders > 0 ? (adset.spend / totalOrders) : 0;
        const roas = adset.spend > 0 ? (adset.revenue / adset.spend) : 0;
        const rtoRate = totalOrders > 0 ? (adset.rtoOrders / totalOrders) : 0;

        let adsetRow = `<tr class="border-b border-slate-200 bg-slate-50 cursor-pointer" data-adset-id="${adset.id}">
            <td class="py-3 px-4 font-bold text-sm text-slate-800">${adset.name}</td>
            <td class="py-3 px-4 text-right font-bold">${formatCurrency(adset.spend)}</td>
            <td class="py-3 px-4 text-right font-bold">${formatNumber(totalOrders)}</td>
            <td class="py-3 px-4 text-right font-bold text-green-600">${formatNumber(adset.deliveredOrders)}</td>
            <td class="py-3 px-4 text-right font-bold text-red-600">${formatNumber(adset.rtoOrders)}</td>
            <td class="py-3 px-4 text-right font-bold text-slate-500">${formatNumber(adset.cancelledOrders)}</td>
            <td class="py-3 px-4 text-right font-bold text-red-600">${formatPercent(rtoRate)}</td>
            <td class="py-3 px-4 text-right font-bold">${formatCurrency(cpo)}</td>
            <td class="py-3 px-4 text-right font-bold">${roas.toFixed(2)}x</td>
        </tr>`;

        (adset.terms || []).forEach(term => {
            const termTotalOrders = term.totalOrders;
            const termCpo = termTotalOrders > 0 ? (term.spend / termTotalOrders) : 0;
            const termRoas = term.spend > 0 ? (term.revenue / term.spend) : 0;
            const termRtoRate = termTotalOrders > 0 ? (term.rtoOrders / termTotalOrders) : 0;
            adsetRow += `<tr class="adset-term-row hidden border-b border-slate-100" data-parent-adset-id="${adset.id}">
                <td class="py-2 px-8 text-sm text-slate-600">${term.name || term.id}</td>
                <td class="py-2 px-4 text-right text-sm">${formatCurrency(term.spend)}</td>
                <td class="py-2 px-4 text-right text-sm">${formatNumber(termTotalOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-green-600">${formatNumber(term.deliveredOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-red-600">${formatNumber(term.rtoOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-slate-500">${formatNumber(term.cancelledOrders)}</td>
                <td class="py-2 px-4 text-right text-sm text-red-600">${formatPercent(termRtoRate)}</td>
                <td class="py-2 px-4 text-right text-sm">${formatCurrency(termCpo)}</td>
                <td class="py-2 px-4 text-right text-sm">${termRoas.toFixed(2)}x</td>
            </tr>`;
        });

        adsetPerformanceTableBody.innerHTML += adsetRow;
    });

    adsetPerformanceTableBody.querySelectorAll('tr[data-adset-id]').forEach(row => {
        row.addEventListener('click', () => {
            const adsetId = row.dataset.adsetId;
            document.querySelectorAll(`tr[data-parent-adset-id="${adsetId}"]`).forEach(termRow => {
                termRow.classList.toggle('hidden');
            });
        });
    });
}

// --- ORDERS DASHBOARD & INSIGHTS FUNCTIONS ---
function renderAllDashboard() {
    let ordersToRender = [...allOrders];
    const [startDate, endDate] = calculateDateRange(activeDatePreset, startDateFilterEl.value, endDateFilterEl.value);
    if (startDate && endDate) {
        ordersToRender = ordersToRender.filter(o => {
            const orderDate = new Date(o.date);
            return orderDate >= startDate && orderDate <= endDate;
        });
    }
    if (activePlatformFilter !== 'All') ordersToRender = ordersToRender.filter(o => o.platform === activePlatformFilter);
    if (activeStatusFilter !== 'All') ordersToRender = ordersToRender.filter(o => o.status === activeStatusFilter);
    const sortedOrdersToRender = [...ordersToRender].sort((a, b) => new Date(b.date) - new Date(a.date));
    renderPlatformFilters();
    renderOrders(sortedOrdersToRender);
    updateDashboardKpis(ordersToRender); 
}

function renderPlatformFilters() {
    platformFiltersEl.innerHTML = ['All', 'Amazon', 'Shopify', 'Flipkart'].map(p => `<button data-filter="${p}" class="filter-btn px-3 py-1 text-sm rounded-md ${activePlatformFilter === p ? 'active' : ''}">${p}</button>`).join('');
    platformFiltersEl.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => { activePlatformFilter = btn.dataset.filter; renderAllDashboard(); });
    });
}

function renderInsightsPlatformFilters() {
    insightsPlatformFiltersEl.innerHTML = ['All', 'Amazon', 'Shopify', 'Flipkart'].map(p => `<button data-filter="${p}" class="filter-btn px-3 py-1 text-sm rounded-md ${insightsPlatformFilter === p ? 'active' : ''}">${p}</button>`).join('');
    insightsPlatformFiltersEl.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => { insightsPlatformFilter = btn.dataset.filter; renderAllInsights(); });
    });
}

function renderOrders(ordersToRender) {
    ordersListEl.innerHTML = '';
    if (ordersToRender.length === 0) {
        ordersListEl.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">No orders found.</td></tr>`;
        return;
    }
    ordersToRender.forEach(order => {
        const orderRow = document.createElement('tr');
        orderRow.className = `order-row border-b border-slate-100 cursor-pointer`;
        orderRow.dataset.orderId = order.id;
        orderRow.innerHTML = `<td class="p-4"><img src="${platformLogos[order.platform]}" class="w-6 h-6" alt="${order.platform}"></td><td class="p-4 text-slate-600 text-sm">${order.date}</td><td class="p-4 font-semibold text-slate-700">${order.id}</td><td class="p-4 font-medium">${order.name}</td><td class="p-4">${formatCurrency(order.total)}</td><td class="p-4"><span class="px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadge(order.status)}">${order.status}</span></td>`;
        orderRow.addEventListener('click', () => { openOrderModal(order.id); });
        ordersListEl.appendChild(orderRow);
    });
}

function renderOrderDetails(order) {
    const itemsHtml = order.items.map(item => `<div class="flex items-center space-x-4"><img src="${createFallbackImage(item.name)}" alt="${item.name}" class="w-14 h-14 rounded-lg object-cover bg-slate-200"><div class="flex-1"><p class="font-semibold text-slate-900">${item.name}</p><p class="text-sm text-slate-500">SKU: ${item.sku}</p></div><p class="text-sm text-slate-500">x ${item.qty}</p></div>`).join('<hr class="my-3 border-slate-100">');
    const isActionable = order.status !== 'Shipped' && order.status !== 'Cancelled';
    const canProcess = order.status === 'New';
    let primaryActionsHtml = '';
    if (canProcess) primaryActionsHtml += `<button id="process-btn" class="flex-1 w-full px-4 py-2.5 bg-yellow-500 text-white font-semibold rounded-lg hover:bg-yellow-600">Mark as Processing</button>`;
    modalContent.innerHTML = `<h3 class="text-lg font-semibold text-slate-900 mb-4">Order Details (${order.id})</h3><div class="space-y-4"><div><h4 class="text-sm font-medium text-slate-500 mb-2">Customer</h4><address class="not-italic text-slate-700"><p class="font-semibold">${order.name}</p><p class="text-sm">${order.address}</p></address></div><div><h4 class="text-sm font-medium text-slate-500 mb-2">Items</h4><div class="space-y-3">${itemsHtml}</div></div><div><h4 class="text-sm font-medium text-slate-500 mb-2">Actions</h4><div class="flex items-center gap-2">${primaryActionsHtml}<div class="relative"><button id="actions-menu-btn" class="p-2.5 bg-slate-100 text-slate-600 font-semibold rounded-lg hover:bg-slate-200"><svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg></button><div id="actions-menu" class="hidden absolute right-0 bottom-full mb-2 w-48 bg-white rounded-lg shadow-xl z-10 py-1 border"><a href="#" id="label-btn" class="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">Download Label</a>${isActionable ? `<div class="my-1 border-t"></div><a href="#" id="cancel-btn" class="block px-4 py-2 text-sm text-red-600 hover:bg-red-50">Cancel Order</a>` : ''}</div></div></div></div></div>`;
    document.getElementById('process-btn')?.addEventListener('click', () => updateOrderStatusOnServer(order.originalId, order.platform, 'Processing'));
    document.getElementById('label-btn')?.addEventListener('click', (e) => { e.preventDefault(); downloadLabelFromServer(order.originalId, order.platform); });
    document.getElementById('cancel-btn')?.addEventListener('click', (e) => { e.preventDefault(); if(confirm(`Cancel order ${order.id}?`)) updateOrderStatusOnServer(order.originalId, order.platform, 'Cancelled'); });
    document.getElementById('actions-menu-btn')?.addEventListener('click', () => document.getElementById('actions-menu').classList.toggle('hidden'));
}

function openOrderModal(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (order) {
        selectedOrderId = order.id;
        renderOrderDetails(order);
        orderModal.classList.remove('modal-hidden');

        if (order.platform === 'Amazon' && order.name === 'N/A') {
            fetchBuyerInfoForModal(order.id);
        }
    }
}

function closeOrderModal() { orderModal.classList.add('modal-hidden'); }

function renderAllInsights() {
    const [startDate, endDate] = calculateDateRange(insightsDatePreset, insightsStartDateFilterEl.value, insightsEndDateFilterEl.value);
    let ordersForPeriod = [...allOrders];
    if (startDate && endDate) {
        ordersForPeriod = ordersForPeriod.filter(o => {
            const orderDate = new Date(o.date);
            return orderDate >= startDate && orderDate <= endDate;
        });
    }
    if (insightsPlatformFilter !== 'All') {
        ordersForPeriod = ordersForPeriod.filter(o => o.platform === insightsPlatformFilter);
    }
    renderInsightsPlatformFilters();

    const comparison = calculateComparisonMetrics(ordersForPeriod, allOrders, insightsDatePreset, startDate, endDate);
    updateInsightsKpis(ordersForPeriod, comparison);
    renderInsightCharts(ordersForPeriod, startDate, endDate);
}

function calculateDateRange(preset, startVal, endVal) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate = new Date(today);
    let endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);

    switch(preset) {
        case 'today':
            break;
        case 'yesterday':
            startDate.setDate(today.getDate() - 1);
            endDate = new Date(startDate);
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'last_7_days':
            startDate.setDate(today.getDate() - 6);
            break;
        case 'mtd':
            startDate = new Date(today.getFullYear(), today.getMonth(), 1);
            break;
        case 'last_month':
            startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            endDate = new Date(today.getFullYear(), today.getMonth(), 0);
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'custom':
            startDate = startVal ? new Date(startVal) : null;
            if(startDate) startDate.setHours(0,0,0,0);
            endDate = endVal ? new Date(endVal) : null;
            if(endDate) endDate.setHours(23, 59, 59, 999);
            break;
        default:
            return [null, null];
    }
    return [startDate, endDate];
}

function calculateComparisonMetrics(currentPeriodOrders, allOrders, preset, currentStartDate, currentEndDate) {
    let prevStartDate, prevEndDate, periodLabel = '';
    if (!currentStartDate || !currentEndDate) return { periodLabel: '', revenueTrend: '', ordersTrend: '' };
    
    const baseOrderSet = insightsPlatformFilter === 'All' 
        ? allOrders 
        : allOrders.filter(o => o.platform === insightsPlatformFilter);

    switch(preset) {
        case 'last_7_days':
            prevStartDate = new Date(currentStartDate); prevStartDate.setDate(currentStartDate.getDate() - 7);
            prevEndDate = new Date(currentEndDate); prevEndDate.setDate(currentEndDate.getDate() - 7);
            periodLabel = 'vs Previous Week';
            break;
        case 'mtd': case 'last_month':
            prevStartDate = new Date(currentStartDate); prevStartDate.setMonth(currentStartDate.getMonth() - 1);
            prevEndDate = new Date(prevStartDate.getFullYear(), prevStartDate.getMonth() + 1, 0);
            periodLabel = 'vs Previous Month';
            break;
    }
    if (prevStartDate && prevEndDate) {
        prevEndDate.setHours(23, 59, 59, 999);
        const prevPeriodOrders = baseOrderSet.filter(o => {
            const orderDate = new Date(o.date);
            return orderDate >= prevStartDate && orderDate <= prevEndDate;
        });
        const currentRevenue = currentPeriodOrders.filter(o => o.status !== 'Cancelled').reduce((sum, o) => sum + o.total, 0);
        const prevRevenue = prevPeriodOrders.filter(o => o.status !== 'Cancelled').reduce((sum, o) => sum + o.total, 0);
        const calculateTrend = (current, previous) => {
            if (previous === 0) return current > 0 ? '+100%' : '+0%';
            const trend = ((current - previous) / previous) * 100;
            return `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`;
        };
        return {
            periodLabel,
            revenueTrend: calculateTrend(currentRevenue, prevRevenue),
            ordersTrend: calculateTrend(currentPeriodOrders.length, prevPeriodOrders.length)
        };
    }
    return { periodLabel: '', revenueTrend: '', ordersTrend: '' };
}

function updateDashboardKpis(orders) {
    const kpis = { new: 0, processing: 0, shipped: 0, cancelled: 0 };
    orders.forEach(o => {
        if (o.status === 'New') kpis.new++; else if (o.status === 'Processing') kpis.processing++;
        else if (o.status === 'Shipped') kpis.shipped++; else if (o.status === 'Cancelled') kpis.cancelled++;
    });
    const renderKpi = (el, title, val, icon) => { el.innerHTML = `<div class="flex items-center">${icon}<p class="text-sm font-medium text-slate-500 ml-2">${title}</p></div><p class="text-3xl font-bold text-slate-800 mt-2">${val}</p>`; };
    renderKpi(dashboardKpiElements.newOrders, 'New Orders', kpis.new, `<svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>`);
    renderKpi(dashboardKpiElements.processing, 'Processing', kpis.processing, `<svg class="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`);
    renderKpi(dashboardKpiElements.shipped, 'Shipped', kpis.shipped, `<svg class="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`);
    renderKpi(dashboardKpiElements.cancelled, 'Cancelled', kpis.cancelled, `<svg class="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`);
}

function updateInsightsKpis(orders, comparison) {
    const activeOrders = orders.filter(o => o.status !== 'Cancelled');
    const totalRevenue = activeOrders.reduce((sum, order) => sum + order.total, 0);
    const avgOrderValue = activeOrders.length > 0 ? totalRevenue / activeOrders.length : 0;
    const allOrdersCount = orders.length;
    const newCount = orders.filter(o => o.status === 'New').length;
    const shippedCount = orders.filter(o => o.status === 'Shipped').length;
    const rtoCount = orders.filter(o => o.tags && o.tags.toLowerCase().includes('rto')).length;
    const cancelledCount = orders.filter(o => o.status === 'Cancelled').length;
    const renderKpi = (element, title, value, icon, trend, periodLabel) => {
        const trendColor = trend && trend.startsWith('+') ? 'text-green-500' : 'text-red-500';
        element.innerHTML = `<div class="flex items-center">${icon}<p class="text-xs font-medium text-slate-500 ml-2">${title}</p></div><p class="text-2xl font-bold text-slate-800 mt-2">${value}</p>${trend ? `<p class="text-xs ${trendColor} mt-1">${trend} <span class="text-slate-400">${periodLabel}</span></p>` : `<p class="text-xs text-slate-400 mt-1">&nbsp;</p>`}`;
    };
    renderKpi(insightsKpiElements.revenue.el, 'Total Revenue', formatCurrency(totalRevenue), `<svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v.01"></path></svg>`, comparison.revenueTrend, comparison.periodLabel);
    renderKpi(insightsKpiElements.avgValue.el, 'Avg. Value', formatCurrency(avgOrderValue), `<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6l3 6h10a2 2 0 001.79-1.11L21 8M6 18h12a2 2 0 002-2v-5a2 2 0 00-2-2H6a2 2 0 00-2 2v5a2 2 0 002 2z"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.allOrders.el, 'All Orders', allOrdersCount, `<svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>`, comparison.ordersTrend, comparison.periodLabel);
    renderKpi(insightsKpiElements.new.el, 'New Orders', newCount, `<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.shipped.el, 'Shipped', shippedCount, `<svg class="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.rto.el, 'RTO', rtoCount, `<svg class="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 9l-5 5-5-5"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.cancelled.el, 'Cancelled', cancelledCount, `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`, '', '');
}

function renderInsightCharts(orders, startDate, endDate) {
    if (revenueChartInstance) revenueChartInstance.destroy();
    if (platformChartInstance) platformChartInstance.destroy();
    if (paymentChartInstance) paymentChartInstance.destroy();
    const dailyRevenue = {};
    if (startDate && endDate) {
        let dateCursor = new Date(startDate);
        while (dateCursor <= endDate) {
            dailyRevenue[dateCursor.toISOString().split('T')[0]] = 0;
            dateCursor.setDate(dateCursor.getDate() + 1);
        }
    }
    orders.forEach(o => { 
        if (o.status !== 'Cancelled') {
            const day = new Date(o.date).toISOString().split('T')[0];
            if (dailyRevenue[day] !== undefined) dailyRevenue[day] += o.total;
        }
    });
    revenueChartInstance = new Chart(revenueChartCanvas, {
        type: 'line',
        data: { 
            labels: Object.keys(dailyRevenue).map(d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })), 
            datasets: [{ label: 'Revenue', data: Object.values(dailyRevenue), borderColor: 'rgb(79, 70, 229)', backgroundColor: 'rgba(79, 70, 229, 0.1)', fill: true, tension: 0.1 }] 
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Revenue Over Time' } } }
    });
    const platformRevenue = { Shopify: 0, Amazon: 0, Flipkart: 0 };
    orders.forEach(o => { if (o.status !== 'Cancelled' && platformRevenue[o.platform] !== undefined) platformRevenue[o.platform] += o.total; });
    platformChartInstance = new Chart(platformChartCanvas, {
        type: 'doughnut',
        data: { labels: Object.keys(platformRevenue), datasets: [{ data: Object.values(platformRevenue), backgroundColor: ['#96bf48', '#ff9900', '#2874f0'] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Revenue by Platform' } } }
    });
    const paymentCounts = { 'Prepaid': 0, 'COD': 0 };
    orders.forEach(o => { if (o.paymentMethod) paymentCounts[o.paymentMethod]++; });
    paymentChartInstance = new Chart(paymentChartCanvas, {
        type: 'doughnut',
        data: { labels: Object.keys(paymentCounts), datasets: [{ data: Object.values(paymentCounts), backgroundColor: ['#10b981', '#f59e0b'] }] },
        options: { 
            responsive: true, maintainAspectRatio: false, 
            plugins: { 
                title: { display: true, text: 'Prepaid vs. COD' },
                tooltip: { callbacks: { label: (c) => {
                    const total = c.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                    const perc = total > 0 ? ((c.raw / total) * 100).toFixed(1) + '%' : '0%';
                    return `${c.label}: ${c.raw} (${perc})`;
                }}}
            } 
        }
    });
}

function renderSettings() {
    const connectionsEl = document.getElementById('seller-connections');
    connectionsEl.innerHTML = connections.map(c => `<div class="bg-white p-4 rounded-lg shadow-sm flex items-center justify-between"><div class="flex items-center"><img src="${platformLogos[c.name]}" class="w-10 h-10 mr-4"><div><p class="font-semibold text-lg">${c.name}</p><p class="text-sm text-slate-500">${c.status === 'Connected' ? c.user : 'Click to connect'}</p></div></div><button data-platform="${c.name}" data-action="${c.status === 'Connected' ? 'disconnect' : 'connect'}" class="connection-btn ${c.status === 'Connected' ? 'font-medium text-sm text-red-600 hover:text-red-800' : 'font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg'}">${c.status === 'Connected' ? 'Disconnect' : 'Connect'}</button></div>`).join('');
    document.querySelectorAll('.connection-btn').forEach(btn => btn.addEventListener('click', (e) => handleConnection(e.currentTarget.dataset.platform, e.currentTarget.dataset.action)));
}

function handleConnection(platform, action) {
     if (action === 'connect') {
         showNotification(`Simulating connection to ${platform}...`);
         setTimeout(() => { showNotification(`Successfully connected to ${platform}.`); }, 1500);
    } else if (action === 'disconnect') {
         if (confirm(`Are you sure you want to disconnect from ${platform}?`)) {
             showNotification(`Disconnected from ${platform}.`);
         }
    }
}

// --- INITIALIZATION ---
async function loadInitialData() {
    allOrders = await fetchOrdersFromServer();
    initializeAllFilters();
    navigate('orders-dashboard');

    setInterval(async () => {
        if (currentView === 'orders-dashboard' || currentView === 'order-insights') {
            console.log("Refreshing orders...");
            allOrders = await fetchOrdersFromServer();
            if (currentView === 'orders-dashboard') {
                renderAllDashboard();
            } else {
                renderAllInsights();
            }
        }
    }, 120000);
}

function initializeAllFilters() {
    statusFilterEl.innerHTML = ['All Statuses', 'New', 'Processing', 'Shipped', 'Cancelled'].map(s => `<option value="${s === 'All Statuses' ? 'All' : s}">${s}</option>`).join('');
    statusFilterEl.value = activeStatusFilter;
    statusFilterEl.addEventListener('change', (e) => { activeStatusFilter = e.target.value; renderAllDashboard(); });

    const datePresets = { 'today': 'Today', 'yesterday': 'Yesterday', 'last_7_days': 'Last 7 Days', 'mtd': 'Month to Date', 'last_month': 'Last Month', 'custom': 'Custom Range...' };
    
    initializeDateFilters(insightsDatePresetFilter, insightsCustomDateContainer, insightsStartDateFilterEl, insightsEndDateFilterEl, insightsDatePreset, renderAllInsights, datePresets);
    initializeDateFilters(adDatePresetFilter, adCustomDateContainer, adStartDateFilterEl, adEndDateFilterEl, adPerformanceDatePreset, handleAdPerformanceDateChange, datePresets);
    initializeDateFilters(adsetDatePresetFilter, adsetCustomDateContainer, adsetStartDateFilterEl, adsetEndDateFilterEl, adsetDatePreset, handleAdsetDateChange, datePresets);
    initializeDateFilters(orderDatePresetFilter, customDateContainer, startDateFilterEl, endDateFilterEl, activeDatePreset, renderAllDashboard, datePresets);
    
    renderInsightsPlatformFilters();
}

function initializeDateFilters(dateEl, customContainer, startEl, endEl, presetVar, changeHandler, presets) {
    dateEl.innerHTML = Object.entries(presets).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    dateEl.value = presetVar;
    const dateChange = () => {
        const preset = dateEl.value;
        if (dateEl === insightsDatePresetFilter) insightsDatePreset = preset;
        else if (dateEl === adDatePresetFilter) adPerformanceDatePreset = preset;
        else if (dateEl === adsetDatePresetFilter) adsetDatePreset = preset;
        else if (dateEl === orderDatePresetFilter) activeDatePreset = preset;
        customContainer.classList.toggle('hidden', preset !== 'custom');
        changeHandler();
    };
    dateEl.addEventListener('change', dateChange);
    startEl.addEventListener('change', changeHandler);
    endEl.addEventListener('change', changeHandler);
}

document.addEventListener('DOMContentLoaded', () => {
    loginView = document.getElementById('login-view');
    appView = document.getElementById('app');
    logoutBtn = document.getElementById('logout-btn');
    notificationEl = document.getElementById('notification');
    notificationMessageEl = document.getElementById('notification-message');
    navOrdersDashboard = document.getElementById('nav-orders-dashboard');
    navOrderInsights = document.getElementById('nav-order-insights');
    navAdPerformance = document.getElementById('nav-ad-performance');
    navAdsetBreakdown = document.getElementById('nav-adset-breakdown');
    navSettings = document.getElementById('nav-settings');
    ordersDashboardView = document.getElementById('orders-dashboard-view');
    orderInsightsView = document.getElementById('order-insights-view');
    adPerformanceView = document.getElementById('ad-performance-view');
    adsetBreakdownView = document.getElementById('adset-breakdown-view');
    settingsView = document.getElementById('settings-view');
    ordersListEl = document.getElementById('orders-list');
    statusFilterEl = document.getElementById('status-filter');
    orderDatePresetFilter = document.getElementById('order-date-preset-filter');
    customDateContainer = document.getElementById('custom-date-container');
    startDateFilterEl = document.getElementById('start-date-filter');
    endDateFilterEl = document.getElementById('end-date-filter');
    platformFiltersEl = document.getElementById('platform-filters');
    dashboardKpiElements = { newOrders: document.getElementById('kpi-dashboard-new'), processing: document.getElementById('kpi-dashboard-processing'), shipped: document.getElementById('kpi-dashboard-shipped'), cancelled: document.getElementById('kpi-dashboard-cancelled') };
    insightsKpiElements = { revenue: { el: document.getElementById('kpi-insights-revenue') }, avgValue: { el: document.getElementById('kpi-insights-avg-value') }, allOrders: { el: document.getElementById('kpi-insights-all-orders') }, new: { el: document.getElementById('kpi-insights-new') }, shipped: { el: document.getElementById('kpi-insights-shipped') }, rto: { el: document.getElementById('kpi-insights-rto') }, cancelled: { el: document.getElementById('kpi-insights-cancelled') }};
    revenueChartCanvas = document.getElementById('revenue-chart');
    platformChartCanvas = document.getElementById('platform-chart');
    paymentChartCanvas = document.getElementById('payment-chart');
    insightsDatePresetFilter = document.getElementById('insights-date-preset-filter');
    insightsCustomDateContainer = document.getElementById('insights-custom-date-container');
    insightsStartDateFilterEl = document.getElementById('insights-start-date-filter');
    insightsEndDateFilterEl = document.getElementById('insights-end-date-filter');
    insightsPlatformFiltersEl = document.getElementById('insights-platform-filters');
    orderModal = document.getElementById('order-modal');
    modalBackdrop = document.getElementById('modal-backdrop');
    modalContent = document.getElementById('modal-content');
    modalCloseBtn = document.getElementById('modal-close-btn');
    adDatePresetFilter = document.getElementById('ad-date-preset-filter');
    adCustomDateContainer = document.getElementById('ad-custom-date-container');
    adStartDateFilterEl = document.getElementById('ad-start-date-filter');
    adEndDateFilterEl = document.getElementById('ad-end-date-filter');
    performanceTableBody = document.getElementById('performance-table-body');
    adKpiElements = { totalSpend: document.getElementById('kpi-total-spend'), totalRevenue: document.getElementById('kpi-total-revenue'), roas: document.getElementById('kpi-roas'), delivered: document.getElementById('kpi-delivered'), rto: document.getElementById('kpi-rto'), cancelled: document.getElementById('kpi-cancelled') };
    spendRevenueChartCanvas = document.getElementById('spend-revenue-chart');
    orderStatusChartCanvas = document.getElementById('order-status-chart');
    adsetDatePresetFilter = document.getElementById('adset-date-preset-filter');
    adsetCustomDateContainer = document.getElementById('adset-custom-date-container');
    adsetStartDateFilterEl = document.getElementById('adset-start-date-filter');
    adsetEndDateFilterEl = document.getElementById('adset-end-date-filter');
    adsetPerformanceTableBody = document.getElementById('adset-performance-table-body');

    const showApp = () => { loginView.style.display = 'none'; appView.style.display = 'flex'; };
    const showLogin = () => { loginView.style.display = 'flex'; appView.style.display = 'none'; };

    netlifyIdentity.on('login', user => { currentUser = user; showApp(); loadInitialData(); });
    netlifyIdentity.on('logout', () => { currentUser = null; showLogin(); });
    
    const user = netlifyIdentity.currentUser();
    if (user) { currentUser = user; showApp(); loadInitialData(); } 
    else { showLogin(); }
    
    navOrdersDashboard.addEventListener('click', (e) => { e.preventDefault(); navigate('orders-dashboard'); });
    navOrderInsights.addEventListener('click', (e) => { e.preventDefault(); navigate('order-insights'); });
    navAdPerformance.addEventListener('click', (e) => { e.preventDefault(); navigate('ad-performance'); });
    navAdsetBreakdown.addEventListener('click', (e) => { e.preventDefault(); navigate('adset-breakdown'); });
    navSettings.addEventListener('click', (e) => { e.preventDefault(); navigate('settings'); });
    logoutBtn.addEventListener('click', () => netlifyIdentity.logout());
    modalCloseBtn.addEventListener('click', closeOrderModal);
    modalBackdrop.addEventListener('click', closeOrderModal);
});