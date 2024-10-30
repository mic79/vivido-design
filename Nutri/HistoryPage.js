import GoogleAuth from './googleAuth.js';

const { ref, computed, onMounted } = Vue;

export const HistoryPage = {
    props: ['sheetId', 'toggleSidenav'],
    setup(props) {
        const historyItems = ref([]);
        const loading = ref(false);
        const error = ref(null);
        const columns = ['title', 'amount', 'price', 'date', 'location'];
        const filters = ref({ title: '', amount: '', price: '', date: '', location: '' });
        const sortKey = ref('date');
        const sortOrder = ref('desc');
        const currentPage = ref(1);
        const itemsPerPage = ref(50);

        const sortedAndFilteredHistory = computed(() => {
            let result = historyItems.value;

            // Apply filters
            columns.forEach(column => {
                if (filters.value[column]) {
                    result = result.filter(item => 
                        String(item[column]).toLowerCase().includes(filters.value[column].toLowerCase())
                    );
                }
            });

            // Apply sorting
            result.sort((a, b) => {
                let modifier = sortOrder.value === 'desc' ? -1 : 1;
                if (a[sortKey.value] < b[sortKey.value]) return -1 * modifier;
                if (a[sortKey.value] > b[sortKey.value]) return 1 * modifier;
                return 0;
            });

            return result;
        });

        const paginatedHistory = computed(() => {
            const startIndex = (currentPage.value - 1) * itemsPerPage.value;
            return sortedAndFilteredHistory.value.slice(startIndex, startIndex + itemsPerPage.value);
        });

        const totalPages = computed(() => Math.ceil(sortedAndFilteredHistory.value.length / itemsPerPage.value));

        function applyFilters() {
            currentPage.value = 1; // Reset to first page when filters change
        }

        function sortBy(key) {
            if (sortKey.value === key) {
                sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
            } else {
                sortKey.value = key;
                sortOrder.value = 'asc';
            }
            currentPage.value = 1; // Reset to first page when sort changes
        }

        function getSortIndicator(key) {
            if (sortKey.value === key) {
                return sortOrder.value === 'asc' ? '▲' : '▼';
            }
            return '';
        }

        function formatPrice(price) {
            return price.toFixed(2).replace('.', ',');
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
                // Fetch locations
                const locationsResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Locations!A2:C');
                const locationsValues = locationsResponse.values || [];
                const locations = locationsValues.reduce((acc, [title, , id]) => {
                    acc[id] = title;
                    return acc;
                }, {});

                // Fetch grocery items
                const groceriesResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Groceries!A2:H');
                const values = groceriesResponse.values || [];

                historyItems.value = values.map(row => ({
                    id: row[0],
                    title: row[1],
                    amount: parseInt(row[2]),
                    price: parseFloat(row[3].replace(',', '.')),
                    location: locations[row[5]] || row[5],
                    date: row[7] ? new Date(parseInt(row[6])).toISOString().split('T')[0] : '',
                }));

            } catch (err) {
                console.error('Error fetching data:', err);
                error.value = 'Failed to fetch data. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        onMounted(fetchData);

        return {
            historyItems,
            loading,
            error,
            filters,
            columns,
            paginatedHistory,
            currentPage,
            totalPages,
            fetchData,
            applyFilters,
            sortBy,
            getSortIndicator,
            formatPrice
        };
    },
    template: `
        <div class="history-page page-content">
            <div class="header">
                <div class="header-title">
                    <span class="hamburger-menu" @click="toggleSidenav">☰</span>
                    <h2>History <button @click="fetchData"><i class="icon material-icons" style="font-size: 14px;">refresh</i></button></h2>
                    <small v-if="loading" class="loading">Loading...</small>
                    <div v-if="error" class="error">{{ error }}</div>
                </div>
                <div class="controls">
                    <input type="search" v-model="filters.title" placeholder="Filter Title" @input="applyFilters">
                    <input type="search" v-model="filters.location" placeholder="Filter Location" @input="applyFilters">
                    <input type="search" v-model="filters.date" placeholder="Filter Date" @input="applyFilters">
                </div>
            </div>
            <div class="history-list">
                <table>
                    <thead>
                        <tr>
                            <th v-for="column in columns" :key="column" @click="sortBy(column)">
                                {{ column.charAt(0).toUpperCase() + column.slice(1) }}
                                {{ getSortIndicator(column) }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="item in paginatedHistory" :key="item.id">
                            <td>{{ item.title }}</td>
                            <td width="60">{{ item.amount }}</td>
                            <td width="60">{{ formatPrice(item.price) }}</td>
                            <td width="100">{{ item.date }}</td>
                            <td width="100">{{ item.location }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="pagination">
                <button @click="currentPage > 1 && currentPage--" :disabled="currentPage === 1">Previous</button>
                <span>Page {{ currentPage }} of {{ totalPages }}</span>
                <button @click="currentPage < totalPages && currentPage++" :disabled="currentPage === totalPages">Next</button>
            </div>
        </div>
    `
};

export default HistoryPage;
