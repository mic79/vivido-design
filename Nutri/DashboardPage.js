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
                console.log('Processing item:', item);
                if (item.lastPurchase && item.location) {  // Using 'location' for price
                    let date;
                    if (item.lastPurchase.includes('-')) {
                        // Handle "16-10-2024 0:00:00" format
                        const [datePart] = item.lastPurchase.split(' ');
                        let [day, month, year] = datePart.split('-');
                        year = adjustYear(year, currentYear);
                        date = new Date(year, month - 1, day);
                    } else if (item.lastPurchase.includes('/')) {
                        // Handle "10/17/2024" format (MM/DD/YYYY)
                        let [month, day, year] = item.lastPurchase.split('/');
                        year = adjustYear(year, currentYear);
                        date = new Date(year, month - 1, day);
                    }

                    if (date && !isNaN(date.getTime())) {
                        const monthYear = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                        const itemCost = parsePrice(item.location);  // Parse price from 'location' field
                        if (!isNaN(itemCost)) {
                            costs[monthYear] = (costs[monthYear] || 0) + itemCost;
                            console.log(`Added ${itemCost} to ${monthYear}. New total: ${costs[monthYear]}`);
                        } else {
                            console.log('Invalid item cost:', item.location);
                        }
                    } else {
                        console.log('Invalid date:', item.lastPurchase);
                    }
                } else {
                    console.log('Missing lastPurchase or location (price):', item);
                }
            });

            console.log('Final costs object:', costs);

            // Sort the entries by date (most recent first)
            const sortedEntries = Object.entries(costs).sort((a, b) => b[0].localeCompare(a[0]));

            console.log('Sorted entries:', sortedEntries);

            // Take the last 12 months (or all if less than 12)
            const last12Months = sortedEntries.slice(0, 12);

            console.log('Last 12 months:', last12Months);

            const today = new Date();
            const currentMonthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
            const currentMonthEntry = last12Months.find(([month]) => month === currentMonthYear);

            let result = last12Months.reverse().map(([month, cost]) => {
                const itemsForMonth = groceryItems.value.filter(item => {
                    const itemDate = new Date(item.lastPurchase);
                    return `${itemDate.getFullYear()}-${String(itemDate.getMonth() + 1).padStart(2, '0')}` === month;
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
                await initializeGoogleAuth();
                const groceriesResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Groceries!A2:H');
                const locationsResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Locations!A2:F');
                
                groceryItems.value = groceriesResponse.values.map(row => ({
                    title: row[0],
                    amount: row[1],
                    price: row[2],
                    location: row[3],
                    date: row[4],
                    id: row[5],
                    checked: row[6] === 'true',
                    lastPurchase: row[7]
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
            toggleExpand
        };
    },
    template: `
        <div class="dashboard-page page-content">
            <div class="header">
                <div class="header-title">
                    <span class="hamburger-menu" @click="toggleSidenav">☰</span>
                    <h2>Dashboard</h2>
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
                                            <th>Date</th>
                                            <th>Item</th>
                                            <th>Price</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="groceryItem in item.items" :key="groceryItem.id">
                                            <td>{{ formatDate(groceryItem.lastPurchase) }}</td>
                                            <td>{{ groceryItem.amount }}</td>
                                            <td>{{ formatPrice(groceryItem.location) }}</td>
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
