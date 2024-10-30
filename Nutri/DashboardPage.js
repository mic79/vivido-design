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
            console.log('Number of grocery items:', groceryItems.value.length);

            const costs = {};
            const currentYear = new Date().getFullYear();

            groceryItems.value.forEach(item => {
                if (item.dateChecked && item.price) {
                    // Convert the timestamp to a Date object
                    const date = new Date(parseInt(item.dateChecked));
                    if (!isNaN(date.getTime())) {
                        // Use UTC date to match Groceries page behavior
                        const monthYear = date.toISOString().split('T')[0].slice(0, 7); // YYYY-MM format
                        const itemCost = parsePrice(item.price);
                        if (!isNaN(itemCost)) {
                            costs[monthYear] = (costs[monthYear] || 0) + itemCost;
                        } else {
                            console.log('Invalid item cost:', item.price);
                        }
                    } else {
                        console.log('Invalid date:', item.dateChecked);
                    }
                } else {
                    console.log('Missing dateChecked or price:', item);
                }
            });

            console.log('Final costs object:', costs);

            // Sort the entries by date (most recent first)
            const sortedEntries = Object.entries(costs).sort((a, b) => b[0].localeCompare(a[0]));

            // Take the last 12 months (or all if less than 12)
            const last12Months = sortedEntries.slice(0, 12);

            const today = new Date();
            const currentMonthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
            const currentMonthEntry = last12Months.find(([month]) => month === currentMonthYear);

            let result = last12Months.reverse().map(([month, cost]) => {
                const itemsForMonth = groceryItems.value.filter(item => {
                    const itemDate = new Date(parseInt(item.dateChecked, 10)); // Convert EPOCH to Date
                    const itemMonthYear = `${itemDate.getFullYear()}-${String(itemDate.getMonth() + 1).padStart(2, '0')}`;
                    return itemMonthYear === month;
                });

                return {
                    month: month,
                    cost: Number(cost.toFixed(2)),
                    isCurrentMonth: month === currentMonthYear,
                    items: itemsForMonth
                };
            });

            if (currentMonthEntry) {
                const [currentMonth, currentCost] = currentMonthEntry;
                const dayOfMonth = today.getDate();
                const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
                const estimatedMonthTotal = (currentCost / dayOfMonth) * daysInMonth;

                result = result.map(item => 
                    item.isCurrentMonth 
                        ? { ...item, estimatedCost: Number(estimatedMonthTotal.toFixed(2)) }
                        : item
                );
            }

            console.log('Final result with estimate:', result);
            return result;
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

        async function initializeGoogleAuth() {
            try {
                await GoogleAuth.initGoogleAuth();
                console.log('Google Auth initialized in DashboardPage');
            } catch (err) {
                console.error('Failed to initialize Google Auth:', err);
                error.value = 'Failed to initialize Google Auth. Please try refreshing the page.';
            }
        }

        async function fetchData() {
            loading.value = true;
            error.value = null;
            try {
                // Check token validity
                const isValid = await GoogleAuth.isTokenValid();
                if (!isValid) {
                    console.log('Token is not valid, refreshing...');
                    await GoogleAuth.getAccessToken(); // This should refresh the token
                    console.log('Token is now valid');
                }
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
                error.value = 'Failed to fetch data. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        onMounted(fetchData);

        function toggleExpand(month) {
            expandedMonth.value = expandedMonth.value === month ? null : month;
        }

        // New method to calculate location totals
        function getLocationTotals(items) {
            const totals = {};
            
            // Create a map of locations for quick access
            const locationMap = {};
            locations.value.forEach(location => {
                locationMap[location.id] = location.title;
            });

            items.forEach(item => {
                const locationId = item.location;
                const price = parsePrice(item.price);

                if (locationMap[locationId]) {
                    const locationTitle = locationMap[locationId];
                    totals[locationTitle] = (totals[locationTitle] || 0) + price;
                } else {
                    console.log('Location ID not found in locations:', locationId);
                }
            });

            // Convert the totals object to an array of [location, total] pairs
            const sortedTotals = Object.entries(totals)
                .sort((a, b) => b[1] - a[1]); // Sort by total price in descending order

            return sortedTotals;
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
                        <div v-for="item in monthlyCosts" :key="item.month" class="bar-container">
                            <div class="bar" 
                                :style="{ width: (item.cost / maxMonthlyCost * 100) + '%' }"
                                @click="toggleExpand(item.month)">
                            </div>
                            <div v-if="item.isCurrentMonth && item.estimatedCost" 
                                class="bar estimated" 
                                :style="{ width: (item.estimatedCost / maxMonthlyCost * 100) + '%' }">
                            </div>
                            <span class="bar-label">
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
                                        <tr v-for="[location, total] in getLocationTotals(item.items)" :key="location">
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
