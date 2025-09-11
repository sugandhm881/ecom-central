// --- STATE ---
let allOrders = [];
let selectedOrderId = null;
let currentView = 'dashboard';
let activePlatformFilter = 'All';
let activeStatusFilter = 'New';
let activeDatePreset = 'today';
let insightsDatePreset = 'last_7_days';
let currentUser = null; 

// --- CONSTANTS & DOM ELEMENTS ---
let loginView, appView, logoutBtn, navDashboard, navInsights, navSettings,
    dashboardView, insightsView, settingsView, ordersListEl, notificationEl,
    notificationMessageEl, platformFiltersEl, statusFilterEl, datePresetFilterEl,
    customDateContainer, startDateFilterEl, endDateFilterEl, insightsDatePresetFilterEl,
    insightsCustomDateContainer, insightsStartDateFilterEl, insightsEndDateFilterEl,
    dashboardKpiElements, insightsKpiElements, revenueChartCanvas, platformChartCanvas,
    paymentChartCanvas, orderModal, modalBackdrop, modalContent, modalCloseBtn;

let revenueChartInstance, platformChartInstance, paymentChartInstance;

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

// --- HELPER & UTILITY FUNCTIONS ---
function showNotification(message, isError = false) {
    notificationMessageEl.textContent = message;
    notificationEl.className = `fixed top-5 right-5 z-50 text-white py-3 px-5 rounded-lg shadow-xl ${isError ? 'bg-red-500' : 'bg-slate-900'}`;
    notificationEl.classList.add('show');
    setTimeout(() => {
        notificationEl.classList.remove('show');
    }, 3000);
}
const formatCurrency = (amount) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(amount);
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

// --- API CALL FUNCTIONS ---
async function getAuthHeaders() {
    if (!currentUser || !currentUser.token) {
        console.error("No user logged in or token expired.");
        netlifyIdentity.open(); 
        return null;
    }
    return { 'Authorization': `Bearer ${currentUser.token.access_token}` };
}

// --- THIS FUNCTION IS UPDATED ---
async function fetchOrdersFromServer() {
    const headers = await getAuthHeaders();
    if (!headers) return [];

    try {
        const response = await fetch(`/.netlify/functions/get-orders`, { headers });
        
        // Check for authentication errors first
        if (response.status === 401) {
             showNotification("Session expired. Please log in again.", true);
             netlifyIdentity.logout();
             return [];
        }
        
        // Now, explicitly check if the response is successful before parsing
        if (!response.ok) {
            // Try to get a specific error message from the server response
            let errorText = `Failed with status: ${response.status}`;
            try {
                const errData = await response.json();
                errorText = errData.error || JSON.stringify(errData);
            } catch (e) {
                // Ignore if the error response wasn't JSON
            }
            throw new Error(errorText);
        }
        
        // *** FIX: Explicitly parse the JSON from the response ***
        const orders = await response.json();
        return orders;
        
    } catch (error) {
        console.error("Client-side API Error in fetchOrdersFromServer:", error);
        showNotification(`Error: ${error.message}`, true);
        return [];
    }
}


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

    showNotification(`Getting label for order ${orderId}...`);
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
            throw new Error(data.error || "Invalid label data received from server.");
        }
    } catch (error) {
        console.error("API Error getting label link:", error);
        showNotification(`Error: ${error.message}`, true);
    }
}
function handleConnection(platform, action) {
    const connectionIndex = connections.findIndex(c => c.name === platform);
    if (connectionIndex === -1) return;
    if (action === 'connect') {
        showNotification(`Simulating connection to ${platform}...`);
        setTimeout(() => {
            connections[connectionIndex].status = 'Connected';
            switch (platform) {
                case 'Flipkart': connections[connectionIndex].user = 'seller-fk-456'; break;
                case 'Amazon': connections[connectionIndex].user = 'seller-amz-123'; break;
                case 'Shopify': connections[connectionIndex].user = 'my-store.myshopify.com'; break;
            }
            showNotification(`Successfully connected to ${platform}.`);
            renderSettings();
        }, 1500);
    } else if (action === 'disconnect') {
        if (confirm(`Are you sure you want to disconnect from ${platform}?`)) {
            connections[connectionIndex].status = 'Not Connected';
            connections[connectionIndex].user = null;
            showNotification(`Disconnected from ${platform}.`);
            renderSettings();
        }
    }
}

