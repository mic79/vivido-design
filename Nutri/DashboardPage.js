import GoogleAuth from './googleAuth.js';

const { ref, computed, onMounted } = Vue;

export const DashboardPage = {
    props: ['sheetId', 'toggleSidenav'],
    setup(props) {
        const loading = ref(true);
        const error = ref(null);
        const groceryItems = ref([]);
        const locations = ref([]);
        const expandedMonth = ref(null);

        // Make error ref accessible globally for testing
        if (!window.pageRefs) {
            window.pageRefs = {};
        }
        window.pageRefs.groceries = { error };

        function adjustYear(year, currentYear) {
            year = parseInt(year);
            if (year > currentYear + 1) {
                return year - 100; // Adjust if more than 1 year in the future
            }
            return year;
        }

        const itemsPerLocation = computed(() => {
            const counts = {};
            groceryItems.value.forEach(item => {
                counts[item.location] = (counts[item.location] || 0) + 1;
            });
            return Object.entries(counts).map(([location, count]) => ({ location, count }));
        });

        const topItems = computed(() => {
            const counts = {};
            groceryItems.value.forEach(item => {
                counts[item.title] = (counts[item.title] || 0) + 1;
            });
            return Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([title, count]) => ({ title, count }));
        });

        function parsePrice(priceString) {
            // Replace comma with dot for parsing if comma is present
            return parseFloat(priceString.replace(',', '.'));
        }

        const monthlyCosts = computed(() => {
            console.log('Starting monthlyCosts calculation');
            
            const costs = {};
            const today = new Date();
            const currentMonthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
            
            // First pass: Calculate actual costs for all months
            groceryItems.value.forEach(item => {
                if (item.dateChecked && item.price) {
                    const date = new Date(parseInt(item.dateChecked));
                    if (!isNaN(date.getTime())) {
                        const monthYear = date.toISOString().split('T')[0].slice(0, 7);
                        const itemCost = parsePrice(item.price);
                        if (!isNaN(itemCost)) {
                            costs[monthYear] = (costs[monthYear] || 0) + itemCost;
                        }
                    }
                }
            });

            // Sort and get last 4 months (3 for pattern + current)
            const sortedEntries = Object.entries(costs)
                .sort((a, b) => b[0].localeCompare(a[0]))
                .slice(0, 4);

            // Calculate average daily spending from last 3 months
            const dailyAverage = sortedEntries
                .slice(1, 4) // Skip current month, take next 3
                .reduce((total, [monthYear, cost]) => {
                    const [year, month] = monthYear.split('-');
                    const daysInMonth = new Date(year, month, 0).getDate();
                    return total + (cost / daysInMonth);
                }, 0) / 3; // Divide by 3 to get average

            // Take last 12 months for display
            const last12Months = Object.entries(costs)
                .sort((a, b) => b[0].localeCompare(a[0]))
                .slice(0, 12)
                .reverse()
                .map(([month, cost]) => ({
                    month,
                    cost: Number(cost.toFixed(2)),
                    isCurrentMonth: month === currentMonthYear
                }));

            // Calculate estimated cost for current month
            if (last12Months.find(item => item.isCurrentMonth)) {
                const currentDayOfMonth = today.getDate();
                const daysInCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
                const currentMonthData = last12Months.find(item => item.isCurrentMonth);
                
                // Calculate remaining days' estimated spending
                const remainingDays = daysInCurrentMonth - currentDayOfMonth;
                const estimatedTotal = currentMonthData.cost + (dailyAverage * remainingDays);

                last12Months.forEach(item => {
                    if (item.isCurrentMonth) {
                        item.estimatedCost = Number(estimatedTotal.toFixed(2));
                    }
                });
            }

            return last12Months;
        });

        const maxMonthlyCost = computed(() => {
            return Math.max(...monthlyCosts.value.map(item => Math.max(item.cost, item.estimatedCost || 0)));
        });

        function formatPrice(price) {
            if (typeof price === 'string') {
                // If the price is already a string, assume it's in the correct format
                return price;
            }
            // If it's a number, format it with comma as decimal separator
            return price.toFixed(2).replace('.', ',');
        }

        function formatDate(dateString) {
            const date = new Date(dateString);
            return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        }

        async function fetchData() {
            loading.value = true;
            error.value = null;
            try {
                const groceriesResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Groceries!A2:H');
                const locationsResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Locations!A2:F');
                
                groceryItems.value = groceriesResponse.values.map(row => ({
                    id: row[0],
                    title: row[1],
                    amount: row[2],
                    price: row[3],
                    order: row[4],
                    location: row[5],
                    dateChecked: row[6], // Changed from date_checked to dateChecked
                    date: row[7],
                    locationTitle: row[8]
                }));

                locations.value = locationsResponse.values.map(row => ({
                    title: row[0],
                    order: parseInt(row[1]),
                    id: row[2],
                    hidden: row[3] === 'true',
                    city: row[4] || ''
                }));
            } catch (err) {
                console.error('Error fetching data:', err);
                error.value = err.isRateLimit ? err.message : 'Failed to fetch data. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        onMounted(fetchData);

        function toggleExpand(month) {
            expandedMonth.value = expandedMonth.value === month ? null : month;
        }

        // New method to calculate location totals
        function getLocationTotals(monthYear) {
            const totals = {};
            
            // Create a map of locations for quick access
            const locationMap = {};
            locations.value.forEach(location => {
                locationMap[location.id] = location.title;
            });

            // Filter items for the given month using the same logic as monthlyCosts
            groceryItems.value.forEach(item => {
                if (item.dateChecked && item.price) {
                    const date = new Date(parseInt(item.dateChecked));
                    if (!isNaN(date.getTime())) {
                        const itemMonthYear = date.toISOString().split('T')[0].slice(0, 7); // YYYY-MM format
                        if (itemMonthYear === monthYear) {
                            const locationId = item.location;
                            const price = parsePrice(item.price);
                            if (!isNaN(price) && locationMap[locationId]) {
                                const locationTitle = locationMap[locationId];
                                totals[locationTitle] = (totals[locationTitle] || 0) + price;
                            }
                        }
                    }
                }
            });

            return Object.entries(totals)
                .sort((a, b) => b[1] - a[1])
                .map(([location, total]) => [location, Number(total.toFixed(2))]);
        }

        return {
            loading,
            error,
            itemsPerLocation,
            topItems,
            locations,
            monthlyCosts,
            maxMonthlyCost,
            formatPrice,
            formatDate,
            expandedMonth,
            toggleExpand,
            getLocationTotals,
            fetchData
        };
    },
    template: `
        <div class="dashboard-page page-content">
            <div class="header">
                <div class="header-title">
                    <span class="hamburger-menu" @click="toggleSidenav">☰</span>
                    <h2>Dashboard <button @click="fetchData"><i class="icon material-icons" style="font-size: 14px;">refresh</i></button></h2>
                    <small v-if="loading" class="loading">Loading...</small>
                    <div v-else-if="error" class="error">{{ error }}</div>
                </div>
            </div>
            <div class="dashboard-content">
                <div class="chart monthly-costs">
                    <h3>Monthly Grocery Costs</h3>
                    <div class="chart-container">
                        <div v-for="item in monthlyCosts" 
                            :key="item.month" 
                            class="bar-container" 
                            :class="{ 'expanded': expandedMonth === item.month }"
                            @click="toggleExpand(item.month)">
                            <div class="bar" :style="{ width: (item.cost / maxMonthlyCost * 100) + '%' }"></div>
                            <div v-if="item.isCurrentMonth && item.estimatedCost" 
                                class="bar estimated" 
                                :style="{ width: (item.estimatedCost / maxMonthlyCost * 100) + '%' }">
                            </div>
                            <span class="bar-label">
                                <span class="material-icons">
                                    {{ expandedMonth === item.month ? 'arrow_drop_up' : 'arrow_drop_down' }}
                                </span>
                                {{ item.month }}&nbsp;&nbsp;&nbsp;&nbsp;<strong>{{ formatPrice(item.cost) }}</strong>&nbsp;&nbsp;&nbsp;&nbsp;
                                <span v-if="item.isCurrentMonth && item.estimatedCost">
                                    (Est. {{ formatPrice(item.estimatedCost) }})
                                </span>
                            </span>
                            <div v-if="expandedMonth === item.month" class="expanded-details">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Location</th>
                                            <th>Total Price</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="[location, total] in getLocationTotals(item.month)" :key="location">
                                            <td>{{ location }}</td>
                                            <td>{{ formatPrice(total) }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `
};

export default DashboardPage;
