import GoogleAuth from './googleAuth.js';

const { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;

export const GroceriesPage = {
    props: ['sheetId', 'toggleSidenav', 'startEditing', 'stopEditing'],
    setup(props) {
        const locations = ref([]);
        const groceryItems = ref([]);
        const recentlyCheckedOff = ref([]);
        const loading = ref(false);
        const error = ref(null);
        const selectedLocation = ref(null);
        const selectedItems = ref([]);
        const selectAll = ref(false);
        const inputValues = ref({});
        const groceryListRef = ref(null);
        const sortingEnabled = ref(false);
        let sortableInstance = null;

        function initSortable() {
            if (groceryListRef.value) {
                if (groceryListRef.value._sortable && typeof groceryListRef.value._sortable.destroy === 'function') {
                    groceryListRef.value._sortable.destroy();
                }
                
                if (sortingEnabled.value) {
                    groceryListRef.value._sortable = new Sortable(groceryListRef.value, {
                        animation: 150,
                        ghostClass: 'sortable-ghost',
                        handle: '.drag-handle', // Use the drag handle for sorting
                        onEnd: async ({ oldIndex, newIndex }) => {
                            const item = filteredGroceryItems.value.splice(oldIndex, 1)[0];
                            filteredGroceryItems.value.splice(newIndex, 0, item);
                            
                            // Update the order of items
                            filteredGroceryItems.value.forEach((item, index) => {
                                item.order = index;
                            });

                            // Update the items in the sheet
                            for (const item of filteredGroceryItems.value) {
                                await updateItemInSheet(item);
                            }
                        }
                    });
                } else {
                    delete groceryListRef.value._sortable;
                }
            }
        }

        function toggleSorting() {
            sortingEnabled.value = !sortingEnabled.value;
            selectedItems.value = []; // Clear selections when toggling sort
            Vue.nextTick(() => {
                initSortable();
            });
        }

        function toggleSelectAll() {
            const allSelected = areAllLocationsSelected.value;
            sortedAndFilteredHistory.value.forEach(location => {
                location.selected = !allSelected;
            });
            // Force reactivity update
            locations.value = [...locations.value];
        }

        function deselectAll() {
            selectedItems.value = [];
        }

        async function performSelectedAction(action) {
            if (selectedItems.value.length === 0) return;

            switch (action) {
                case 'delete':
                if (confirm(`Are you sure you want to delete ${selectedItems.value.length} item(s)?`)) {
                    // Implement delete logic
                    console.log('Deleting items:', selectedItems.value);
                }
                break;
                case 'changeLocation':
                // Implement change location logic
                console.log('Changing location for items:', selectedItems.value);
                break;
                case 'changeDate':
                const newDate = prompt("Enter new date (YYYY-MM-DD) or leave empty to remove date:");
                for (const itemId of selectedItems.value) {
                    const item = groceryItems.value.find(i => i.id === itemId);
                    if (item) {
                        if (newDate) {
                            item.dateChecked = new Date(newDate).getTime();
                            item.date = new Date(newDate).toLocaleDateString();
                        } else {
                            item.dateChecked = null;
                            item.date = '';
                        }
                        try {
                            await updateItemInSheet(item);
                            // Handle successful update
                        } catch (err) {
                            console.error('Failed to update item:', err);
                            error.value = 'Failed to update item. Please try again.';
                        }
                    }
                }
                updateRecentlyCheckedOff();
                updateLocationStats();
                break;
            }

            selectedItems.value = []; // Clear selections after action
        }

        // Fetch locations and grocery items
        async function fetchData() {
            console.log('Starting fetchData');
            loading.value = true;
            error.value = null;
            const currentSelectedLocationId = selectedLocation.value;
            try {
                // Check token validity
                const isValid = await GoogleAuth.isTokenValid();
                if (!isValid) {
                    console.log('Token is not valid, refreshing...');
                    await GoogleAuth.getAccessToken(); // This should refresh the token
                    console.log('Token is now valid');
                }

                console.log('Fetching groceries data');
                const groceriesResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Groceries!A2:H');
                console.log('Groceries data received:', groceriesResponse);

                const values = groceriesResponse.values || [];
                groceryItems.value = values.map(row => ({
                    id: row[0],
                    title: row[1],
                    amount: parseInt(row[2]),
                    price: parseFloat(row[3].replace(',', '.')),
                    order: parseInt(row[4]),
                    location: row[5],
                    dateChecked: row[6] ? parseInt(row[6]) : null,
                    date: row[7],
                    checked: !!row[6]
                }));

                console.log('Fetching locations data');
                const locationsResponse = await GoogleAuth.loadSheetData(props.sheetId, 'Locations!A2:E');
                console.log('Locations data received:', locationsResponse);

                const locationsValues = locationsResponse.values || [];
                locations.value = locationsValues
                    .filter(row => row[3] !== 'true') // Filter out hidden locations
                    .map(row => ({
                        id: row[2],
                        title: row[0],
                        order: parseInt(row[1]) || 0, // Parse the order value
                        itemCount: 0,
                        totalPrice: 0
                    }))
                    .sort((a, b) => a.order - b.order); // Sort locations by order

                console.log('Updating location stats');
                updateLocationStats();

                // Restore the previously selected location, or default to the first one if it no longer exists
                if (locations.value.some(loc => loc.id === currentSelectedLocationId)) {
                    selectedLocation.value = currentSelectedLocationId;
                } else if (locations.value.length > 0) {
                    selectedLocation.value = locations.value[0].id;
                }

                console.log('Updating recently checked off items');
                updateRecentlyCheckedOff();

            } catch (err) {
                console.error('Error fetching data:', err);
                if (err.message.includes('Authentication failed')) {
                    error.value = 'Authentication failed. Please sign in again.';
                    // Trigger sign out or re-authentication process
                    await GoogleAuth.signOut();
                    // You might want to redirect to a sign-in page or show a sign-in prompt here
                } else {
                    error.value = 'Failed to fetch data. Please try again.';
                }
            } finally {
                loading.value = false;
                console.log('fetchData completed');
            }
        }

        function updateLocationStats() {
            //console.log("Updating location stats");
            const locationTotals = {};
            groceryItems.value.forEach(item => {
                if (!item.dateChecked) {  // Only consider unchecked items
                    if (!locationTotals[item.location]) {
                        locationTotals[item.location] = {
                            itemCount: 0,
                            totalPrice: 0
                        };
                    }
                    locationTotals[item.location].itemCount++;
                    
                    let price = typeof item.price === 'string' ? parseFloat(item.price.replace(',', '.')) : item.price;
                    if (!isNaN(price)) {
                        locationTotals[item.location].totalPrice += price;
                    }
                }
            });

            locations.value.forEach(location => {
                const stats = locationTotals[location.id] || { itemCount: 0, totalPrice: 0 };
                location.itemCount = stats.itemCount;
                location.totalPrice = stats.totalPrice;
                //console.log(`Location: ${location.title}, Count: ${location.itemCount}, Total: ${location.totalPrice}`);
            });
        }

        function updateRecentlyCheckedOff() {
            const checkedItems = groceryItems.value.filter(item => 
                item.dateChecked && item.location === selectedLocation.value
            );
            const groupedItems = _.groupBy(checkedItems, item => {
                // Ensure we're using the date in the local timezone
                const date = new Date(item.dateChecked);
                return date.toISOString().split('T')[0]; // YYYY-MM-DD format
            });
            
            // Create a map of existing groups with their collapsed state
            const existingGroupsMap = new Map(
                recentlyCheckedOff.value.map(group => [group.date, group.collapsed])
            );

            recentlyCheckedOff.value = Object.entries(groupedItems).map(([date, items]) => ({
                date,
                items: items.sort((a, b) => a.order - b.order), // Sort items within each group by order
                total: items.reduce((sum, item) => {
                    let price = typeof item.price === 'string' ? parseFloat(item.price.replace(',', '.')) : item.price;
                    return sum + (price);
                }, 0),
                collapsed: existingGroupsMap.has(date) ? existingGroupsMap.get(date) : true // Preserve collapsed state or default to true
            }))
            .sort((a, b) => new Date(b.date) - new Date(a.date)); // Sort groups by date, latest first
        }

        async function toggleItemCheck(item) {
            loading.value = true;
            try {
                const now = Date.now();
                if (!item.checked) {
                    // Item is being checked off
                    item.dateChecked = now;
                    item.date = new Date(now).toLocaleDateString();
                    // Assign the highest order number + 1 to put it at the end of the list
                    const maxOrder = Math.max(...groceryItems.value.map(i => i.order), 0);
                    item.order = maxOrder + 1;
                } else {
                    // Item is being unchecked
                    item.dateChecked = null;
                    item.date = '';
                    // You might want to reset the order or keep it as is
                }
                item.checked = !item.checked;

                try {
                    await updateItemInSheet(item);
                    // Handle successful update
                    updateLocationStats();
                    updateRecentlyCheckedOff();
                } catch (err) {
                    console.error('Failed to update item:', err);
                    error.value = 'Failed to update item. Please try again.';
                }
            } catch (err) {
                console.error('Error toggling item check:', err);
                error.value = 'Failed to update item. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        async function addGroceryItem() {
            const newItem = {
                id: `item_${Date.now()}`,
                title: '',
                amount: 0,
                price: 0,
                order: groceryItems.value.length,
                location: selectedLocation.value,
                dateChecked: null,
                date: '',
                checked: false
            };

            groceryItems.value.push(newItem);
            try {
                await updateItemInSheet(newItem);
                // Handle successful update
                updateLocationStats();

                // Use nextTick to ensure the DOM has updated before trying to focus
                Vue.nextTick(() => {
                    const newItemInput = document.querySelector(`input[data-item-id="${newItem.id}"]`);
                    if (newItemInput) {
                        newItemInput.focus();
                    }
                });
            } catch (err) {
                console.error('Failed to update item:', err);
                error.value = 'Failed to update item. Please try again.';
            }
        }

        async function updateItemInSheet(item) {
            console.log('updateItemInSheet', item);

            try {
                const cellValues = [
                    [
                        item.id,
                        item.title,
                        item.amount.toString(),
                        formatPrice(item.price),
                        item.order.toString(),
                        item.location,
                        item.dateChecked ? item.dateChecked.toString() : '',
                        item.date,
                    ]
                ];

                await GoogleAuth.updateSheetData(props.sheetId, 'Groceries!A:I', cellValues);

                console.log('Item updated successfully');
            } catch (err) {
                console.error('Error updating item in sheet:', err);
                throw err;
            }
        }

        function selectLocation(locationId) {
            selectedLocation.value = locationId;
            updateRecentlyCheckedOff();
            selectedItems.value = []; // Clear selections
        }

        function parsePrice(value) {
            if (typeof value === 'number') return value;
            if (!value) return 0;
            
            // Remove any non-digit, non-comma, non-minus characters
            value = value.replace(/[^\d,-]/g, '');
            
            // Replace comma with dot for parsing
            value = value.replace(',', '.');
            
            // Parse the value, ensuring it's a number with two decimal places
            return parseFloat(parseFloat(value).toFixed(2));
        }

        function formatPrice(price) {
            if (price === null || price === undefined || isNaN(price)) return '0,00';
            
            // Convert to string, replace dot with comma, and ensure two decimal places
            let formattedPrice = Math.abs(price).toFixed(2).replace('.', ',');
            
            // Add minus sign if negative
            if (price < 0) formattedPrice = '-' + formattedPrice;
            
            return formattedPrice;
        }

        function formatPriceForDisplay(item) {
            const storedInput = inputValues.value[item.id];
            if (storedInput !== undefined) {
                return storedInput;
            }
            return formatPrice(item.price);
        }

        async function handlePriceBlur(item, event) {
            // Get the stored input value or use the current item price
            const inputValue = inputValues.value[item.id] || formatPrice(item.price);
            
            // Parse and format the price
            const newPrice = parsePrice(inputValue);
            const formattedPrice = formatPrice(newPrice);
            
            // Update the item price and input value
            item.price = newPrice;
            event.target.value = formattedPrice;
            
            // Clear the temporary input value
            delete inputValues.value[item.id];
            
            try {
                await updateItemInSheet(item);
                // Handle successful update
                updateLocationStats();
                updateRecentlyCheckedOff();
            } catch (err) {
                console.error('Failed to update item:', err);
                error.value = 'Failed to update item. Please try again.';
            }
        }

        async function updateItemField(item, field, value) {
            if (typeof value === 'string') {
                // For text inputs: capitalize first letter and remove trailing spaces
                value = value.charAt(0).toUpperCase() + value.slice(1).trimEnd();
            }

            if (field === 'price') {
                value = parsePrice(value);
            } else if (field === 'amount') {
                value = parseInt(value) || null;  // Convert to integer or null if invalid
            }

            item[field] = value;
            try {
                await updateItemInSheet(item);
                // Handle successful update
                updateLocationStats();
            } catch (err) {
                console.error('Failed to update item:', err);
                error.value = 'Failed to update item. Please try again.';
            }
        }

        function toggleSelectAll() {
            const allSelected = selectedItems.value.length === filteredGroceryItems.value.length;
            filteredGroceryItems.value.forEach(item => item.selected = !allSelected);
            updateSelectedItems();
            // Force reactivity update
            groceryItems.value = [...groceryItems.value];
        }

        function toggleItemSelection(item) {
            item.selected = !item.selected;
            updateSelectedItems();
        }

        function updateSelectedItems() {
            selectedItems.value = filteredGroceryItems.value
                .filter(item => item.selected)
                .map(item => item.id);
            console.log('Updated selected items:', selectedItems.value);
        }
        
        function toggleSelectAllInGroup(items) {
            const allSelected = items.every(item => selectedItems.value.includes(item.id));
            if (allSelected) {
                selectedItems.value = selectedItems.value.filter(id => !items.some(item => item.id === id));
            } else {
                selectedItems.value = [...new Set([...selectedItems.value, ...items.map(item => item.id)])];
            }
        }

        function toggleItemSelection(item) {
            const index = selectedItems.value.indexOf(item.id);
            if (index > -1) {
                selectedItems.value.splice(index, 1);
            } else {
                selectedItems.value.push(item.id);
            }
        }

        async function duplicateSelectedItems() {
            if (selectedItems.value.length === 0) {
                console.log('No items selected');
                return;
            }

            loading.value = true;
            error.value = null;

            try {
                const allItems = [...filteredGroceryItems.value, ...recentlyCheckedOff.value.flatMap(group => group.items)];
                const itemsToDuplicate = allItems.filter(item => selectedItems.value.includes(item.id));
                
                await GoogleAuth.batchDuplicateGroceryItems(props.sheetId, itemsToDuplicate);
                await fetchData(); // Refresh all data
                console.log('Items duplicated successfully');
                deselectAll();
            } catch (err) {
                console.error('Error duplicating items:', err);
                error.value = 'Failed to duplicate items. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        async function deleteSelectedItems() {
            if (selectedItems.value.length === 0) return;

            // Ask for confirmation
            if (!confirm(`Are you sure you want to delete ${selectedItems.value.length} item(s)?`)) {
                return; // If the user cancels, exit the function
            }

            try {
                const sheetId = await getSheetId(props.sheetId, 'Groceries');

                const deleteRequests = [];
                const itemsToDelete = [...selectedItems.value].sort((a, b) => b - a); // Sort in descending order

                for (const itemId of itemsToDelete) {
                    const itemIndex = groceryItems.value.findIndex(item => item.id === itemId);
                    if (itemIndex !== -1) {
                        const rowIndex = itemIndex + 2; // +2 because sheet is 1-indexed and has a header row

                        deleteRequests.push({
                            deleteDimension: {
                                range: {
                                    sheetId: sheetId,
                                    dimension: 'ROWS',
                                    startIndex: rowIndex - 1,
                                    endIndex: rowIndex
                                }
                            }
                        });

                        groceryItems.value.splice(itemIndex, 1);
                    }
                }

                if (deleteRequests.length > 0) {
                    await GoogleAuth.batchUpdateSpreadsheet(props.sheetId, deleteRequests);
                }

                // Clear the selectedItems array
                selectedItems.value = [];

                updateLocationStats();
                updateRecentlyCheckedOff();
                error.value = null;
            } catch (err) {
                console.error('Error deleting grocery items:', err);
                error.value = 'Failed to delete items. Please try again.';
            }
        }

        async function getSheetId(spreadsheetId, sheetName) {
            const accessToken = await GoogleAuth.getAccessToken();
            const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            const data = await response.json();
            const sheet = data.sheets.find(s => s.properties.title === sheetName);
            return sheet ? sheet.properties.sheetId : null;
        }

        async function changeLocationForSelected(newLocationId) {
            if (selectedItems.value.length === 0 || !newLocationId) return;
            
            loading.value = true;
            error.value = null;
            
            try {
                for (const itemId of selectedItems.value) {
                    const item = groceryItems.value.find(i => i.id === itemId);
                    if (item) {
                        item.location = newLocationId;
                        try {
                            await updateItemInSheet(item);
                            // Handle successful update
                        } catch (err) {
                            console.error('Failed to update item:', err);
                            error.value = 'Failed to update item. Please try again.';
                        }
                    }
                }
                
                // Clear selection after changing location
                selectedItems.value = [];
                
                // Update location stats after changing locations
                updateLocationStats();
                
                // Update recently checked off items
                updateRecentlyCheckedOff();
                
                console.log('Location changed successfully for selected items');
            } catch (err) {
                console.error('Error changing location for items:', err);
                error.value = 'Failed to change location for items. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        async function changeDateForSelected(newDate) {
            console.log('changeDateForSelected', newDate);
            if (selectedItems.value.length === 0) return;

            loading.value = true;
            try {
                for (const itemId of selectedItems.value) {
                    const item = groceryItems.value.find(i => i.id === itemId);
                    if (item) {
                        if (newDate === null || newDate === '') {
                            // Clear the date
                            item.dateChecked = null;
                            item.date = '';
                            item.checked = false;
                        } else {
                            // Set the new date
                            item.dateChecked = new Date(newDate).getTime();
                            item.date = new Date(newDate).toLocaleDateString();
                            item.checked = true;
                        }
                        await updateItemInSheet(item);
                    }
                }

                updateRecentlyCheckedOff();
                updateLocationStats();
                //selectedItems.value = []; // Clear selections after action
                error.value = null;
            } catch (err) {
                console.error('Error changing date:', err);
                error.value = 'Failed to change date. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        function inputDateForSelected(value) {
            if (value.target.value === '') {
                changeDateForSelected(null);
            }
        }

        const filteredGroceryItems = computed(() => {
            return groceryItems.value
                .filter(item => item.location === selectedLocation.value && !item.dateChecked)
                .sort((a, b) => a.order - b.order);
        });

        function handlePriceInput(item, event) {
            //console.log('handlePriceInput', item, event);
            let inputValue = event.target.value;
            
            // Allow minus sign, digits, and at most one comma
            inputValue = inputValue.replace(/[^-\d,]/g, '');
            
            // Ensure only one minus sign at the start
            if (inputValue.startsWith('-')) {
                inputValue = '-' + inputValue.substring(1).replace(/-/g, '');
            }
            
            // Ensure only one comma
            const commaIndex = inputValue.indexOf(',');
            if (commaIndex !== -1) {
                inputValue = inputValue.slice(0, commaIndex + 1) + inputValue.slice(commaIndex + 1).replace(',', '');
            }
            
            // Update the input value without full formatting
            event.target.value = inputValue;
            
            // Update the item price
            //item.price = parsePrice(inputValue);

            // Store the input value temporarily
            inputValues.value[item.id] = inputValue;
        }

        function handleAmountFocus(item, event) {
            if (event.target.value === '' || event.target.value === '0') {
                event.target.value = '';
                item.amount = null;  // or '' if you prefer
            }
        }

        function handlePriceFocus(item, event) {
            if (event.target.value === '' || event.target.value === '0' || event.target.value === '0,00') {
                event.target.value = '';
                inputValues.value[item.id] = '';
            }
        }

        async function handlePriceBlur(item, event) {
            //console.log('handlePriceBlur', item, event);
            // Get the stored input value or use the current item price
            const inputValue = inputValues.value[item.id] || formatPrice(item.price);
            
            // Parse and format the price
            const newPrice = parsePrice(inputValue);
            const formattedPrice = formatPrice(newPrice);
            
            // Update the item price and input value
            item.price = newPrice;
            event.target.value = formattedPrice;
            
            // Clear the temporary input value
            delete inputValues.value[item.id];
            
            try {
                await updateItemInSheet(item);
                // Handle successful update
                updateLocationStats();
                updateRecentlyCheckedOff();
            } catch (err) {
                console.error('Failed to update item:', err);
                error.value = 'Failed to update item. Please try again.';
            }
        }

        function handleKeyPress(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                // Perform your "done" action here, e.g., blur the input
                event.target.blur();
            }
        }

        const suggestions = ref([]);
        const currentEditingItem = ref(null);

        function processHistoricalData() {
            const now = Date.now();
            const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000; // 30 days ago
            
            return groceryItems.value.reduce((acc, item) => {
                // Skip items without a checked_date
                if (!item.dateChecked) return acc;

                if (!acc[item.title]) {
                    acc[item.title] = {
                        id: item.id, // Add this line to store the item ID
                        count: 0,
                        lastPurchase: 0,
                        score: 0,
                        locations: {},
                        mostRecent: null
                    };
                }
                
                acc[item.title].count++;
                
                if (!acc[item.title].locations[item.location]) {
                    acc[item.title].locations[item.location] = {
                        lastPurchases: []
                    };
                }
                
                // Add current purchase to the location's lastPurchases
                acc[item.title].locations[item.location].lastPurchases.push({
                    date: item.dateChecked,
                    quantity: item.amount,
                    price: item.price
                });
                
                // Sort lastPurchases by date (most recent first) and keep only the last 5
                acc[item.title].locations[item.location].lastPurchases.sort((a, b) => b.date - a.date);
                acc[item.title].locations[item.location].lastPurchases = acc[item.title].locations[item.location].lastPurchases.slice(0, 5);
                
                if (item.dateChecked > acc[item.title].lastPurchase) {
                    acc[item.title].lastPurchase = item.dateChecked;
                    acc[item.title].mostRecent = {
                        quantity: item.amount,
                        price: item.price,
                        location: item.location
                    };
                }
                
                // Calculate score: higher for more frequent and recent purchases
                const recencyScore = item.dateChecked > oneMonthAgo ? 2 : 1;
                acc[item.title].score = acc[item.title].count * recencyScore;
                
                return acc;
            }, {});
        }

        function filterSuggestions(input, itemId) {
            if (!input) {
                suggestions.value = [];
                return;
            }
            currentEditingItem.value = itemId;
            const currentItem = groceryItems.value.find(item => item.id === itemId);
            const currentLocation = currentItem ? currentItem.location : null;
            
            console.log('Current item:', currentItem);
            console.log('Current location:', currentLocation);

            const historicalData = processHistoricalData();
            console.log('Historical data:', historicalData);

            const matches = Object.keys(historicalData)
                .filter(title => {
                    const matchesInput = title.toLowerCase().includes(input.toLowerCase());
                    const itemData = historicalData[title];
                    const matchesLocation = itemData.locations[currentLocation] !== undefined;
                    const isNotCurrentItem = itemId !== itemData.id; // Compare by ID instead of title
                    console.log(`Title: ${title}, Matches input: ${matchesInput}, Matches location: ${matchesLocation}, Is not current item: ${isNotCurrentItem}`);
                    return matchesInput && matchesLocation && isNotCurrentItem;
                })
                .sort((a, b) => {
                    // Prioritize exact matches
                    if (a.toLowerCase() === input.toLowerCase()) return -1;
                    if (b.toLowerCase() === input.toLowerCase()) return 1;
                    // Then sort by score
                    return historicalData[b].score - historicalData[a].score;
                });
            
            console.log('Matches:', matches);

            if (matches.length === 1) {
                const title = matches[0];
                const data = historicalData[title];
                const lastPurchases = data.locations[currentLocation].lastPurchases;
                
                suggestions.value = lastPurchases.map(purchase => ({
                    title,
                    lastPurchase: new Date(purchase.date).toLocaleDateString(),
                    quantity: purchase.quantity,
                    price: purchase.price,
                    location: currentLocation
                }));
            } else {
                suggestions.value = matches.slice(0, 5).map(title => {
                    const data = historicalData[title];
                    const lastPurchase = data.locations[currentLocation].lastPurchases[0];
                    return {
                        title,
                        lastPurchase: new Date(lastPurchase.date).toLocaleDateString(),
                        quantity: lastPurchase.quantity,
                        price: lastPurchase.price,
                        location: currentLocation
                    };
                });
            }

            console.log('Suggestions:', suggestions.value);
        }

        function selectSuggestion(suggestion) {
            const item = groceryItems.value.find(item => item.id === currentEditingItem.value);
            if (item) {
                console.log('Selected suggestion:', suggestion);
                console.log('Current item before update:', { ...item });
                
                if (item.location !== suggestion.location) {
                    console.warn('Location mismatch:', item.location, suggestion.location);
                    // You might want to add some user feedback here
                }

                item.title = suggestion.title;
                item.amount = suggestion.quantity;
                item.price = suggestion.price;
                
                console.log('Current item after update:', { ...item });
                
                updateItemField(item, 'title', suggestion.title);
                updateItemField(item, 'amount', suggestion.quantity);
                updateItemField(item, 'price', suggestion.price);
            }
            suggestions.value = [];
            currentEditingItem.value = null;
        }

        onBeforeUnmount(() => {
            suggestions.value = [];
            currentEditingItem.value = null;
        });

        function force_scroll_sideways(element) {
            if (!element) return;
            element.addEventListener("wheel", (event) => {
                event.preventDefault();
                let magnitude = event.deltaX === 0 ? (event.deltaY > 0 ? 30 : -30) : event.deltaX;
                element.scrollBy({ left: magnitude });
            });
        }

        onMounted(async () => {
            console.log('Component mounted');
            try {
                console.log('Waiting for Google Auth to initialize...');
                await GoogleAuth.initGoogleAuth();
                console.log('Google Auth initialized');

                console.log('Calling fetchData...');
                await fetchData();

                if (locations.value.length > 0) {
                    console.log('Selecting first location');
                    selectLocation(locations.value[0].id);
                }

                const element = document.querySelector(".location-tabs");
                force_scroll_sideways(element);

                await Vue.nextTick();
                initSortable();
            } catch (error) {
                console.error("Error during component mount:", error);
                // Handle the error appropriately
            }
        });

        return {
            locations,
            groceryItems,
            recentlyCheckedOff,
            loading,
            error,
            fetchData,
            selectedLocation,
            selectedItems,
            filteredGroceryItems,
            toggleItemCheck,
            addGroceryItem,
            selectLocation,
            updateItemField,
            formatPriceForDisplay,
            formatPrice,
            duplicateSelectedItems,
            deleteSelectedItems,
            changeLocationForSelected,
            changeDateForSelected,
            updateLocationStats,
            selectAll,
            toggleSelectAll,
            deselectAll,
            performSelectedAction,
            updateRecentlyCheckedOff,
            handlePriceInput,
            handlePriceBlur,
            handlePriceFocus,
            handleAmountFocus,
            inputValues,
            handleKeyPress,
            groceryListRef,
            initSortable,
            toggleSorting,
            sortingEnabled,
            inputDateForSelected,
            suggestions,
            currentEditingItem,
            filterSuggestions,
            selectSuggestion,
            toggleItemSelection,
            updateSelectedItems,
            toggleSelectAllInGroup,
            toggleItemSelection
        };
    },
    template: `
        <div class="groceries-page page-content">
            <div class="header">
                <div class="header-title">
                    <span class="hamburger-menu" @click="toggleSidenav">☰</span>
                    <h2>Groceries <button @click="fetchData"><i class="icon material-icons" style="font-size: 14px;">refresh</i></button></h2>
                    <button @click="toggleSorting" class="sort-button">
                        {{ sortingEnabled ? 'Disable Sorting' : 'Enable Sorting' }}
                    </button>
                    <small v-if="loading" class="loading">Loading...</small>
                    <div v-if="error" class="error">{{ error }}</div>
                </div>
                
                <!-- Location tabs -->
                <div class="location-tabs">
                    <div 
                        v-for="location in locations" 
                        :key="location.id" 
                        class="location-tab"
                        :class="{ 'active': location.id === selectedLocation }"
                        @click="selectLocation(location.id)"
                    >
                        {{ location.title }} ({{ location.itemCount }})
                        <div class="location-total">{{ formatPrice(location.totalPrice) }}</div>
                    </div>
                </div>
            </div>
            <div class="wrapper">
                <!-- Grocery items to purchase -->
                <div class="grocery-list">
                    <table v-if="filteredGroceryItems.length > 0">
                        <thead>
                            <tr>
                                <th width="30">
                                    <input type="checkbox" 
                                        :checked="selectedItems.length === filteredGroceryItems.length && filteredGroceryItems.length > 0" 
                                        @change="toggleSelectAll(filteredGroceryItems)">
                                </th>
                                <th>Item</th>
                                <th width="60">Quantity</th>
                                <th width="60">Price</th>
                            </tr>
                        </thead>
                        <tbody ref="groceryListRef">
                            <tr v-for="item in filteredGroceryItems" :key="item.id">
                                <td class="select-checkbox" width="30">
                                    <input v-if="!sortingEnabled" 
                                        type="checkbox" 
                                        v-model="item.selected"
                                        @change="updateSelectedItems">
                                    <span v-else class="drag-handle">☰</span>
                                </td>
                                <td class="item-title">
                                    <input 
                                        type="text" 
                                        v-model="item.title" 
                                        :data-item-id="item.id" 
                                        @focus="startEditing" 
                                        @blur="stopEditing" 
                                        @input="filterSuggestions(item.title, item.id)"
                                        @change="updateItemField(item, 'title', $event.target.value)"
                                    >
                                    <ul v-if="suggestions && suggestions.length > 0 && currentEditingItem === item.id" class="suggestions">
                                        <li v-for="suggestion in suggestions" :key="suggestion.title + suggestion.lastPurchase" @mousedown.prevent="selectSuggestion(suggestion)">
                                            {{ suggestion.title }}
                                            <br>
                                            Last purchase: {{ suggestion.lastPurchase }}
                                            <br>
                                            Quantity: {{ suggestion.quantity }}, Price: {{ formatPrice(suggestion.price) }}
                                        </li>
                                    </ul>
                                </td>
                                <td class="item-amount" width="60"><input type="number" v-model.number="item.amount" :data-item-id="item.id" @focus="($event) => { handleAmountFocus(item, $event); startEditing(); }" @blur="stopEditing" @change="updateItemField(item, 'amount', $event.target.value)"></td>
                                <td class="item-price" width="60">
                                    <input 
                                        :value="formatPriceForDisplay(item)"
                                        @input="handlePriceInput(item, $event)"
                                        @focus="($event) => { handlePriceFocus(item, $event); startEditing(); }"
                                        @blur="($event) => { handlePriceBlur(item, $event); stopEditing(); }"
                                        @keypress="handleKeyPress"
                                        inputmode="decimal"
                                        enterkeyhint="done"
                                    >
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <p v-else class="no-items-message"></p>
                </div>

                <!-- Actions for selected items -->
                <div v-if="selectedItems.length > 0" class="selected-actions">
                    <div class="header-title">
                        <i class="icon material-icons" @click="deselectAll">arrow_back</i>
                        <h2>{{ selectedItems.length }} Selected</h2>
                    </div>
                    <div class="wrapper">
                        <select style="width: 100px;" @change="changeLocationForSelected($event.target.value)">
                            <option value="">Location</option>
                            <option v-for="location in locations" :key="location.id" :value="location.id">
                                {{ location.title }}
                            </option>
                        </select>
                        <input type="date" @change="changeDateForSelected($event.target.value)" @input="inputDateForSelected($event)">
                        <button @click="duplicateSelectedItems" :disabled="selectedItems.length === 0">Duplicate</button>
                        <button class="alert" @click="deleteSelectedItems">Delete</button>
                    </div>
                </div>

                <!-- Recently checked off items -->
                <div class="recently-checked-off">
                    <h3>Recently Checked Off Items</h3>
                    <div v-for="group in recentlyCheckedOff" :key="group.date" class="recently-checked-off-group">
                    <h4 @click="group.collapsed = !group.collapsed">
                        {{ group.date }}<span style="margin-left: auto;">{{ formatPrice(group.total) }}</span>
                    </h4>
                    <table v-if="!group.collapsed">
                        <thead>
                        <tr>
                            <th width="30">
                                <input type="checkbox" 
                                    :checked="group.items.length > 0 && group.items.every(item => selectedItems.includes(item.id))" 
                                    @change="toggleSelectAllInGroup(group.items)">
                            </th>
                            <th>Item</th>
                            <th width="60">Quantity</th>
                            <th width="60">Price</th>
                        </tr>
                        </thead>
                        <tbody>
                        <tr v-for="item in group.items" :key="item.id" :data-id="item.id">
                            <td class="select-checkbox" width="30">
                                <input type="checkbox" 
                                    :checked="selectedItems.includes(item.id)"
                                    @change="toggleItemSelection(item)">
                            </td>
                            <td class="item-title"><input type="text" v-model="item.title" @focus="startEditing" @blur="stopEditing" @change="updateItemInSheet(item)"></td>
                            <td class="item-amount" width="60"><input type="number" v-model.number="item.amount" @focus="($event) => { handleAmountFocus(item, $event); startEditing(); }" @blur="stopEditing" @change="updateItemInSheet(item)"></td>
                            <td class="item-price" width="60">
                                <input  
                                        :value="formatPriceForDisplay(item)"
                                        @input="handlePriceInput(item, $event)"
                                        @focus="startEditing"
                                        @blur="($event) => { handlePriceBlur(item, $event); stopEditing(); }"
                                        @keypress="handleKeyPress"
                                        inputmode="decimal"
                                        enterkeyhint="done"
                                    >
                            </td>
                        </tr>
                        </tbody>
                    </table>
                    </div>
                </div>
            </div>

            <button @click="addGroceryItem" class="add-grocery-button">Add Grocery</button>
            </div>
        `
        
};

export default GroceriesPage;