// --- MODAL & UI FUNCTIONS ---
function openOrderModal(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (order) {
        selectedOrderId = order.id;
        renderOrderDetails(order);
        orderModal.classList.remove('modal-hidden');
        orderModal.classList.add('modal-visible');
    }
}
function closeOrderModal() {
    selectedOrderId = null;
    orderModal.classList.add('modal-hidden');
    orderModal.classList.remove('modal-visible');
    renderAllDashboard();
}
function navigate(view) {
    currentView = view;
    document.querySelectorAll('.sidebar-link').forEach(link => link.classList.remove('active'));
    document.getElementById(`nav-${view}`).classList.add('active');
    document.querySelectorAll('main > div[id$="-view"]').forEach(v => v.classList.add('view-hidden'));
    document.getElementById(`${view}-view`).classList.remove('view-hidden');
    if (view === 'dashboard') renderAllDashboard();
    else if (view === 'insights') renderAllInsights();
    else if (view === 'settings') renderSettings();
}

// --- RENDER FUNCTIONS ---
function renderAllDashboard() {
    if (!currentUser) return;
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
function renderAllInsights() {
     if (!currentUser) return;
    const [startDate, endDate] = calculateDateRange(insightsDatePreset, insightsStartDateFilterEl.value, insightsEndDateFilterEl.value);
    let ordersForPeriod = allOrders;
    if (startDate && endDate) {
        ordersForPeriod = allOrders.filter(o => new Date(o.date) >= startDate && new Date(o.date) <= endDate);
    }
    const comparison = calculateComparisonMetrics(ordersForPeriod, allOrders, insightsDatePreset, startDate, endDate);
    updateInsightsKpis(ordersForPeriod, comparison);
    renderInsightCharts(ordersForPeriod, startDate, endDate);
}
function calculateDateRange(preset, startVal, endVal) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let startDate = null;
    let endDate = new Date(); endDate.setHours(23, 59, 59, 999);
    switch(preset) {
        case 'today': startDate = new Date(today); break;
        case 'yesterday':
            startDate = new Date(today); startDate.setDate(today.getDate() - 1);
            endDate = new Date(startDate); endDate.setHours(23, 59, 59, 999);
            break;
        case 'last_7_days': startDate = new Date(today); startDate.setDate(today.getDate() - 6); break;
        case 'mtd': startDate = new Date(today.getFullYear(), today.getMonth(), 1); break;
        case 'last_month':
            startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            endDate = new Date(today.getFullYear(), today.getMonth(), 0); endDate.setHours(23, 59, 59, 999);
            break;
        case 'last_quarter':
            const quarter = Math.floor(today.getMonth() / 3);
            const startOfCurrentQuarter = new Date(today.getFullYear(), quarter * 3, 1);
            startDate = new Date(startOfCurrentQuarter); startDate.setMonth(startDate.getMonth() - 3);
            endDate = new Date(startOfCurrentQuarter); endDate.setDate(endDate.getDate() - 1); endDate.setHours(23, 59, 59, 999);
            break;
        case 'last_year':
            startDate = new Date(today.getFullYear() - 1, 0, 1);
            endDate = new Date(today.getFullYear() - 1, 11, 31); endDate.setHours(23, 59, 59, 999);
            break;
        case 'custom':
            if (startVal) { const [y,m,d] = startVal.split('-'); startDate = new Date(y,m-1,d); startDate.setHours(0,0,0,0); }
            if (endVal) { const [y,m,d] = endVal.split('-'); endDate = new Date(y,m-1,d); endDate.setHours(23, 59, 59, 999); }
            break;
        case 'all_time': default: return [null, null];
    }
    return [startDate, endDate];
}
function calculateComparisonMetrics(currentPeriodOrders, allOrders, preset, currentStartDate, currentEndDate) {
    let prevStartDate, prevEndDate, periodLabel = '';
    if (!currentStartDate || !currentEndDate) return { periodLabel: 'All Time', revenueTrend: '', ordersTrend: '' };
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
        case 'last_quarter':
            prevStartDate = new Date(currentStartDate); prevStartDate.setMonth(currentStartDate.getMonth() - 3);
            prevEndDate = new Date(prevStartDate.getFullYear(), prevStartDate.getMonth() + 3, 0);
            periodLabel = 'vs Previous Quarter';
            break;
        case 'last_year':
            prevStartDate = new Date(currentStartDate); prevStartDate.setFullYear(currentStartDate.getFullYear() - 1);
            prevEndDate = new Date(currentEndDate); prevEndDate.setFullYear(currentEndDate.getFullYear() - 1);
            periodLabel = 'vs Previous Year';
            break;
        default: return { periodLabel: '', revenueTrend: '', ordersTrend: '' };
    }
    prevEndDate.setHours(23, 59, 59, 999);
    const prevPeriodOrders = allOrders.filter(o => new Date(o.date) >= prevStartDate && new Date(o.date) <= prevEndDate);
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
function renderPlatformFilters() {
    const platforms = ['All', 'Amazon', 'Shopify', 'Flipkart'];
    platformFiltersEl.innerHTML = platforms.map(p => `<button data-filter="${p}" class="filter-btn px-3 py-1 text-sm rounded-md ${activePlatformFilter === p ? 'active' : ''}">${p}</button>`).join('');
    platformFiltersEl.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activePlatformFilter = btn.dataset.filter;
            renderAllDashboard();
        });
    });
}
function updateDashboardKpis(ordersToDisplay) { 
    const newCount = ordersToDisplay.filter(o => o.status === 'New').length;
    const processingCount = ordersToDisplay.filter(o => o.status === 'Processing').length;
    const shippedCount = ordersToDisplay.filter(o => o.status === 'Shipped').length;
    const cancelledCount = ordersToDisplay.filter(o => o.status === 'Cancelled').length;
    const renderKpi = (element, title, value, icon) => { element.innerHTML = `<div class="flex items-center">${icon}<p class="text-sm font-medium text-slate-500 ml-2">${title}</p></div><p class="text-3xl font-bold text-slate-800 mt-2">${value}</p>`; };
    renderKpi(dashboardKpiElements.newOrders, 'New Orders', newCount, `<svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>`);
    renderKpi(dashboardKpiElements.processing, 'Processing', processingCount, `<svg class="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`);
    renderKpi(dashboardKpiElements.shipped, 'Shipped', shippedCount, `<svg class="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`);
    renderKpi(dashboardKpiElements.cancelled, 'Cancelled', cancelledCount, `<svg class="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`);
}
function updateInsightsKpis(ordersForPeriod, comparison) {
    const activeOrders = ordersForPeriod.filter(o => o.status !== 'Cancelled');
    const totalRevenue = activeOrders.reduce((sum, order) => sum + order.total, 0);
    const avgOrderValue = activeOrders.length > 0 ? totalRevenue / activeOrders.length : 0;
    const allOrdersCount = ordersForPeriod.length;
    const newCount = ordersForPeriod.filter(o => o.status === 'New').length;
    const shippedCount = ordersForPeriod.filter(o => o.status === 'Shipped').length;
    const processingCount = ordersForPeriod.filter(o => o.status === 'Processing').length;
    const cancelledCount = ordersForPeriod.filter(o => o.status === 'Cancelled').length;
    const renderKpi = (element, title, value, icon, trend, periodLabel) => {
        const trendColor = trend && trend.startsWith('+') ? 'text-green-500' : 'text-red-500';
        element.innerHTML = `<div class="flex items-center">${icon}<p class="text-xs font-medium text-slate-500 ml-2">${title}</p></div><p class="text-2xl font-bold text-slate-800 mt-2">${value}</p>${trend ? `<p class="text-xs ${trendColor} mt-1">${trend} <span class="text-slate-400">${periodLabel}</span></p>` : `<p class="text-xs text-slate-400 mt-1">&nbsp;</p>`}`;
    };
    renderKpi(insightsKpiElements.revenue.el, 'Total Revenue', formatCurrency(totalRevenue), `<svg class="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v.01"></path></svg>`, comparison.revenueTrend, comparison.periodLabel);
    renderKpi(insightsKpiElements.avgValue.el, 'Avg. Value', formatCurrency(avgOrderValue), `<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6l3 6h10a2 2 0 001.79-1.11L21 8M6 18h12a2 2 0 002-2v-5a2 2 0 00-2-2H6a2 2 0 00-2 2v5a2 2 0 002 2z"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.allOrders.el, 'All Orders', allOrdersCount, `<svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>`, comparison.ordersTrend, comparison.periodLabel);
    renderKpi(insightsKpiElements.new.el, 'New Orders', newCount, `<svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.shipped.el, 'Shipped', shippedCount, `<svg class="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17H6V6h11v4l4 4v2h-3zM6 6l6-4l6 4"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.processing.el, 'Processing', processingCount, `<svg class="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`, '', '');
    renderKpi(insightsKpiElements.cancelled.el, 'Cancelled', cancelledCount, `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`, '', '');
}
function renderOrders(ordersToRender) {
    ordersListEl.innerHTML = '';
    if (ordersToRender.length === 0) {
        ordersListEl.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-500">No orders found for the selected filters.</td></tr>`;
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
    const itemsHtml = order.items.map(item => `<div class="flex items-center space-x-4"><img src="${item.image || createFallbackImage(item.name)}" alt="${item.name}" class="w-14 h-14 rounded-lg object-cover bg-slate-200" onerror="this.onerror=null;this.src='${createFallbackImage(item.name)}';"><div class="flex-1"><p class="font-semibold text-slate-900">${item.name}</p><p class="text-sm text-slate-500">SKU: ${item.sku}</p></div><p class="text-sm text-slate-500">x ${item.qty}</p></div>`).join('<hr class="my-3 border-slate-100">');
    const isActionable = order.status !== 'Shipped' && order.status !== 'Cancelled';
    const canProcess = order.status === 'New';
    const canShip = order.status === 'Processing';
    let primaryActionsHtml = '';
    if (canProcess) primaryActionsHtml += `<button id="process-btn" class="flex-1 w-full px-4 py-2.5 bg-yellow-500 text-white font-semibold rounded-lg hover:bg-yellow-600">Mark as Processing</button>`;
    if (canShip) primaryActionsHtml += `<button id="ship-btn" class="flex-1 w-full px-4 py-2.5 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700">Mark as Shipped</button>`;
    modalContent.innerHTML = `<h3 class="text-lg font-semibold text-slate-900 mb-4">Order Details (${order.id})</h3><div class="space-y-4"><div><h4 class="text-sm font-medium text-slate-500 mb-2">Customer</h4><address class="not-italic text-slate-700"><p class="font-semibold">${order.name}</p><p class="text-sm">${order.address}</p></address></div><div><h4 class="text-sm font-medium text-slate-500 mb-2">Items</h4><div class="space-y-3">${itemsHtml}</div></div><div><h4 class="text-sm font-medium text-slate-500 mb-2">Actions</h4><div class="flex items-center gap-2">${primaryActionsHtml}<div class="relative"><button id="actions-menu-btn" class="p-2.5 bg-slate-100 text-slate-600 font-semibold rounded-lg hover:bg-slate-200"><svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg></button><div id="actions-menu" class="hidden absolute right-0 bottom-full mb-2 w-48 bg-white rounded-lg shadow-xl z-10 py-1 border"><a href="#" id="label-btn" class="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-100">Download Label</a>${isActionable ? `<div class="my-1 border-t"></div><a href="#" id="cancel-btn" class="block px-4 py-2 text-sm text-red-600 hover:bg-red-50">Cancel Order</a>` : ''}</div></div></div></div></div>`;
    document.getElementById('process-btn')?.addEventListener('click', () => updateOrderStatusOnServer(order.originalId, order.platform, 'Processing'));
    document.getElementById('ship-btn')?.addEventListener('click', () => updateOrderStatusOnServer(order.originalId, order.platform, 'Shipped'));
    document.getElementById('label-btn')?.addEventListener('click', (e) => { e.preventDefault(); downloadLabelFromServer(order.originalId, order.platform); });
    document.getElementById('cancel-btn')?.addEventListener('click', (e) => { e.preventDefault(); if(confirm(`Cancel order ${order.id}?`)) updateOrderStatusOnServer(order.originalId, order.platform, 'Cancelled'); });
    const menuBtn = document.getElementById('actions-menu-btn');
    menuBtn?.addEventListener('click', () => document.getElementById('actions-menu').classList.toggle('hidden'));
}
function renderSettings() {
    const connectionsEl = document.getElementById('seller-connections');
    connectionsEl.innerHTML = connections.map(c => `<div class="bg-white p-4 rounded-lg shadow-sm flex items-center justify-between"><div class="flex items-center"><img src="${platformLogos[c.name]}" class="w-10 h-10 mr-4"><div><p class="font-semibold text-lg">${c.name}</p><p class="text-sm text-slate-500">${c.status === 'Connected' ? c.user : 'Click to connect'}</p></div></div><button data-platform="${c.name}" data-action="${c.status === 'Connected' ? 'disconnect' : 'connect'}" class="connection-btn ${c.status === 'Connected' ? 'font-medium text-sm text-red-600 hover:text-red-800' : 'font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg'}">${c.status === 'Connected' ? 'Disconnect' : 'Connect'}</button></div>`).join('');
    document.querySelectorAll('.connection-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const platform = e.currentTarget.dataset.platform;
            const action = e.currentTarget.dataset.action;
            handleConnection(platform, action);
        });
    });
}
function renderInsightCharts(orders, startDate, endDate) {
    if (revenueChartInstance) revenueChartInstance.destroy();
    if (platformChartInstance) platformChartInstance.destroy();
    if (paymentChartInstance) paymentChartInstance.destroy();

    let revenueData, revenueLabels;
    const timeDiff = endDate && startDate ? (endDate - startDate) / (1000 * 3600 * 24) : 366;

    if (timeDiff > 90) { 
        const monthlyRevenue = {};
        orders.forEach(o => { if (o.status !== 'Cancelled') {
            const month = new Date(o.date).toISOString().slice(0, 7);
            if (!monthlyRevenue[month]) monthlyRevenue[month] = 0;
            monthlyRevenue[month] += o.total;
        }});
        revenueLabels = Object.keys(monthlyRevenue).sort();
        revenueData = revenueLabels.map(month => monthlyRevenue[month]);
    } else { 
        const dailyRevenue = {};
        if (startDate && endDate) {
            let dateCursor = new Date(startDate);
            while (dateCursor <= endDate) {
                dailyRevenue[dateCursor.toISOString().split('T')[0]] = 0;
                dateCursor.setDate(dateCursor.getDate() + 1);
            }
        }
        orders.forEach(o => { if (o.status !== 'Cancelled') {
            const day = new Date(o.date).toISOString().split('T')[0];
            if (dailyRevenue[day] !== undefined) dailyRevenue[day] += o.total;
        }});
        revenueLabels = Object.keys(dailyRevenue).map(dateStr => new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        revenueData = Object.values(dailyRevenue);
    }
    
    revenueChartInstance = new Chart(revenueChartCanvas, {
        type: 'line',
        data: { labels: revenueLabels, datasets: [{ label: 'Revenue', data: revenueData, borderColor: 'rgb(79, 70, 229)', backgroundColor: 'rgba(79, 70, 229, 0.1)', fill: true, tension: 0.1 }] },
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
            responsive: true, 
            maintainAspectRatio: false, 
            plugins: { 
                title: { display: true, text: 'Prepaid vs. COD' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.raw;
                            const total = context.chart.data.datasets[0].data.reduce((acc, curr) => acc + curr, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) + '%' : '0%';
                            return `${label}: ${value} (${percentage})`;
                        }
                    }
                }
            } 
        }
    });
}

