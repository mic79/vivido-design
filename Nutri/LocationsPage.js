import GoogleAuth from './googleAuth.js';

const { ref, computed, onMounted, watch, nextTick } = Vue;

export const LocationsPage = {
    props: ['sheetId', 'toggleSidenav', 'setupChangeDetection', 'startEditing', 'stopEditing'],
    setup(props) {
        const locations = ref([]);
        const stableLocations = ref([]);
        const globalSearch = ref('');
        const sortColumn = ref('title');
        const sortDirection = ref('asc');
        const currentLocationsPage = ref(1);
        const itemsPerPage = ref(10);
        const columns = ['title', 'city', 'order', 'hidden'];
        const loading = ref(false);
        const error = ref(null);
        const selectAll = ref(false);
        const editingLocationId = ref(null);
        const focusNextId = ref(null);
        const isEditing = ref(false);

        // Make error ref accessible globally for testing
        if (!window.pageRefs) {
            window.pageRefs = {};
        }
        window.pageRefs.groceries = { error };

        function applySort() {
            stableLocations.value = [...stableLocations.value].sort((a, b) => {
                if (a[sortColumn.value] < b[sortColumn.value]) return sortDirection.value === 'asc' ? -1 : 1;
                if (a[sortColumn.value] > b[sortColumn.value]) return sortDirection.value === 'asc' ? 1 : -1;
                return stableLocations.value.indexOf(a) - stableLocations.value.indexOf(b);
            });
        }

        const paginatedLocations = computed(() => {
            const startIndex = (currentLocationsPage.value - 1) * itemsPerPage.value;
            return filteredAndSortedLocations.value.slice(startIndex, startIndex + itemsPerPage.value);
        });

        const totalPages = computed(() => Math.ceil(filteredAndSortedLocations.value.length / itemsPerPage.value));

        const selectedLocations = computed(() => 
            locations.value.filter(location => location.selected)
        );

        function sort(column) {
            if (sortColumn.value === column) {
                sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn.value = column;
                sortDirection.value = 'asc';
            }
            applyFilterAndSort();
        }

        function applyFilterAndSort() {
            if (isEditing.value || editingLocationId.value) {
                console.log('Skipping sort during edit');
                return;  // Don't sort while editing
            }
            
            if (locations.value.length === 0) return;

            const filtered = locations.value.filter(location =>
                Object.values(location).some(value =>
                    String(value).toLowerCase().includes(globalSearch.value.toLowerCase())
                )
            );

            stableLocations.value = filtered.sort((a, b) => {
                if (sortColumn.value === 'order') {
                    return sortDirection.value === 'asc' ? a.order - b.order : b.order - a.order;
                }
                if (a[sortColumn.value] < b[sortColumn.value]) return sortDirection.value === 'asc' ? -1 : 1;
                if (a[sortColumn.value] > b[sortColumn.value]) return sortDirection.value === 'asc' ? 1 : -1;
                return 0;
            });
        }

        function changePage(page) {
            stopChangeDetection();
            
            currentLocationsPage.value = page;
        }

        const debounceUpdate = _.debounce(updateLocation, 1500);

        const debounceSearch = _.debounce(() => {
            currentLocationsPage.value = 1;
            if (!isEditing.value) {  // Only apply full sort if not editing
                applyFilterAndSort();
            }
        }, 300);

        watch(globalSearch, debounceSearch);

        async function fetchLocations() {
            loading.value = true;
            error.value = null;
            try {
                const response = await GoogleAuth.loadSheetData(props.sheetId, 'Locations!A2:F');
                const values = response.values || [];
                locations.value = values.map(row => ({
                    title: row[0],
                    order: parseInt(row[1]) || 0,
                    id: row[2],
                    hidden: row[3] === 'true',
                    city: row[4] || '',
                    selected: false
                }));
                applyFilterAndSort();
            } catch (err) {
                console.error('Error fetching locations:', err);
                error.value = err.isRateLimit ? err.message : 'Failed to fetch data. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        function formatCapitalizeFirst(value) {
            return value.charAt(0).toUpperCase() + value.slice(1);
        }
        function formatTextInput(value) {
            return value.charAt(0).toUpperCase() + value.slice(1);
        }

        async function updateLocation(location, isNewRow = false) {
            console.log('Updating location:', { 
                id: location.id,
                title: location.title,
                hidden: location.hidden,
                isNewRow 
            });
            try {
                await GoogleAuth.batchUpdateSheetData(
                    props.sheetId,
                    'Locations!A:E',
                    [[
                        location.title,
                        location.order,
                        location.id,
                        location.hidden ? "'true" : "'false",
                        location.city
                    ]],
                    isNewRow
                );
            } catch (err) {
                console.error('Error updating location:', err);
                throw err;
            }
        }

        async function handleLocationInput(location, field, event) {
            isEditing.value = true;
            if (field === 'title' || field === 'city') {
                const newValue = formatTextInput(event.target.value);
                location[field] = newValue;

                // Get the sorted list and find position
                const sortedList = [...filteredAndSortedLocations.value].sort((a, b) => {  // Use filtered list
                    if (a.title < b.title) return sortDirection.value === 'asc' ? -1 : 1;
                    if (a.title > b.title) return sortDirection.value === 'asc' ? 1 : -1;
                    return 0;
                });

                const newIndex = sortedList.findIndex(loc => loc.id === location.id);
                const newPage = Math.ceil((newIndex + 1) / itemsPerPage.value);

                console.log('Location moved:', {
                    id: location.id,
                    title: location.title,
                    newIndex,
                    itemsPerPage: itemsPerPage.value,
                    calculatedPage: newPage,
                    currentPage: currentLocationsPage.value
                });

                if (newPage !== currentLocationsPage.value) {
                    currentLocationsPage.value = newPage;
                    focusNextId.value = `${location.id}-${field}`;
                }
            } else if (field === 'order') {
                location[field] = event.target.value ? parseInt(event.target.value, 10) : 0;
            } else {
                location[field] = event.target.value;
            }
        }

        async function handleLocationBlur(location) {
            // Trim any trailing spaces when the field loses focus
            if (location.title) {
                location.title = location.title.trimEnd();
            }
            if (location.city) {
                location.city = location.city.trimEnd();
            }
            
            try {
                await updateLocation(location, false);
                editingLocationId.value = null;
                applyFilterAndSort();
            } catch (err) {
                console.error('Error in handleLocationBlur:', err);
                error.value = 'Failed to update location. Please try again.';
            }
        }

        function handleKeyDown(location, field, event) {
            if (event.key === 'Tab') {
                console.log('Tab key pressed');
                const currentIndex = stableLocations.value.findIndex(loc => loc.id === location.id);
                
                let nextField, nextLocation;
                if (field === 'title') {
                    nextField = 'city';
                    nextLocation = location;
                } else if (field === 'city') {
                    const nextIndex = currentIndex + 1;
                    nextLocation = stableLocations.value[nextIndex];
                    nextField = nextLocation ? 'title' : null;
                }

                setTimeout(function() {
                    if (nextLocation) {
                        const nextIndex = stableLocations.value.findIndex(loc => loc.id === nextLocation.id);
                        const newPage = Math.floor(nextIndex / itemsPerPage.value) + 1;

                        if (newPage !== currentLocationsPage.value) {
                            currentLocationsPage.value = newPage;
                            focusNextId.value = `${nextLocation.id}-${nextField}`;
                        } else {
                            Vue.nextTick(() => {
                                const nextInput = document.querySelector(`input[data-location-id="${nextLocation.id}"][data-field="${nextField}"]`);
                                if (nextInput) nextInput.focus();
                            });
                        }
                    }
                }, 300);
            }
        }

        const areAllLocationsSelected = computed(() => {
            return filteredAndSortedLocations.value.length > 0 && 
                filteredAndSortedLocations.value.every(location => location.selected);
        });

        function toggleSelectAll() {
            const allSelected = areAllLocationsSelected.value;
            const filteredIds = filteredAndSortedLocations.value.map(loc => loc.id);
            locations.value.forEach(location => {
                if (filteredIds.includes(location.id)) {
                    location.selected = !allSelected;
                }
            });
        }

        function toggleLocationSelection(location) {
            location.selected = !location.selected;
        }

        function toggleItemSelection(item) {
            item.selected = !item.selected;
            updateSelectedItems();
        }

        function updateSelectedItems() {
            selectedItems.value = selectedLocations.value
                .filter(item => item.selected)
                .map(item => item.id);
            console.log('Updated selected items:', selectedItems.value);
        }

        watch(currentLocationsPage, () => {
            if (focusNextId.value) {
                nextTick(() => {
                    const [locationId, field] = focusNextId.value.split('-');
                    const nextInput = document.querySelector(`input[data-location-id="${locationId}"][data-field="${field}"]`);
                    if (nextInput) {
                        nextInput.focus();
                        // Move cursor to end of input
                        const len = nextInput.value.length;
                        nextInput.setSelectionRange(len, len);
                    }
                    focusNextId.value = null;
                });
            }
        });

        async function addNewLocation() {
            loading.value = true;
            error.value = null;
            
            // Clear the filter
            globalSearch.value = '';
            
            const newLocation = {
                id: `loc_${Date.now()}`,
                title: '',
                order: locations.value.length.toString(),
                hidden: false,
                city: '',
                selected: false
            };

            try {
                await updateLocation(newLocation, true);
                locations.value.push(newLocation);
                applyFilterAndSort();

                // Empty title will be first in ascending sort
                const newPage = 1;
                currentLocationsPage.value = newPage;

                // Focus the new location's title field
                await nextTick();
                const titleInput = document.querySelector(`input[data-location-id="${newLocation.id}"][data-field="title"]`);
                if (titleInput) {
                    titleInput.focus();
                }
            } catch (err) {
                console.error('Failed to add location:', err);
                error.value = 'Failed to add location. Please try again.';
            } finally {
                loading.value = false;
            }
        }

        async function deleteSelected() {
            const selectedCount = selectedLocations.value.length;
            if (selectedCount === 0) return;
            
            // Get the filtered selection count
            const filteredSelectedCount = filteredAndSortedLocations.value.filter(loc => loc.selected).length;
            
            if (confirm(`Are you sure you want to delete ${filteredSelectedCount} location(s)?`)) {
                loading.value = true;
                error.value = null;
                try {
                    // Only delete locations that are both selected AND in the filtered list
                    const filteredIds = filteredAndSortedLocations.value.map(loc => loc.id);
                    const locationsToDelete = locations.value.filter(location => 
                        location.selected && filteredIds.includes(location.id)
                    );
                    
                    // Delete each location
                    for (const location of locationsToDelete) {
                        await GoogleAuth.deleteSheetRow(
                            props.sheetId,
                            'Locations!A:E',
                            location.id,
                            true  // isLocationSheet = true
                        );
                    }

                    // Remove from local array
                    locations.value = locations.value.filter(location => 
                        !(location.selected && filteredIds.includes(location.id))
                    );
                    stableLocations.value = stableLocations.value.filter(location => 
                        !(location.selected && filteredIds.includes(location.id))
                    );
                    selectAll.value = false;

                    console.log('Locations deleted successfully');
                    applyFilterAndSort();
                } catch (err) {
                    console.error('Error deleting locations:', err);
                    error.value = 'Failed to delete locations. Please try again.';
                } finally {
                    loading.value = false;
                }
            }
        }

        function resetPagination() {
            currentLocationsPage.value = 1;
        }

        let currentModifiedTime = null;
        let changeDetectionInterval = null;

        function setupChangeDetection(sheetId, fetchLocations) {
            //The same function name is used for the LocationsPage.
            console.log("Setting up change detection for sheet:", sheetId);
            
            async function checkForChanges() {
                if (isEditing.value) {
                    console.log("User is editing, skipping change check");
                    return;
                }
                
                console.log("Checking for changes in sheet:", sheetId);
                try {
                    const metadata = await GoogleAuth.getSheetMetadata(sheetId);
                    console.log("Sheet title:", metadata.title);
                    console.log("Last checked time:", sheetLastChecked[sheetId]);
                    console.log("New modified time:", metadata.modifiedTime);
                    
                    const lastCheckedDate = sheetLastChecked[sheetId] ? new Date(sheetLastChecked[sheetId]) : null;
                    const newModifiedDate = new Date(metadata.modifiedTime);
                    
                    if (!lastCheckedDate || newModifiedDate > lastCheckedDate) {
                        sheetLastChecked[sheetId] = metadata.modifiedTime;
                        console.log('Sheet updated, refreshing data...');
                        await fetchLocations();
                    } else {
                        console.log('Sheet still up to date.');
                    }
                } catch (error) {
                    console.error('Error checking for updates:', error);
                }
            }

            // Clear existing interval if any
            if (changeDetectionInterval) {
                clearInterval(changeDetectionInterval);
            }

            // Set up new interval
            changeDetectionInterval = setInterval(checkForChanges, 30000); // Check every 30 seconds

            // Perform an initial check
            checkForChanges();
        }

        function stopChangeDetection() {
            if (changeDetectionInterval) {
                clearInterval(changeDetectionInterval);
                changeDetectionInterval = null;
            }
        }

        function getLocationColumnClass(column) {
            return `location-${column.toLowerCase()}`;
        }

        const filteredLocations = computed(() => {
            return locations.value.filter(location =>
                Object.values(location).some(value =>
                    String(value).toLowerCase().includes(globalSearch.value.toLowerCase())
                )
            );
        });

        const paginatedFilteredLocations = computed(() => {
            const startIndex = (currentPage.value - 1) * itemsPerPage.value;
            return filteredLocations.value.slice(startIndex, startIndex + itemsPerPage.value);
        });

        const filteredAndSortedLocations = computed(() => {
            let result = locations.value;
            
            // Apply global search filter
            if (globalSearch.value) {
                result = result.filter(location =>
                    Object.values(location).some(value =>
                        String(value).toLowerCase().includes(globalSearch.value.toLowerCase())
                    )
                );
            }
            
            // Apply sorting
            result = result.sort((a, b) => {
                if (a[sortColumn.value] < b[sortColumn.value]) return sortDirection.value === 'asc' ? -1 : 1;
                if (a[sortColumn.value] > b[sortColumn.value]) return sortDirection.value === 'asc' ? 1 : -1;
                return 0;
            });
            
            stableLocations.value = result;  // Update stable locations
            return result;
        });

        onMounted(() => {
            fetchLocations();
            /*if (props.setupChangeDetection) {
                props.setupChangeDetection(props.sheetId, fetchLocations);
            }*/
        });

        watch(globalSearch, debounceSearch);

        return {
            locations,
            globalSearch,
            columns,
            sortColumn,
            sortDirection,
            currentLocationsPage,
            totalPages,
            paginatedLocations,
            loading,
            error,
            sort,
            changePage,
            updateLocation,
            debounceUpdate,
            addNewLocation,
            fetchLocations,
            selectAll,
            selectedLocations,
            areAllLocationsSelected,
            toggleLocationSelection,
            toggleSelectAll,
            deleteSelected,
            debounceSearch,
            resetPagination,
            setupChangeDetection,
            stopChangeDetection,
            getLocationColumnClass,
            handleLocationInput,
            handleLocationBlur,
            handleKeyDown,
            focusNextId,
            toggleItemSelection,
            updateSelectedItems,
            filteredLocations,
            filteredAndSortedLocations
        };
    },
    template: `
        <div class="locations-page page-content">
            <div class="header">
                <div class="header-title">
                    <span class="hamburger-menu" @click="toggleSidenav">☰</span>
                    <h2>Locations <button @click="fetchLocations"><i class="icon material-icons" style="font-size: 14px;">refresh</i></button> <small v-if="loading" class="loading">Loading...</small></h2>
                    <div v-if="error" class="error">{{ error }}</div>
                </div>
                <div class="controls">
                    <div class="input-wrapper"><input type="search" v-model="globalSearch" placeholder="Search locations..." @input="debounceSearch"></div>
                    <button class="alert" @click="deleteSelected" :disabled="selectedLocations.length === 0">Delete Selected</button>
                </div>
            </div>
            <div class="locations-list responsive">
                <table>
                    <thead>
                        <tr>
                            <th width="30">
                                <input type="checkbox" 
                                    :checked="areAllLocationsSelected"
                                    @change="toggleSelectAll">
                            </th>
                            <th v-for="column in columns" :key="column" @click="sort(column)" :class="getLocationColumnClass(column)">
                                {{ column }}
                                <span v-if="sortColumn === column">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="location in paginatedLocations" :key="location.id">
                            <td class="select-checkbox" width="30">
                                <input type="checkbox" 
                                    :checked="location.selected"
                                    @change="toggleLocationSelection(location)">
                            </td>
                            <td v-for="column in columns" :key="column" :class="getLocationColumnClass(column)">
                                <input v-if="column !== 'hidden'" 
                                    type="text" 
                                    v-model="location[column]" 
                                    :data-location-id="location.id" 
                                    :data-field="column" 
                                    @input="handleLocationInput(location, column, $event)"
                                    @focus="startEditing" 
                                    @blur="($event) => { handleLocationBlur(location); stopEditing(); }"
                                    @keydown="handleKeyDown(location, column, $event)"
                                >
                                <input v-else 
                                    type="checkbox" 
                                    v-model="location.hidden"
                                    @change="updateLocation(location)"
                                >
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="pagination">
                <button @click="currentLocationsPage > 1 && currentLocationsPage--" :disabled="currentLocationsPage === 1">Previous</button>
                <span>Page {{ currentLocationsPage }} of {{ totalPages }}</span>
                <button @click="currentLocationsPage < totalPages && currentLocationsPage++" :disabled="currentLocationsPage === totalPages">Next</button>
            </div>
            <button class="add-location-button" @click="addNewLocation">Add Location</button>
        </div>
    `
};

export default LocationsPage;
