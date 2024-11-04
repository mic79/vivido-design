import GoogleAuth from './googleAuth.js';

const { ref, computed, onMounted } = Vue;

export const NutritionPage = {
    props: ['sheetId', 'toggleSidenav'],
    setup(props) {
        const loading = ref(true);
        const error = ref(null);
        const groceryItems = ref([]);
        const nutritionData = ref({});
        const matchedItemsExpanded = ref(false);
        const unmatchedItemsExpanded = ref(false);
        const expandedCategory = ref(null);
        const monthlyCaloriesExpanded = ref(null);

        // Helper function to calculate amount in grams
        function calculateGrams(amount, nutrition) {
            if (!amount) return 0;
            amount = parseInt(amount);
            
            switch (nutrition.unit) {
                case 'piece':
                case 'unit':
                case 'pcs':
                    return amount * nutrition.gramsPerUnit;
                case 'ml':
                    return amount; // Assume 1ml = 1g for simplicity
                default:
                    return amount;
            }
        }

        async function fetchNutritionData() {
            try {
                // Fetch from Nutrition sheet (now including unit and gramsPerUnit)
                const response = await GoogleAuth.loadSheetData(props.sheetId, 'Nutrition!A2:H');
                const values = response.values || [];
                
                // Create a map of food items to their nutrition data
                return values.reduce((acc, [name, calories, protein, carbs, fat, category, unit, gramsPerUnit]) => {
                    acc[name.toLowerCase()] = {
                        calories: parseFloat(calories),
                        protein: parseFloat(protein),
                        carbs: parseFloat(carbs),
                        fat: parseFloat(fat),
                        category,
                        unit: unit || 'g',
                        gramsPerUnit: parseFloat(gramsPerUnit) || 1
                    };
                    return acc;
                }, {});
            } catch (err) {
                console.error('Error fetching nutrition data:', err);
                return {};
            }
        }

        async function fetchData() {
            loading.value = true;
            error.value = null;
            try {
                const groceriesResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Groceries!A2:H');
                groceryItems.value = groceriesResponse.values.map(row => ({
                    id: row[0],
                    title: row[1],
                    amount: row[2],
                    price: row[3],
                    order: row[4],
                    location: row[5],
                    dateChecked: row[6],
                    date: row[7]
                }));

                nutritionData.value = await fetchNutritionData();
            } catch (err) {
                console.error('Error fetching data:', err);
                error.value = 'Failed to fetch data. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        function toggleCategory(category) {
            console.log('Toggling category:', category);
            expandedCategory.value = expandedCategory.value === category ? null : category;
        }

        const nutritionInsights = computed(() => {
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);
            
            const recentItems = groceryItems.value.filter(item => {
                const itemDate = new Date(parseInt(item.dateChecked));
                return itemDate > lastMonth;
            });

            const insights = {
                totalCalories: 0,
                proteinRatio: 0,
                carbsRatio: 0,
                fatRatio: 0,
                categoryBreakdown: {},
                matchedItems: 0,
                totalItems: recentItems.length,
                categoryProducts: {}
            };

            recentItems.forEach(item => {
                const itemName = item.title.toLowerCase();
                const nutrition = nutritionData.value[itemName];
                
                if (nutrition) {
                    insights.matchedItems++;
                    
                    if (nutrition.category !== 'Non-food') {
                        //const gramsAmount = calculateGrams(item.amount, nutrition);
                        const gramsAmount = calculateGrams(parseFloat(item.amount) || 0, nutrition);
                        const amountRatio = gramsAmount / 100;
                        
                        insights.totalCalories += nutrition.calories * amountRatio;
                        insights.proteinRatio += nutrition.protein * amountRatio;
                        insights.carbsRatio += nutrition.carbs * amountRatio;
                        insights.fatRatio += nutrition.fat * amountRatio;
                        
                        insights.categoryBreakdown[nutrition.category] = 
                            (insights.categoryBreakdown[nutrition.category] || 0) + 1;
                        
                        if (!insights.categoryProducts[nutrition.category]) {
                            insights.categoryProducts[nutrition.category] = {};
                        }
                        if (!insights.categoryProducts[nutrition.category][item.title]) {
                            insights.categoryProducts[nutrition.category][item.title] = {
                                title: item.title,
                                amount: 0,
                                count: 0,
                                totalCalories: 0
                            };
                        }
                        
                        insights.categoryProducts[nutrition.category][item.title].amount += parseFloat(item.amount) || 0;
                        insights.categoryProducts[nutrition.category][item.title].count++;
                        insights.categoryProducts[nutrition.category][item.title].totalCalories += Math.round(nutrition.calories * (gramsAmount / 100));
                    }
                }
            });

            // Convert the objects to sorted arrays
            Object.keys(insights.categoryProducts).forEach(category => {
                insights.categoryProducts[category] = Object.values(insights.categoryProducts[category])
                    .sort((a, b) => b.count - a.count); // Sort by frequency
            });

            // After populating categoryBreakdown and matchedItems, sort by percentage
            insights.categoryBreakdown = Object.entries(insights.categoryBreakdown)
                .sort((a, b) => {
                    // Calculate percentages (count / total matched items)
                    const percentA = (a[1] * 100 / insights.matchedItems);
                    const percentB = (b[1] * 100 / insights.matchedItems);
                    return percentB - percentA; // Sort descending
                })
                .reduce((obj, [key, value]) => {
                    obj[key] = value;
                    return obj;
                }, {});

            return insights;
        });

        const matchedItemsList = computed(() => {
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);
            
            const groupedItems = groceryItems.value
                .filter(item => {
                    // Only include items from the last 30 days
                    const itemDate = new Date(parseInt(item.dateChecked));
                    return itemDate > lastMonth;
                })
                .reduce((acc, item) => {
                    const itemName = item.title.toLowerCase();
                    const nutrition = nutritionData.value[itemName];
                    
                    if (nutrition) {
                        if (!acc[itemName]) {
                            acc[itemName] = {
                                title: item.title,
                                amount: 0,
                                totalCalories: 0,
                                count: 0,
                                unit: nutrition.unit || 'g'
                            };
                        }
                        
                        const amount = parseFloat(item.amount) || 0;
                        acc[itemName].amount += amount;
                        acc[itemName].count += 1;
                        
                        // Calculate calories based on actual grams
                        const gramsAmount = calculateGrams(amount, nutrition);
                        acc[itemName].totalCalories += Math.round(nutrition.calories * (gramsAmount / 100));
                    }
                    return acc;
                }, {});

            return Object.values(groupedItems)
                .sort((a, b) => b.totalCalories - a.totalCalories)
                .map(item => ({
                    ...item,
                    amount: `${item.amount}${item.unit}`
                }));
        });

        const unmatchedItemsList = computed(() => {
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);
            
            // Group unmatched items by title
            const groupedItems = groceryItems.value
                .filter(item => {
                    const itemDate = new Date(parseInt(item.dateChecked));
                    return itemDate > lastMonth;
                })
                .reduce((acc, item) => {
                    const itemName = item.title.toLowerCase();
                    
                    // Only process items that don't have nutrition data
                    if (!nutritionData.value[itemName]) {
                        if (!acc[itemName]) {
                            acc[itemName] = {
                                title: item.title,
                                amount: 0,
                                count: 0
                            };
                        }
                        acc[itemName].amount += parseInt(item.amount) || 0;
                        acc[itemName].count++;
                    }
                    return acc;
                }, {});

            // Convert to array and sort by frequency
            return Object.values(groupedItems)
                .sort((a, b) => b.count - a.count)
                .map(item => ({
                    ...item,
                    amount: `${item.amount}g` // Assuming grams as default unit
                }));
        });

        const monthlyCalories = computed(() => {
            const months = {};
            const today = new Date();
            const currentMonthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
            
            // Initialize last 12 months
            for (let i = 11; i >= 0; i--) {
                const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const monthKey = date.toISOString().slice(0, 7);
                months[monthKey] = {
                    totalCalories: 0,
                    daysInMonth: new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(),
                    matchedItems: 0,
                    totalItems: 0,
                    unmatchedItems: {},
                    expanded: false
                };
            }

            // Calculate actual calories for all months
            groceryItems.value.forEach(item => {
                if (!item.dateChecked) return;
                
                const itemDate = new Date(parseInt(item.dateChecked));
                const monthKey = itemDate.toISOString().slice(0, 7);
                
                if (months[monthKey]) {
                    const itemName = item.title.toLowerCase();
                    const nutrition = nutritionData.value[itemName];
                    
                    months[monthKey].totalItems++;
                    
                    if (nutrition) {
                        months[monthKey].matchedItems++;
                        const amount = parseFloat(item.amount) || 0;
                        const gramsAmount = calculateGrams(amount, nutrition);
                        const calories = Math.round(nutrition.calories * (gramsAmount / 100));
                        months[monthKey].totalCalories += calories;
                    } else {
                        if (!months[monthKey].unmatchedItems[itemName]) {
                            months[monthKey].unmatchedItems[itemName] = {
                                title: item.title,
                                amount: 0,
                                count: 0
                            };
                        }
                        months[monthKey].unmatchedItems[itemName].amount += parseFloat(item.amount) || 0;
                        months[monthKey].unmatchedItems[itemName].count++;
                    }
                }
            });

            // Calculate average daily calories from last 3 months
            const sortedMonths = Object.entries(months)
                .sort((a, b) => b[0].localeCompare(a[0]));
            
            const last3MonthsAvg = sortedMonths
                .slice(1, 4) // Skip current month, take next 3
                .reduce((total, [_, data]) => {
                    return total + (data.totalCalories / data.daysInMonth);
                }, 0) / 3; // Divide by 3 to get daily average

            return Object.entries(months)
                .map(([month, data]) => {
                    const result = {
                        month,
                        avgDailyCalories: Math.round(data.totalCalories / data.daysInMonth),
                        matchedItems: data.matchedItems,
                        totalItems: data.totalItems,
                        unmatchedItems: Object.values(data.unmatchedItems),
                        expanded: data.expanded
                    };

                    // Add estimation for current month
                    if (month === currentMonthYear) {
                        const currentDay = today.getDate();
                        const remainingDays = data.daysInMonth - currentDay;
                        const estimatedTotalCalories = data.totalCalories + (last3MonthsAvg * remainingDays);
                        result.estimatedDailyCalories = Math.round(estimatedTotalCalories / data.daysInMonth);
                    }

                    return result;
                })
                .sort((a, b) => b.month.localeCompare(a.month));
        });

        const maxDailyCalories = computed(() => {
            return Math.max(...monthlyCalories.value.map(m => m.avgDailyCalories));
        });

        function toggleMonthlyCalories(month) {
            monthlyCaloriesExpanded.value = monthlyCaloriesExpanded.value === month ? null : month;
        }

        onMounted(fetchData);

        return {
            loading,
            error,
            nutritionInsights,
            matchedItemsList,
            unmatchedItemsList,
            matchedItemsExpanded,
            unmatchedItemsExpanded,
            expandedCategory,
            toggleCategory,
            fetchData,
            monthlyCalories,
            maxDailyCalories,
            monthlyCaloriesExpanded,
            toggleMonthlyCalories
        };
    },
    template: `
        <div class="nutrition-page page-content">
            <div class="header">
                <div class="header-title">
                    <span class="hamburger-menu" @click="toggleSidenav">☰</span>
                    <h2>Nutrition <button @click="fetchData"><i class="icon material-icons" style="font-size: 14px;">refresh</i></button></h2>
                    <small v-if="loading" class="loading">Loading...</small>
                    <div v-else-if="error" class="error">{{ error }}</div>
                </div>
            </div>
            <div class="dashboard-content">
                <div class="chart nutrition-insights">
                    <h3>Nutritional Insights (Last 30 Days)</h3>
                    <div v-if="nutritionInsights.matchedItems > 0" class="nutrition-content">
                        <div class="nutrition-stats">
                            <div class="stat">
                                <span class="label">Matched Items</span>
                                <span class="value">{{ nutritionInsights.matchedItems }}/{{ nutritionInsights.totalItems }}</span>
                            </div>
                            <div class="stat">
                                <span class="label">Avg. Daily Calories</span>
                                <span class="value">{{ Math.round(nutritionInsights.totalCalories / 30) }}</span>
                            </div>
                        </div>
                        
                        <div class="macros-breakdown">
                            <h4>Macronutrient Ratio</h4>
                            <div class="macro-bars">
                                <div class="macro-bar protein" 
                                     :style="{ width: (nutritionInsights.proteinRatio * 100 / (nutritionInsights.proteinRatio + nutritionInsights.carbsRatio + nutritionInsights.fatRatio)) + '%' }">
                                    Protein {{ Math.round(nutritionInsights.proteinRatio * 100 / (nutritionInsights.proteinRatio + nutritionInsights.carbsRatio + nutritionInsights.fatRatio)) }}%
                                </div>
                                <div class="macro-bar carbs"
                                     :style="{ width: (nutritionInsights.carbsRatio * 100 / (nutritionInsights.proteinRatio + nutritionInsights.carbsRatio + nutritionInsights.fatRatio)) + '%' }">
                                    Carbs {{ Math.round(nutritionInsights.carbsRatio * 100 / (nutritionInsights.proteinRatio + nutritionInsights.carbsRatio + nutritionInsights.fatRatio)) }}%
                                </div>
                                <div class="macro-bar fat"
                                     :style="{ width: (nutritionInsights.fatRatio * 100 / (nutritionInsights.proteinRatio + nutritionInsights.carbsRatio + nutritionInsights.fatRatio)) + '%' }">
                                    Fat {{ Math.round(nutritionInsights.fatRatio * 100 / (nutritionInsights.proteinRatio + nutritionInsights.carbsRatio + nutritionInsights.fatRatio)) }}%
                                </div>
                            </div>
                        </div>

                        <div class="category-breakdown">
                            <h4>Food Categories</h4>
                            <div class="chart-container">
                                <div v-for="(count, category) in nutritionInsights.categoryBreakdown" 
                                     :key="category" 
                                     class="bar-container"
                                     @click="toggleCategory(category)">
                                    <div class="bar"
                                         :style="{ width: (count * 100 / nutritionInsights.matchedItems) + '%' }">
                                    </div>
                                    <span class="bar-label">
                                        <span class="material-icons">
                                            {{ expandedCategory === category ? 'arrow_drop_up' : 'arrow_drop_down' }}
                                        </span>
                                        {{ category }}: {{ Math.round(count * 100 / nutritionInsights.matchedItems) }}%
                                    </span>
                                    
                                    <!-- Expanded details -->
                                    <div v-if="expandedCategory === category" class="expanded-details">
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>Item</th>
                                                    <th>Amount</th>
                                                    <th>Calories</th>
                                                    <th>Frequency</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="product in nutritionInsights.categoryProducts[category]" 
                                                    :key="product.title">
                                                    <td>{{ product.title }}</td>
                                                    <td>{{ product.amount }}</td>
                                                    <td>{{ product.totalCalories }}</td>
                                                    <td>{{ product.count }}x</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="matched-items">
                            <h4 @click="matchedItemsExpanded = !matchedItemsExpanded" style="cursor: pointer;">
                                <span class="material-icons">
                                    {{ matchedItemsExpanded ? 'arrow_drop_up' : 'arrow_drop_down' }}
                                </span>
                                Matched Items Details
                            </h4>
                            <table v-if="matchedItemsExpanded">
                                <thead>
                                    <tr>
                                        <th>Item</th>
                                        <th>Amount</th>
                                        <th>Total Calories</th>
                                        <th>Frequency</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="item in matchedItemsList" :key="item.id">
                                        <td>{{ item.title }}</td>
                                        <td>{{ item.amount }}</td>
                                        <td>{{ item.totalCalories }}</td>
                                        <td>{{ item.count }}x</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div v-if="unmatchedItemsList.length > 0" class="unmatched-items">
                            <h4 @click="unmatchedItemsExpanded = !unmatchedItemsExpanded" style="cursor: pointer;">
                                <span class="material-icons">
                                    {{ unmatchedItemsExpanded ? 'arrow_drop_up' : 'arrow_drop_down' }}
                                </span>
                                Unmatched Items
                            </h4>
                            <div v-show="unmatchedItemsExpanded">
                                <p class="help-text">These items don't have nutrition data yet. Consider adding them to the Nutrition sheet.</p>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Item</th>
                                            <th>Amount</th>
                                            <th>Frequency</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="item in unmatchedItemsList" :key="item.title">
                                            <td>{{ item.title }}</td>
                                            <td>{{ item.amount }}</td>
                                            <td>{{ item.count }}x</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                    <div v-else class="no-data">
                        No nutrition data available. Please ensure you have a "Nutrition" sheet with food data.
                    </div>
                </div>

                <div class="chart monthly-calories">
                    <h4>Average Daily Calories by Month</h4>
                    <div class="chart-container">
                        <div v-for="item in monthlyCalories" 
                             :key="item.month" 
                             class="bar-container chart-bar-container"
                             @click="toggleMonthlyCalories(item.month)"
                             :class="{ 'expanded': monthlyCaloriesExpanded === item.month }">
                            <!-- Actual calories bar -->
                            <div class="bar chart-bar" 
                                 :style="{ width: (item.avgDailyCalories / maxDailyCalories * 100) + '%' }">
                            </div>
                            <!-- Estimated calories bar (only shown for current month) -->
                            <div v-if="item.estimatedDailyCalories" 
                                 class="bar estimated" 
                                 :style="{ width: (item.estimatedDailyCalories / maxDailyCalories * 100) + '%' }">
                            </div>
                            <span class="bar-label chart-bar-label">
                                <span class="material-icons chart-icon">
                                    {{ monthlyCaloriesExpanded === item.month ? 'arrow_drop_up' : 'arrow_drop_down' }}
                                </span>
                                {{ item.month }}&nbsp;&nbsp;&nbsp;&nbsp;
                                <strong>{{ item.avgDailyCalories }}</strong>
                                <span v-if="item.estimatedDailyCalories">
                                    &nbsp;&nbsp;&nbsp;&nbsp;(Est. {{ item.estimatedDailyCalories }})
                                </span>
                                <span class="matched-count" v-if="item.totalItems - item.matchedItems > 0">
                                    &nbsp;&nbsp;&nbsp;&nbsp;(Missing items {{ item.totalItems - item.matchedItems }}/{{ item.totalItems }})
                                </span>
                            </span>
                            
                            <!-- Expanded details -->
                            <div v-if="monthlyCaloriesExpanded === item.month && item.unmatchedItems.length > 0" 
                                 class="expanded-details chart-expanded-details">
                                <table class="chart-expanded-table">
                                    <thead>
                                        <tr>
                                            <th>Missing Item</th>
                                            <th>Amount</th>
                                            <th>Frequency</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="unmatched in item.unmatchedItems" :key="unmatched.title">
                                            <td>{{ unmatched.title }}</td>
                                            <td>{{ unmatched.amount }}</td>
                                            <td>{{ unmatched.count }}x</td>
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

export default NutritionPage;