function initializeFilters(isInsights = false) {
    const statusEl = statusFilterEl;
    const dateEl = isInsights ? insightsDatePresetFilterEl : datePresetFilterEl;
    const customContainer = isInsights ? insightsCustomDateContainer : customDateContainer;
    const startEl = isInsights ? insightsStartDateFilterEl : startDateFilterEl;
    const endEl = isInsights ? insightsEndDateFilterEl : endDateFilterEl;

    if (!isInsights) {
        const statuses = ['All Statuses', 'New', 'Processing', 'Shipped', 'Cancelled'];
        statusEl.innerHTML = statuses.map(s => `<option value="${s === 'All Statuses' ? 'All' : s}">${s}</option>`).join('');
        statusEl.value = activeStatusFilter;
        statusEl.addEventListener('change', (e) => { activeStatusFilter = e.target.value; renderAllDashboard(); });
    }

    const datePresets = { 'all_time': 'All Time', 'today': 'Today', 'yesterday': 'Yesterday', 'last_7_days': 'Last 7 Days', 'mtd': 'Month to Date', 'last_month': 'Last Month', 'last_quarter': 'Last Quarter', 'last_year': 'Last Year', 'custom': 'Custom Range...' };
    dateEl.innerHTML = Object.entries(datePresets).map(([key, value]) => `<option value="${key}">${value}</option>`).join('');
    dateEl.value = isInsights ? insightsDatePreset : activeDatePreset;
    
    const dateChangeHandler = () => {
        if (isInsights) {
            insightsDatePreset = dateEl.value;
            customContainer.classList.toggle('hidden', insightsDatePreset !== 'custom');
            if (insightsDatePreset !== 'custom') renderAllInsights();
        } else {
            activeDatePreset = dateEl.value;
            customContainer.classList.toggle('hidden', activeDatePreset !== 'custom');
            if (activeDatePreset !== 'custom') renderAllDashboard();
        }
    };
    dateEl.addEventListener('change', dateChangeHandler);
    startEl.addEventListener('change', isInsights ? renderAllInsights : renderAllDashboard);
    endEl.addEventListener('change', isInsights ? renderAllInsights : renderAllDashboard);
}

async function refreshData() {
    console.log("Auto-refreshing data...");
    try {
        const newOrders = await fetchOrdersFromServer();
        if (newOrders.length === 0 && allOrders.length > 0) return;
        
        if (JSON.stringify(newOrders) !== JSON.stringify(allOrders)) { 
            allOrders = newOrders;
            if (currentView === 'dashboard') renderAllDashboard();
            else if (currentView === 'insights') renderAllInsights();
            showNotification("Order data has been updated.");
        }
    } catch (error) {
        showNotification("Failed to auto-refresh data.", true);
    }
}

async function loadInitialData() {
    initializeFilters(false);
    initializeFilters(true);
    try {
        allOrders = await fetchOrdersFromServer();
        renderAllDashboard();
        setInterval(refreshData, 120000); 
    } catch (error) {
        showNotification('Fatal Error: Could not load initial order data.', true);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // --- INITIALIZE ALL DOM ELEMENT CONSTANTS ---
    loginView = document.getElementById('login-view');
    appView = document.getElementById('app');
    logoutBtn = document.getElementById('logout-btn');
    navDashboard = document.getElementById('nav-dashboard');
    navInsights = document.getElementById('nav-insights');
    navSettings = document.getElementById('nav-settings');
    dashboardView = document.getElementById('dashboard-view');
    insightsView = document.getElementById('insights-view');
    settingsView = document.getElementById('settings-view');
    ordersListEl = document.getElementById('orders-list');
    notificationEl = document.getElementById('notification');
    notificationMessageEl = document.getElementById('notification-message');
    platformFiltersEl = document.getElementById('platform-filters');
    statusFilterEl = document.getElementById('status-filter');
    datePresetFilterEl = document.getElementById('date-preset-filter');
    customDateContainer = document.getElementById('custom-date-container');
    startDateFilterEl = document.getElementById('start-date-filter');
    endDateFilterEl = document.getElementById('end-date-filter');
    insightsDatePresetFilterEl = document.getElementById('insights-date-preset-filter');
    insightsCustomDateContainer = document.getElementById('insights-custom-date-container');
    insightsStartDateFilterEl = document.getElementById('insights-start-date-filter');
    insightsEndDateFilterEl = document.getElementById('insights-end-date-filter');
    dashboardKpiElements = {
        newOrders: document.getElementById('kpi-dashboard-new'),
        shipped: document.getElementById('kpi-dashboard-shipped'),
        processing: document.getElementById('kpi-dashboard-processing'),
        cancelled: document.getElementById('kpi-dashboard-cancelled'),
    };
    insightsKpiElements = {
        revenue: { el: document.getElementById('kpi-insights-revenue') },
        avgValue: { el: document.getElementById('kpi-insights-avg-value') },
        allOrders: { el: document.getElementById('kpi-insights-all-orders') },
        new: { el: document.getElementById('kpi-insights-new') },
        shipped: { el: document.getElementById('kpi-insights-shipped') },
        processing: { el: document.getElementById('kpi-insights-processing') },
        cancelled: { el: document.getElementById('kpi-insights-cancelled') },
    };
    revenueChartCanvas = document.getElementById('revenue-chart');
    platformChartCanvas = document.getElementById('platform-chart');
    paymentChartCanvas = document.getElementById('payment-chart');
    orderModal = document.getElementById('order-modal');
    modalBackdrop = document.getElementById('modal-backdrop');
    modalContent = document.getElementById('modal-content');
    modalCloseBtn = document.getElementById('modal-close-btn');

    // --- AUTHENTICATION & VIEW MANAGEMENT ---
    const showApp = () => {
        loginView.style.display = 'none';
        appView.style.display = 'flex';
    };

    const showLogin = () => {
        loginView.style.display = 'flex';
        appView.style.display = 'none';
    };

    netlifyIdentity.on('login', user => {
        currentUser = user;
        showApp();
        loadInitialData();
    });

    netlifyIdentity.on('logout', () => {
        currentUser = null;
        allOrders = [];
        showLogin();
    });

    netlifyIdentity.on('error', err => console.error('Error with Netlify Identity:', err));

    const user = netlifyIdentity.currentUser();
    if (user) {
        currentUser = user;
        showApp();
        loadInitialData();
    } else {
        showLogin();
    }
    
    // --- GENERAL EVENT LISTENERS ---
    navDashboard.addEventListener('click', (e) => { e.preventDefault(); navigate('dashboard'); });
    navInsights.addEventListener('click', (e) => { e.preventDefault(); navigate('insights'); });
    navSettings.addEventListener('click', (e) => { e.preventDefault(); navigate('settings'); });
    logoutBtn.addEventListener('click', () => netlifyIdentity.logout());

    modalCloseBtn.addEventListener('click', closeOrderModal);
    modalBackdrop.addEventListener('click', closeOrderModal);
});