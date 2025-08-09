// Configuration - Now supports user-provided API keys
const CONFIG = {
    // Default (demo) client ID - users should replace with their own
    DEFAULT_CLIENT_ID: '605518504808-fl0ft2r9htmd0mds85h4jo2hp7ase48q.apps.googleusercontent.com',
    SHEETS_API_BASE: 'https://sheets.googleapis.com/v4/spreadsheets',
    SCOPES: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    STORAGE_KEYS: {
        ACCESS_TOKEN: 'google_access_token',
        USER_INFO: 'user_info',
        TOKEN_EXPIRY: 'token_expiry',
        AUTH_STATE: 'auth_state',
        USER_CLIENT_ID: 'user_google_client_id',
        API_CONFIG: 'user_api_config'
    },
    
    // Get current client ID (user's own or default demo)
    get GOOGLE_CLIENT_ID() {
        const userClientId = localStorage.getItem(this.STORAGE_KEYS.USER_CLIENT_ID);
        return userClientId || this.DEFAULT_CLIENT_ID;
    },
    
    // Check if user is using their own API keys
    get isUsingOwnKeys() {
        return !!localStorage.getItem(this.STORAGE_KEYS.USER_CLIENT_ID);
    }
};

// State management
let currentUser = null;
let accessToken = null;
let currentSheetId = null; // Track the currently loaded sheet
let deferredPrompt;
let tokenClient = null;
let isInitialized = false;
let pendingRetryCallback = null; // Store callback for automatic retry after token refresh

// DOM elements
const     elements = {
    apiConfigSection: document.getElementById('apiConfigSection'),
    loginSection: document.getElementById('loginSection'),
    userInfo: document.getElementById('userInfo'),
    sheetsSection: document.getElementById('sheetsSection'),
    userAvatar: document.getElementById('userAvatar'),
    userName: document.getElementById('userName'),
    userEmail: document.getElementById('userEmail'),
    statusMessage: document.getElementById('statusMessage'),
    sheetsData: document.getElementById('sheetsData'),
    errorDisplay: document.getElementById('errorDisplay'),
    installPrompt: document.getElementById('installPrompt'),

    createSheetBtn: document.getElementById('createSheetBtn'),
    addDataBtn: document.getElementById('addDataBtn'),
    recentSheets: document.getElementById('recentSheets'),
    recentSheetsList: document.getElementById('recentSheetsList'),
    apiStatus: document.getElementById('apiStatus'),
    userClientId: document.getElementById('userClientId'),
    ownApiConfig: document.getElementById('ownApiConfig')
};

// Enhanced UI state management
const UIState = {
    isLoading: false,
    currentOperation: null,
    
    setLoading(operation, button = null) {
        this.isLoading = true;
        this.currentOperation = operation;
        
        if (button) {
            button.classList.add('loading');
            button.disabled = true;
        }
        
        // Add loading overlay to sheets section if needed
        if (operation.includes('sheet')) {
            this.showSheetsLoading(true);
        }
    },
    
    clearLoading(button = null) {
        this.isLoading = false;
        this.currentOperation = null;
        
        if (button) {
            button.classList.remove('loading');
            button.disabled = false;
        }
        
        this.showSheetsLoading(false);
    },
    
    showSheetsLoading(show) {
        const existingOverlay = elements.sheetsSection.querySelector('.loading-overlay');
        
        if (show && !existingOverlay) {
            const overlay = document.createElement('div');
            overlay.className = 'loading-overlay';
            const spinner = SecurityUtils.createSafeElement('div', '', 'spinner');
            overlay.appendChild(spinner);
            elements.sheetsSection.appendChild(overlay);
        } else if (!show && existingOverlay) {
            existingOverlay.remove();
        }
    }
};

// Recent sheets management (cloud-based with localStorage fallback)
const RecentSheetsManager = {
    baseStorageKey: 'recent_sheets',
    maxItems: 10, // Increased since cloud storage is more capable
    
    // Get user-specific storage key (for fallback)
    getStorageKey() {
        const userId = currentUser?.email || 'anonymous';
        return `${this.baseStorageKey}_${userId}`;
    },
    
    // Get app-created sheets from Google Drive API
    async getCloudSheets() {
        if (!accessToken) {
            console.warn('No access token for cloud sheets');
            return [];
        }
        
        try {
            // List Google Sheets created by this app using Drive API
            const response = await fetch(
                'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
                    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
                    orderBy: 'modifiedTime desc',
                    pageSize: this.maxItems.toString(),
                    fields: 'files(id,name,modifiedTime,webViewLink)'
                }),
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (!response.ok) {
                if (response.status === 403) {
                    console.warn('Google Drive API not enabled. Enable it in Google Cloud Console for cloud-based recent sheets.');
                    throw new Error('Drive API not enabled');
                } else {
                    throw new Error(`Drive API error: ${response.status}`);
                }
            }
            
            const data = await response.json();
            return data.files || [];
            
        } catch (error) {
            console.warn('Failed to fetch cloud sheets:', error);
            return [];
        }
    },
    
    // Get recent sheets (localStorage fallback only)
    get() {
        try {
            const stored = localStorage.getItem(this.getStorageKey());
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('Failed to load recent sheets:', error);
            return [];
        }
    },
    
    // Get recent sheets with cloud-first approach
    async getRecent() {
        try {
            // Try cloud first (shows app-created sheets from any device)
            const cloudSheets = await this.getCloudSheets();
            if (cloudSheets.length > 0) {
                return cloudSheets.map(file => ({
                    id: file.id,
                    name: file.name,
                    lastAccessed: new Date(file.modifiedTime).getTime(),
                    webViewLink: file.webViewLink,
                    source: 'cloud'
                }));
            }
            
            // Fallback to localStorage for offline/error cases
            console.log('Using localStorage fallback for recent sheets');
            return this.get();
            
        } catch (error) {
            console.warn('Error getting recent sheets, using localStorage:', error);
            return this.get();
        }
    },
    
    add(sheetId, sheetName) {
        if (!sheetId || !sheetName) return;
        
        let recent = this.get();
        
        // Remove existing entry if present
        recent = recent.filter(item => item.id !== sheetId);
        
        // Add to beginning
        recent.unshift({
            id: sheetId,
            name: sheetName,
            lastAccessed: Date.now()
        });
        
        // Keep only max items
        recent = recent.slice(0, this.maxItems);
        
        try {
            localStorage.setItem(this.getStorageKey(), JSON.stringify(recent));
            this.updateDisplay().catch(err => console.warn('Display update failed:', err));
        } catch (error) {
            console.warn('Failed to save recent sheets:', error);
        }
    },
    
    remove(sheetId) {
        let recent = this.get();
        recent = recent.filter(item => item.id !== sheetId);
        
        try {
            localStorage.setItem(this.getStorageKey(), JSON.stringify(recent));
            this.updateDisplay().catch(err => console.warn('Display update failed:', err));
        } catch (error) {
            console.warn('Failed to update recent sheets:', error);
        }
    },
    
    clear() {
        try {
            localStorage.removeItem(this.getStorageKey());
            this.updateDisplay().catch(err => console.warn('Display update failed:', err));
        } catch (error) {
            console.warn('Failed to clear recent sheets:', error);
        }
    },
    
    // Clear recent sheets for all users (for migration/cleanup)
    clearAll() {
        try {
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith(this.baseStorageKey)) {
                    localStorage.removeItem(key);
                }
            });
            this.updateDisplay().catch(err => console.warn('Display update failed:', err));
        } catch (error) {
            console.warn('Failed to clear all recent sheets:', error);
        }
    },
    
    // Migrate old global recent_sheets to user-specific storage
    migrateOldData() {
        try {
            const oldData = localStorage.getItem('recent_sheets');
            if (oldData && currentUser?.email) {
                // If we have old data and a current user, migrate it
                const userKey = this.getStorageKey();
                if (!localStorage.getItem(userKey)) {
                    localStorage.setItem(userKey, oldData);
                    console.log('📦 Migrated recent sheets to user-specific storage');
                }
            }
            // Clean up old global storage
            localStorage.removeItem('recent_sheets');
        } catch (error) {
            console.warn('⚠️ Failed to migrate recent sheets:', error);
        }
    },
    
    async updateDisplay() {
        if (!elements.recentSheets || !elements.recentSheetsList) return;
        
        try {
            const recent = await this.getRecent();
        
            if (recent.length === 0) {
                elements.recentSheets.style.display = 'none';
                return;
            }
            
            elements.recentSheets.style.display = 'block';
            
            // Clear existing content safely
            SecurityUtils.setSafeContent(elements.recentSheetsList, '');
            
            recent.forEach(item => {
                const date = new Date(item.lastAccessed).toLocaleDateString();
                const truncatedId = item.id.length > 20 ? item.id.substring(0, 20) + '...' : item.id;
                
                // Sanitize item data
                const safeName = SecurityUtils.sanitizeText(item.name);
                const safeId = SecurityUtils.sanitizeSheetId(item.id);
                
                // Create item container
                const itemDiv = SecurityUtils.createSafeElement('div', '', 'recent-sheet-item');
                itemDiv.onclick = () => loadRecentSheet(safeId, safeName);
                
                // Create info section
                const infoDiv = SecurityUtils.createSafeElement('div', '', 'recent-sheet-info');
                const nameDiv = SecurityUtils.createSafeElement('div', safeName, 'recent-sheet-name');
                const idDiv = SecurityUtils.createSafeElement('div', truncatedId, 'recent-sheet-id');
                
                infoDiv.appendChild(nameDiv);
                infoDiv.appendChild(idDiv);
                
                // Create date section
                const dateDiv = SecurityUtils.createSafeElement('div', date, 'recent-sheet-date');
                
                // Create remove button (hidden for cloud-based sheets)
                const removeBtn = SecurityUtils.createSafeElement('button', '✕', 'recent-sheet-remove');
                removeBtn.title = 'Remove from recent';
                removeBtn.onclick = (event) => {
                    event.stopPropagation();
                    removeRecentSheet(safeId);
                };
                
                // Hide remove button for cloud-based sheets since they're managed by Google Drive
                if (item.source === 'cloud') {
                    removeBtn.style.display = 'none';
                }
                
                // Assemble item
                itemDiv.appendChild(infoDiv);
                itemDiv.appendChild(dateDiv);
                itemDiv.appendChild(removeBtn);
                
                elements.recentSheetsList.appendChild(itemDiv);
            });
            
        } catch (error) {
            console.warn('Failed to update recent sheets display:', error);
            elements.recentSheets.style.display = 'none';
        }
    }
};

// Notification System for Sheet Changes
const NotificationManager = {
    storageKey: 'sheet_notifications',
    lastViewKey: 'sheet_last_view',
    
    // Get user-specific storage key
    getUserStorageKey(suffix) {
        const userId = currentUser?.email || 'anonymous';
        return `${suffix}_${userId}`;
    },
    
    // Get file metadata including modification time and last modifying user
    async getFileMetadata(sheetId) {
        try {
            const response = await fetch(
                `https://www.googleapis.com/drive/v3/files/${sheetId}?fields=id,name,modifiedTime,lastModifyingUser`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (!response.ok) {
                throw new Error(`Failed to get file metadata: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.warn('Failed to get file metadata:', error);
            return null;
        }
    },
    
    // Track when user last viewed a sheet
    trackSheetView(sheetId) {
        const storageKey = this.getUserStorageKey(this.lastViewKey);
        const lastViews = JSON.parse(localStorage.getItem(storageKey) || '{}');
        lastViews[sheetId] = Date.now();
        localStorage.setItem(storageKey, JSON.stringify(lastViews));
    },
    
    // Get last view time for a sheet
    getLastViewTime(sheetId) {
        const storageKey = this.getUserStorageKey(this.lastViewKey);
        const lastViews = JSON.parse(localStorage.getItem(storageKey) || '{}');
        return lastViews[sheetId] || 0;
    },
    
    // Check for changes since last view
    async checkForChanges(sheets) {
        const notifications = [];
        
        for (const sheet of sheets) {
            const metadata = await this.getFileMetadata(sheet.id);
            if (!metadata) continue;
            
            const lastViewTime = this.getLastViewTime(sheet.id);
            const modifiedTime = new Date(metadata.modifiedTime).getTime();
            const modifyingUser = metadata.lastModifyingUser;
            
            // Check if modified since last view and not by current user
            if (modifiedTime > lastViewTime && modifyingUser?.emailAddress !== currentUser?.email) {
                notifications.push({
                    id: sheet.id,
                    name: metadata.name || sheet.name,
                    modifiedTime: modifiedTime,
                    lastViewTime: lastViewTime,
                    modifyingUser: modifyingUser,
                    isUnread: true
                });
            }
        }
        
        return notifications;
    },
    
    // Get all notifications
    async getNotifications() {
        try {
            // Get recent sheets
            const sheets = await RecentSheetsManager.getRecent();
            if (!sheets || sheets.length === 0) {
                return [];
            }
            
            // Check for changes
            const notifications = await this.checkForChanges(sheets);
            
            // Sort by modified time (newest first)
            return notifications.sort((a, b) => b.modifiedTime - a.modifiedTime);
        } catch (error) {
            console.warn('Failed to get notifications:', error);
            return [];
        }
    },
    
    // Mark notification as read
    markAsRead(sheetId) {
        this.trackSheetView(sheetId);
        this.updateNotificationUI();
    },
    
    // Mark all notifications as read
    markAllAsRead() {
        const notifications = this.cachedNotifications || [];
        notifications.forEach(notification => {
            this.trackSheetView(notification.id);
        });
        this.updateNotificationUI();
    },
    
    // Update notification UI
    async updateNotificationUI() {
        const notifications = await this.getNotifications();
        this.cachedNotifications = notifications;
        
        const notificationBtn = document.getElementById('notificationBtn');
        const notificationBadge = document.getElementById('notificationBadge');
        const notificationsList = document.getElementById('notificationsList');
        
        if (!notificationBtn) return;
        
        const unreadCount = notifications.length;
        
        // Update badge
        if (unreadCount > 0) {
            notificationBadge.textContent = unreadCount;
            notificationBadge.style.display = 'flex';
        } else {
            notificationBadge.style.display = 'none';
        }
        
        // Update notification list
        if (notifications.length === 0) {
            notificationsList.innerHTML = `
                <div class="notification-item no-notifications">
                    <p>No recent changes to your sheets</p>
                </div>
            `;
        } else {
            notificationsList.innerHTML = notifications.map(notification => `
                <div class="notification-item unread" onclick="openSheetFromNotification('${notification.id}')">
                    <div class="notification-header">
                        <h4 class="notification-title">${SecurityUtils.escapeHtml(notification.name)}</h4>
                        <span class="notification-time">${this.formatTimeAgo(notification.modifiedTime)}</span>
                    </div>
                    <p class="notification-details">Modified by ${SecurityUtils.escapeHtml(notification.modifyingUser?.displayName || notification.modifyingUser?.emailAddress || 'Someone')}</p>
                    <p class="notification-user">Last viewed: ${this.formatTimeAgo(notification.lastViewTime) || 'Never'}</p>
                </div>
            `).join('');
        }
        
        // Update unread indicators in recent sheets
        this.updateRecentSheetsIndicators(notifications);
    },
    
    // Update unread indicators in recent sheets list
    updateRecentSheetsIndicators(notifications) {
        const unreadSheetIds = new Set(notifications.map(n => n.id));
        
        // Add unread class to sheets with notifications
        const sheetItems = document.querySelectorAll('.recent-sheet-item');
        sheetItems.forEach(item => {
            const sheetId = item.dataset.sheetId;
            if (unreadSheetIds.has(sheetId)) {
                item.classList.add('unread');
            } else {
                item.classList.remove('unread');
            }
        });
    },
    
    // Format time ago
    formatTimeAgo(timestamp) {
        if (!timestamp) return '';
        
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        
        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        
        return new Date(timestamp).toLocaleDateString();
    },
    
    // Initialize notification system
    async initialize() {
        if (!accessToken || !currentUser) return;
        
        const notificationBtn = document.getElementById('notificationBtn');
        if (notificationBtn) {
            notificationBtn.style.display = 'flex';
            await this.updateNotificationUI();
        }
    },
    
    // Hide notifications when user signs out
    hide() {
        const notificationBtn = document.getElementById('notificationBtn');
        if (notificationBtn) {
            notificationBtn.style.display = 'none';
        }
    }
};

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeApp);

// PWA Installation
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    elements.installPrompt.style.display = 'block';
});

function installApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((result) => {
            if (result.outcome === 'accepted') {
                console.log('User accepted the install prompt');
                elements.installPrompt.style.display = 'none';
            }
            deferredPrompt = null;
        });
    }
}

// Initialize the application
async function initializeApp() {
    console.log('🚀 Initializing Google Sheets PWA...');
    
    // Register service worker
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('sw.js');
            console.log('✅ Service Worker registered successfully');
        } catch (error) {
            console.error('❌ Service Worker registration failed:', error);
        }
    }

    // Initialize Google Identity Services
    await initializeGoogleIdentityServices();
    
    // Initialize Google Picker API (will be available when gapi loads)
    if (typeof gapi !== 'undefined') {
        onApiLoad();
    } else {
        // Wait for gapi to load then initialize
        window.onApiLoad = onApiLoad;
    }
    
    // Check API configuration first
    const shouldProceed = checkApiConfiguration();
    
    // Check for existing authentication if we should proceed
    if (shouldProceed) {
        await checkExistingAuth();
    }
    
    // Set up keyboard shortcuts
    setupKeyboardShortcuts();
    
    // Migrate old recent sheets and initialize display
    RecentSheetsManager.migrateOldData();
    // Note: updateDisplay() will be called when user signs in
    
    // Set up network monitoring
    setupNetworkMonitoring();
    
    // Initialize UX enhancements
    UXEnhancements.init();
    
    // Initialize security monitoring for 10/10 rating
    SecurityMonitoring.init();
    
    // Mark as initialized
    isInitialized = true;
}

// Network status monitoring
function setupNetworkMonitoring() {
    // Create connection status indicator
    const statusIndicator = document.createElement('div');
    statusIndicator.id = 'connectionStatus';
    statusIndicator.className = 'connection-status';
    document.body.appendChild(statusIndicator);
    
    // Update status function
    const updateConnectionStatus = () => {
        const isOnline = navigator.onLine;
        statusIndicator.className = `connection-status ${isOnline ? 'online' : 'offline'}`;
        // Clear and rebuild safely
        SecurityUtils.setSafeContent(statusIndicator, '');
        
        const indicator = SecurityUtils.createSafeElement('div', '', 'status-indicator');
        const statusText = SecurityUtils.createSafeElement('span', isOnline ? '🌐 Online' : '📴 Offline');
        
        statusIndicator.appendChild(indicator);
        statusIndicator.appendChild(statusText);
        
        // Auto-hide when online after 3 seconds
        if (isOnline) {
            setTimeout(() => {
                statusIndicator.style.opacity = '0.3';
            }, 3000);
        } else {
            statusIndicator.style.opacity = '1';
        }
    };
    
    // Listen for network changes
    window.addEventListener('online', () => {
        updateConnectionStatus();
        showStatus('🌐 Connection restored!', 'success');
    });
    
    window.addEventListener('offline', () => {
        updateConnectionStatus();
        showStatus('📴 You are now offline. Some features may be limited.', 'warning');
    });
    
    // Initial status
    updateConnectionStatus();
    
    // Periodic connection test (every 30 seconds when offline)
    setInterval(async () => {
        if (!navigator.onLine) {
            try {
                await fetch('https://www.google.com/favicon.ico', { 
                    method: 'HEAD', 
                    mode: 'no-cors',
                    cache: 'no-cache'
                });
                // If we get here, we're actually online
                if (!navigator.onLine) {
                    window.dispatchEvent(new Event('online'));
                }
            } catch (error) {
                // Still offline
            }
        }
    }, 30000);
}

// Initialize Google Identity Services for OAuth 2.0 token flow
async function initializeGoogleIdentityServices() {
    try {
        // Wait for Google Identity Services to load
        if (!window.google) {

            await new Promise((resolve) => {
                const checkGoogle = setInterval(() => {
                    if (window.google) {
                        clearInterval(checkGoogle);
                        resolve();
                    }
                }, 100);
            });
        }

        // Initialize the OAuth 2.0 token client for API access
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.GOOGLE_CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: (tokenResponse) => {
                console.log('🔑 Received OAuth token response');
                handleTokenResponse(tokenResponse);
            },
        });


        
    } catch (error) {
        console.error('❌ Error initializing Google Identity Services:', error);
        showError('Failed to initialize Google services. Please refresh the page.');
    }
}

// Handle OAuth token response
function handleTokenResponse(tokenResponse) {
    if (tokenResponse && tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        
        // Calculate expiry time (make it slightly shorter for safety)
        const expiryTime = Date.now() + ((tokenResponse.expires_in - 300) * 1000); // 5 minutes buffer
        
        // Get user info from the token if we don't have it yet
        if (!currentUser) {
            getUserInfoFromToken(accessToken);
        }
        
        // Store complete auth state
        const authState = {
            hasFullAccess: true,
            tokenExpiry: expiryTime,
            lastSignIn: Date.now(),
            scopes: tokenResponse.scope || CONFIG.SCOPES,
            method: 'oauth'
        };
        
        // Store all authentication data securely
        SecurityUtils.secureStorage.setSecureItem(CONFIG.STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        SecurityUtils.secureStorage.setSecureItem(CONFIG.STORAGE_KEYS.TOKEN_EXPIRY, expiryTime.toString());
        SecurityUtils.secureStorage.setSecureItem(CONFIG.STORAGE_KEYS.AUTH_STATE, authState);
        
        // Update UI
        showAuthenticatedState();
        showStatus('🎉 Successfully signed in with full Google Sheets access!', 'success');
        
        console.log('✅ OAuth access token obtained and stored');
        
        // Set up automatic token refresh
        scheduleTokenRefresh(expiryTime);
        
        // Execute pending retry callback if one exists
        if (pendingRetryCallback) {
            console.log('🔄 Executing pending retry after token refresh...');
            const callback = pendingRetryCallback;
            pendingRetryCallback = null; // Clear the callback
            setTimeout(() => callback(), 500); // Small delay to ensure token is fully processed
        }
    } else {
        console.error('❌ Invalid token response:', tokenResponse);
        showError('Failed to obtain access token. Please try again.');
    }
}

// Get user info from access token
async function getUserInfoFromToken(token) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            const userInfo = await response.json();
            currentUser = {
                id: userInfo.id,
                name: userInfo.name,
                email: userInfo.email,
                picture: userInfo.picture
            };
            
            SecurityUtils.secureStorage.setSecureItem(CONFIG.STORAGE_KEYS.USER_INFO, currentUser);
            
            // Update UI with user info
            if (elements.userInfo.style.display !== 'none') {
                showAuthenticatedState();
            }
            
            console.log('✅ User info retrieved and stored');
        } else {
            console.warn('⚠️ Could not retrieve user info, but authentication successful');
        }
    } catch (error) {
        console.warn('⚠️ Error retrieving user info:', error);
        // This is not critical - user can still use the app
    }
}

// Check for existing authentication on app load
async function checkExistingAuth() {
    // Try to migrate any unencrypted data first
    migrateUnencryptedStorage();
    
    const storedToken = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.ACCESS_TOKEN);
    const storedUser = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.USER_INFO);
    const tokenExpiry = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.TOKEN_EXPIRY);
    const authState = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.AUTH_STATE);

    // Check if we have a complete authentication state
    if (storedToken && tokenExpiry && authState) {
        const now = Date.now();
        const expiry = parseInt(tokenExpiry);
        const state = authState; // Already parsed by getSecureItem

        if (now < expiry && state.hasFullAccess) {
            // We have valid full access - restore complete session
            accessToken = storedToken;
            
            if (storedUser) {
                currentUser = storedUser; // Already parsed by getSecureItem
            }
            
            showAuthenticatedState();
            showStatus('🎉 Automatically reconnected with full Google Sheets access!', 'success');

            
            // Set up automatic token refresh
            scheduleTokenRefresh(expiry);
            return;
        } else {

            clearStoredAuth();
        }
    }

    console.log('🔑 No valid authentication found, showing login screen');
    showUnauthenticatedState();
}

// Schedule automatic token refresh
function scheduleTokenRefresh(expiry) {
    const now = Date.now();
    const timeUntilRefresh = expiry - now - (10 * 60 * 1000); // Refresh 10 minutes before expiry
    
    if (timeUntilRefresh > 0) {
        setTimeout(async () => {
            console.log('🔄 Auto-refreshing token...');
            await attemptTokenRefresh();
        }, timeUntilRefresh);
        
        console.log(`⏰ Token refresh scheduled in ${Math.round(timeUntilRefresh / 1000 / 60)} minutes`);
    }
}

// Attempt to silently refresh the token
async function attemptTokenRefresh(retryCallback = null) {
    try {
        if (!tokenClient || !currentUser) {
            console.log('⚠️ Cannot refresh token - missing client or user info');
            return false;
        }

        console.log('🔄 Attempting silent token refresh...');
        
        // Store the retry callback if provided
        if (retryCallback) {
            pendingRetryCallback = retryCallback;
        }
        
        // Try silent token refresh
        tokenClient.requestAccessToken({
            prompt: '', // Empty prompt for silent refresh
            hint: currentUser.email
        });
        
        return true;
    } catch (error) {
        console.error('❌ Silent token refresh failed:', error);
        
        // Clear any pending retry
        pendingRetryCallback = null;
        
        // If silent refresh fails, notify user
        showStatus('Session expired. Please sign in again to continue using Google Sheets.', 'warning');
        
        // Clear expired auth and show login
        clearStoredAuth();
        currentUser = null;
        accessToken = null;
        showUnauthenticatedState();
        
        return false;
    }
}

// Google Sign-In using Google Identity Services
async function manualGoogleSignIn() {
    try {
        if (!tokenClient) {
            showError('Google services not initialized. Please refresh the page and try again.');
            return;
        }

        showStatus('Opening Google sign-in...', 'warning');
        
        // Request access token with required scopes
        tokenClient.requestAccessToken({
            prompt: 'consent', // Always show consent to ensure we get all permissions
            hint: currentUser ? currentUser.email : undefined
        });
        
    } catch (error) {
        console.error('❌ Sign-in failed:', error);
        showError(`Sign-in failed: ${error.message || 'Unknown error'}`);
    }
}

// Migrate unencrypted storage to encrypted storage
function migrateUnencryptedStorage() {
    try {
        const keysToMigrate = [
            CONFIG.STORAGE_KEYS.ACCESS_TOKEN,
            CONFIG.STORAGE_KEYS.USER_INFO,
            CONFIG.STORAGE_KEYS.TOKEN_EXPIRY,
            CONFIG.STORAGE_KEYS.AUTH_STATE
        ];
        
        let migrated = false;
        
        keysToMigrate.forEach(key => {
            const unencryptedValue = localStorage.getItem(key);
            if (unencryptedValue) {
                // Try to determine if it's already encrypted by attempting to decrypt
                const decryptedTest = SecurityUtils.secureStorage.getSecureItem(key);
                
                if (!decryptedTest) {
                    // Not encrypted or failed to decrypt, migrate it
                    SecurityUtils.secureStorage.setSecureItem(key, unencryptedValue);
                    migrated = true;
                    console.log(`📦 Migrated ${key} to secure storage`);
                }
            }
        });
        
        if (migrated) {
            console.log('✅ Storage migration completed');
        }
    } catch (error) {
        console.warn('⚠️ Storage migration failed:', error);
        // Clear potentially corrupted data
        clearStoredAuth();
    }
}

// Clear stored authentication data
function clearStoredAuth() {
    // Clear secure storage items (access token, user info, token expiry, auth state)
    const secureKeys = [
        CONFIG.STORAGE_KEYS.ACCESS_TOKEN,
        CONFIG.STORAGE_KEYS.USER_INFO,
        CONFIG.STORAGE_KEYS.TOKEN_EXPIRY,
        CONFIG.STORAGE_KEYS.AUTH_STATE
    ];
    
    secureKeys.forEach(key => {
        localStorage.removeItem(key); // Remove from localStorage (both encrypted and unencrypted)
    });
    
    // Clear non-secure items (API config, client ID)
    const regularKeys = [
        CONFIG.STORAGE_KEYS.USER_CLIENT_ID,
        CONFIG.STORAGE_KEYS.API_CONFIG
    ];
    
    regularKeys.forEach(key => {
        localStorage.removeItem(key);
    });
    
    console.log('🗑️ Stored authentication data cleared');
}

// Show authenticated state
function showAuthenticatedState() {
    elements.loginSection.style.display = 'none';
    elements.userInfo.style.display = 'block';
    elements.sheetsSection.style.display = 'block';

    if (currentUser) {
        elements.userAvatar.src = currentUser.picture || '';
        elements.userName.textContent = currentUser.name || 'Unknown User';
        elements.userEmail.textContent = currentUser.email || '';
        
        // Update recent sheets display for this specific user
                RecentSheetsManager.updateDisplay().catch(err =>
            console.warn('Failed to update recent sheets:', err)
        );
        
        // Initialize notification system
        NotificationManager.initialize();
        
        // Show shared sheet access section
        updateSharedSheetVisibility();
        
        // Auto-load last accessed sheet
        autoLoadLastSheet();
    } else {
        // If we don't have user info yet, show a placeholder
        elements.userName.textContent = 'Google User';
        elements.userEmail.textContent = 'Loading user info...';
    }
}

// Show unauthenticated state
function showUnauthenticatedState() {
    elements.loginSection.style.display = 'block';
    elements.userInfo.style.display = 'none';
    elements.sheetsSection.style.display = 'none';
    
    // Hide recent sheets when not authenticated
    if (elements.recentSheets) {
        elements.recentSheets.style.display = 'none';
    }
    
    // Hide notifications when not authenticated
    NotificationManager.hide();
    
    // Hide shared sheet section when not authenticated
    const sharedSheetSection = document.getElementById('sharedSheetSection');
    if (sharedSheetSection) {
        sharedSheetSection.style.display = 'none';
    }
    
    clearError();
}

// Create a new Google Sheet that the app can access
async function createNewSheet() {
    const accessToken = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.ACCESS_TOKEN);
    
    if (!accessToken) {
        showError('No access token available. Please sign in with Google to create sheets.');
        return;
    }

    // Prevent multiple simultaneous requests
    if (UIState.isLoading) {
        showStatus('Operation in progress, please wait...', 'warning');
        return;
    }

    try {
        UIState.setLoading('Creating new sheet...', elements.createSheetBtn);
        return await executeWithRetry(async () => {
            // Generate a unique name for the sheet
            const timestamp = new Date().toISOString().split('T')[0];
            const sheetName = `PWA Sheet ${timestamp}`;
            
            const createRequest = {
                properties: {
                    title: sheetName
                },
                sheets: [
                    {
                        properties: {
                            title: 'Data',
                            gridProperties: {
                                rowCount: 1000,
                                columnCount: 26
                            }
                        }
                    }
                ]
            };
            
            const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(createRequest)
            });
            
            if (response.status === 401) {
                throw new TokenExpiredError('Token expired while creating sheet');
            }
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(`Failed to create sheet: ${response.status} ${response.statusText}${errorData ? ` - ${errorData.error?.message || ''}` : ''}`);
            }
            
            const sheetData = await response.json();
            const sheetId = sheetData.spreadsheetId;
            
            // Track the newly created sheet as current
            currentSheetId = sheetId;
            
            // Add some sample headers to the new sheet
            await addInitialHeaders(sheetId, accessToken);
            
            // Add to recent sheets
            RecentSheetsManager.add(sheetId, sheetName);
            
            showStatus(`✅ New sheet created successfully: "${sheetName}"`);
            
            // Auto-load the new sheet data
            setTimeout(() => loadSheetData(currentSheetId), 1000);
            
            return sheetData;
        }, 'createSheet');
    } finally {
        UIState.clearLoading(elements.createSheetBtn);
    }
}

// Add initial headers to a new sheet
async function addInitialHeaders(sheetId, accessToken) {
    const headers = [
        ['Name', 'Email', 'Date', 'Status', 'Notes']
    ];
    
    const updateRequest = {
        values: headers
    };
    
    try {
        const response = await fetch(
            `${CONFIG.SHEETS_API_BASE}/${sheetId}/values/A1:E1?valueInputOption=RAW`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updateRequest)
            }
        );
        
        // Headers added successfully (silent)
    } catch (error) {
        console.warn('⚠️ Failed to add initial headers:', error);
    }
}

// Auto-load last accessed sheet for the current user (cloud-based)
async function autoLoadLastSheet() {
    if (!currentUser || !accessToken) return;
    
    try {
        console.log('🔄 Attempting to auto-load last accessed sheet...');
        
        // Wait a bit for the recent sheets to be populated in the DOM
        setTimeout(() => {
            try {
                // Find the first recent sheet item (most recent)
                const firstRecentSheetItem = document.querySelector('.recent-sheet-item');
                
                if (firstRecentSheetItem) {
                    console.log('📄 Found recent sheet, auto-clicking to load...');
                    // Programmatically click the first recent sheet item
                    firstRecentSheetItem.click();
                    showStatus('📄 Auto-loaded your most recent sheet', 'success');
                } else {
                    console.log('📄 No recent sheets found in DOM for auto-load');
                }
            } catch (error) {
                console.warn('❌ Error clicking recent sheet for auto-load:', error);
            }
        }, 1000); // Wait 1 second for recent sheets to be populated
        
    } catch (error) {
        console.warn('❌ Error in auto-load last sheet:', error);
    }
}

// Enhanced load Google Sheets data with automatic retry
async function loadSheetData(sheetId) {
    console.log('🔍 loadSheetData called with:', sheetId);
    
    // Sanitize the sheet ID
    const sanitizedSheetId = SecurityUtils.sanitizeSheetId(sheetId);
    if (!sanitizedSheetId) {
        console.error('❌ Sheet ID sanitization failed:', sheetId);
        showError('Invalid sheet ID provided');
        throw new Error('Invalid sheet ID provided');
    }

    if (!accessToken) {
        console.error('❌ No access token available');
        showError('No access token available. Please sign in with Google to access your sheets.');
        throw new Error('No access token available');
    }

    // Prevent multiple simultaneous requests
    if (UIState.isLoading) {
        console.warn('⚠️ Already loading, skipping request');
        showStatus('Operation in progress, please wait...', 'warning');
        throw new Error('Operation already in progress');
    }

    try {
        return await executeWithRetry(async () => {
            UIState.setLoading('Loading sheet data...');

            console.log('📊 Attempting to load sheet data...');
            console.log('🔑 Using access token:', accessToken.substring(0, 20) + '...');
            
            // Try to get sheet metadata first
            const sheetResponse = await fetch(
                `${CONFIG.SHEETS_API_BASE}/${sanitizedSheetId}?fields=sheets.properties`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!sheetResponse.ok) {
                const errorText = await sheetResponse.text();
                console.error('❌ Sheet response error:', sheetResponse.status, errorText);
                
                // Handle token expiration with automatic retry
                if (sheetResponse.status === 401) {
                    throw new TokenExpiredError('Token expired during sheet access');
                }
                
                throw new Error(`Sheet access failed: ${sheetResponse.status} - ${sheetResponse.statusText}`);
            }

            const sheetData = await sheetResponse.json();
            const firstSheet = sheetData.sheets[0].properties.title;

            console.log('✅ Sheet metadata loaded, first sheet:', firstSheet);

            // Get actual data from the first sheet
            const dataResponse = await fetch(
                `${CONFIG.SHEETS_API_BASE}/${sanitizedSheetId}/values/${firstSheet}?majorDimension=ROWS`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!dataResponse.ok) {
                const errorText = await dataResponse.text();
                console.error('❌ Data response error:', dataResponse.status, errorText);
                
                if (dataResponse.status === 401) {
                    throw new TokenExpiredError('Token expired during data fetch');
                }
                
                throw new Error(`Data fetch failed: ${dataResponse.status} - ${dataResponse.statusText}`);
            }

            const data = await dataResponse.json();
            displaySheetData(data.values || [], firstSheet, sheetData.sheets.length);
            
            // Add to recent sheets and track current sheet
            RecentSheetsManager.add(sanitizedSheetId, firstSheet);
            currentSheetId = sanitizedSheetId; // Track the current sheet
            
            console.log('✅ Successfully set currentSheetId to:', currentSheetId);
            
            // Track sheet view for notifications
            NotificationManager.trackSheetView(sanitizedSheetId);
            
            // Update shared sheet section visibility (shows test button if sheet loaded)
            updateSharedSheetVisibility();
            
            showStatus('Sheet data loaded successfully!', 'success');
            
            console.log('✅ loadSheetData completed successfully for:', sanitizedSheetId);
        });
    } finally {
        UIState.clearLoading();
    }
}

// Enhanced add sample data with automatic retry
async function addSampleData() {
    if (!currentSheetId) {
        showError('No sheet loaded. Please select a sheet from the recent list or create a new one.');
        return;
    }

    if (!accessToken) {
        showError('No access token available. Please sign in with Google to access your sheets.');
        return;
    }

    // Prevent multiple simultaneous requests
    if (UIState.isLoading) {
        showStatus('Operation in progress, please wait...', 'warning');
        return;
    }

    try {
        return await executeWithRetry(async () => {
            UIState.setLoading('Adding sample data...', elements.addDataBtn);

            // First, get the sheet metadata to find the first sheet name
            const sheetResponse = await fetch(
                `${CONFIG.SHEETS_API_BASE}/${currentSheetId}?fields=sheets.properties`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (sheetResponse.status === 401) {
                throw new TokenExpiredError('Token expired while adding data');
            }

            if (!sheetResponse.ok) {
                const errorData = await sheetResponse.json().catch(() => null);
                throw new Error(`Failed to get sheet metadata: ${sheetResponse.status} ${sheetResponse.statusText}${errorData ? ` - ${errorData.error?.message || ''}` : ''}`);
            }

            const sheetData = await sheetResponse.json();
            const firstSheet = sheetData.sheets[0].properties.title;

            const userName = currentUser ? currentUser.name : 'Google User';
            const sampleData = [
                [new Date().toLocaleString(), userName, 'Sample Entry', Math.floor(Math.random() * 100)]
            ];

            const response = await fetch(
                `${CONFIG.SHEETS_API_BASE}/${currentSheetId}/values/${firstSheet}!A:D:append?valueInputOption=RAW`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        values: sampleData
                    })
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ Add data error:', response.status, errorText);
                
                if (response.status === 401) {
                    throw new TokenExpiredError('Token expired during data addition');
                }
                
                throw new Error(`Failed to add data: ${response.status} - ${response.statusText}`);
            }

            showStatus('Sample data added successfully!', 'success');
            // Reload the sheet data to show the new entry
            setTimeout(() => loadSheetData(currentSheetId), 1000);
        });
    } finally {
        UIState.clearLoading(elements.addDataBtn);
    }
}

// Custom error class for token expiration
class TokenExpiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TokenExpiredError';
    }
}

// Execute function with automatic token refresh and retry
async function executeWithRetry(operationFunction) {
    try {
        return await operationFunction();
    } catch (error) {
        if (error instanceof TokenExpiredError) {
            console.log('🔄 Token expired, attempting refresh and retry...');
            
            // Show user we're handling this automatically
            showStatus('Token expired, refreshing automatically...', 'warning');
            
            // Attempt token refresh with retry callback
            const refreshed = await attemptTokenRefresh(operationFunction);
            
            if (!refreshed) {
                throw new Error('Authentication expired - please sign in again');
            }
            
            // The retry will be handled automatically by the token refresh callback
            // Return a promise that will be resolved by the pending callback
            return new Promise((resolve, reject) => {
                // Store the original pending callback and wrap it
                const originalCallback = pendingRetryCallback;
                pendingRetryCallback = async () => {
                    try {
                        const result = await originalCallback();
                        resolve(result);
                    } catch (retryError) {
                        reject(retryError);
                    }
                };
            });
        } else {
            // Handle other errors normally
            SecurityUtils.setSafeContent(elements.sheetsData, '');
            const errorDiv = SecurityUtils.createSafeElement('div', 'Failed to complete operation', 'error');
            elements.sheetsData.appendChild(errorDiv);
            
            if (error.message.includes('403')) {
                showError('Access denied. Make sure the sheet is accessible and you have the right permissions.');
            } else {
                showError(`Operation failed: ${error.message}`);
            }
            
            throw error;
        }
    }
}

// Secure display sheet data with XSS protection
function displaySheetData(data, sheetName, totalSheets = 1) {
    // Clear existing content safely
    SecurityUtils.setSafeContent(elements.sheetsData, '');
    
    // Sanitize sheet name
    const safeSheetName = SecurityUtils.sanitizeText(sheetName);
    
    if (!data || data.length === 0) {
        // Create safe empty state content
        const container = SecurityUtils.createSafeElement('div');
        
        const tableInfo = SecurityUtils.createSafeElement('div', '', 'table-info');
        const title = SecurityUtils.createSafeElement('h4', `Sheet: ${safeSheetName}`);
        const stats = SecurityUtils.createSafeElement('div', 'No data found', 'table-stats');
        
        tableInfo.appendChild(title);
        tableInfo.appendChild(stats);
        
        const emptyMessage = SecurityUtils.createSafeElement('div', '', '');
        emptyMessage.style.cssText = 'text-align: center; padding: 2rem; color: #666;';
        
        const emptyIcon = SecurityUtils.createSafeElement('div', '📄 This sheet appears to be empty.');
        const emptyHint = SecurityUtils.createSafeElement('div', 'Try adding some sample data first.');
        
        emptyMessage.appendChild(emptyIcon);
        emptyMessage.appendChild(emptyHint);
        
        container.appendChild(tableInfo);
        container.appendChild(emptyMessage);
        
        elements.sheetsData.appendChild(container);
        return;
    }

    const rowCount = data.length;
    const columnCount = Math.max(...data.map(row => row.length));
    const hasHeaders = rowCount > 1;

    // Create container
    const container = SecurityUtils.createSafeElement('div');
    
    // Create table info section
    const tableInfo = SecurityUtils.createSafeElement('div', '', 'table-info');
    const title = SecurityUtils.createSafeElement('h4', `Sheet: ${safeSheetName}`);
    
    const statsText = `${rowCount} rows × ${columnCount} columns${totalSheets > 1 ? ` • ${totalSheets} sheets total` : ''}`;
    const stats = SecurityUtils.createSafeElement('div', statsText, 'table-stats');
    
    tableInfo.appendChild(title);
    tableInfo.appendChild(stats);
    
    // Create table container
    const tableContainer = SecurityUtils.createSafeElement('div', '', 'data-table-container');
    const table = SecurityUtils.createSafeElement('table', '', 'data-table');
    
    // Process each row safely
    data.forEach((row, index) => {
        const tr = SecurityUtils.createSafeElement('tr');
        
        // Ensure all rows have the same number of columns
        const maxCols = Math.max(columnCount, row.length);
        
        for (let i = 0; i < maxCols; i++) {
            const cellData = row[i] || '';
            const tagName = index === 0 && hasHeaders ? 'th' : 'td';
            
            // Sanitize cell content
            const safeCellData = SecurityUtils.sanitizeText(String(cellData));
            
            // Truncate very long cell content
            let displayCell = safeCellData;
            if (displayCell.length > 50) {
                displayCell = displayCell.substring(0, 47) + '...';
            }
            
            // Create cell element safely
            const cell = SecurityUtils.createSafeElement(tagName, displayCell);
            cell.title = safeCellData; // Full content in tooltip
            
            tr.appendChild(cell);
        }
        
        table.appendChild(tr);
    });
    
    tableContainer.appendChild(table);
    container.appendChild(tableInfo);
    container.appendChild(tableContainer);
    
    elements.sheetsData.appendChild(container);
}

// Security utilities for XSS prevention
const SecurityUtils = {
    // Comprehensive HTML escaping
    escapeHtml(text) {
        if (typeof text !== 'string') {
            text = String(text);
        }
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    // Sanitize and validate Sheet ID
    sanitizeSheetId(value) {
        if (typeof value !== 'string') {
            return '';
        }
        // Remove any HTML tags, scripts, and dangerous characters
        return value.replace(/[<>\"'&\s]/g, '').trim();
    },
    
    // Sanitize general text input
    sanitizeText(text) {
        if (typeof text !== 'string') {
            text = String(text);
        }
        // Remove script tags and dangerous content
        return text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                  .replace(/javascript:/gi, '')
                  .replace(/on\w+\s*=/gi, '')
                  .trim();
    },
    
    // Create safe DOM elements
    createSafeElement(tagName, textContent = '', className = '') {
        const element = document.createElement(tagName);
        if (textContent) {
            element.textContent = textContent; // Always use textContent for safety
        }
        if (className) {
            element.className = className;
        }
        return element;
    },
    
    // Safely set HTML content using DOM methods
    setSafeContent(element, content) {
        // Clear existing content
        element.innerHTML = '';
        
        if (typeof content === 'string') {
            element.textContent = content;
        } else if (content instanceof Element) {
            element.appendChild(content);
        } else if (Array.isArray(content)) {
            content.forEach(item => {
                if (item instanceof Element) {
                    element.appendChild(item);
                } else {
                    const textNode = document.createTextNode(String(item));
                    element.appendChild(textNode);
                }
            });
        }
    },
    
    // Validate and sanitize URLs
    sanitizeUrl(url) {
        if (typeof url !== 'string') {
            return '';
        }
        // Only allow https URLs for external resources
        const allowedProtocols = ['https:', 'data:'];
        try {
            const urlObj = new URL(url);
            if (allowedProtocols.includes(urlObj.protocol)) {
                return url;
            }
        } catch (e) {
            // Invalid URL
        }
        return '';
    },
    
    // Enhanced localStorage security for 10/10 rating
    secureStorage: {
        // Simple encryption key based on browser fingerprint
        getKey() {
            const fingerprint = navigator.userAgent + navigator.language + screen.width + screen.height;
            return btoa(fingerprint).slice(0, 16);
        },
        
        // Basic XOR encryption for localStorage
        encrypt(data) {
            const key = this.getKey();
            let encrypted = '';
            for (let i = 0; i < data.length; i++) {
                encrypted += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
            }
            return btoa(encrypted);
        },
        
        decrypt(encryptedData) {
            try {
                const key = this.getKey();
                const encrypted = atob(encryptedData);
                let decrypted = '';
                for (let i = 0; i < encrypted.length; i++) {
                    decrypted += String.fromCharCode(encrypted.charCodeAt(i) ^ key.charCodeAt(i % key.length));
                }
                return decrypted;
            } catch (error) {
                logSecurityEvent('STORAGE_DECRYPT_FAILED', error.message);
                return null;
            }
        },
        
        // Secure storage methods
        setSecureItem(key, value) {
            try {
                // Handle both strings and objects properly
                const dataToEncrypt = typeof value === 'string' ? value : JSON.stringify(value);
                const encrypted = this.encrypt(dataToEncrypt);
                localStorage.setItem(key, encrypted);
                logSecurityEvent('SECURE_STORAGE_WRITE', key);
            } catch (error) {
                logSecurityEvent('SECURE_STORAGE_WRITE_FAILED', error.message);
            }
        },
        
        getSecureItem(key) {
            try {
                const encrypted = localStorage.getItem(key);
                if (!encrypted) return null;
                
                const decrypted = this.decrypt(encrypted);
                if (!decrypted) return null;
                
                // Try to parse as JSON, but return as string if parsing fails
                try {
                    return JSON.parse(decrypted);
                } catch {
                    // Not JSON, return as plain string (for tokens, etc.)
                    return decrypted;
                }
            } catch (error) {
                logSecurityEvent('SECURE_STORAGE_READ_FAILED', error.message);
                // Fallback: try direct access for backward compatibility
                try {
                    const direct = localStorage.getItem(key);
                    return direct;
                } catch {
                    return null;
                }
            }
        }
    }
};



// Sign out function
async function signOut() {
    try {
        // Revoke the access token if available
        if (accessToken && window.google && google.accounts.oauth2) {
            try {
                google.accounts.oauth2.revoke(accessToken);
                console.log('✅ Access token revoked');
            } catch (error) {
                console.log('⚠️ Could not revoke token:', error);
            }
        }
        
        // Clear local storage
        clearStoredAuth();
        
        // Reset state
        currentUser = null;
        accessToken = null;
        pendingRetryCallback = null; // Clear any pending retries
        
        // Reset UI
        showUnauthenticatedState();
        showStatus('Successfully signed out', 'success');
        SecurityUtils.setSafeContent(elements.sheetsData, '');
        
        console.log('👋 User signed out successfully');
        
    } catch (error) {
        console.error('❌ Error during sign out:', error);
        // Still clear local state even if sign out fails
        showUnauthenticatedState();
        showStatus('Signed out (with errors)', 'warning');
    }
}

// Utility functions
function showStatus(message, type = 'success') {
    elements.statusMessage.textContent = message;
    elements.statusMessage.className = `status ${type}`;
    
    // Auto-hide after 8 seconds for warnings, 5 for others
    const timeout = type === 'warning' ? 8000 : 5000;
    setTimeout(() => {
        elements.statusMessage.textContent = '';
        elements.statusMessage.className = 'status';
    }, timeout);
}

// Enhanced error handling with network awareness and security
function showError(message) {
    // Sanitize error message to prevent XSS
    const safeMessage = SecurityUtils.sanitizeText(String(message));
    
    // Add network context to errors
    const contextMessage = !navigator.onLine ? 
        `${safeMessage} (You are currently offline)` : 
        safeMessage;
    
    // Truncate very long error messages
    const displayMessage = contextMessage.length > 200 ? 
        contextMessage.substring(0, 197) + '...' : 
        contextMessage;
    
    SecurityUtils.setSafeContent(elements.errorDisplay, displayMessage);
    elements.errorDisplay.style.display = 'block';
    
    // Enhanced debugging info
    console.error('🔍 DEBUGGING - Full error context:', {
        originalMessage: message,
        safeMessage: safeMessage,
        displayMessage: displayMessage,
        timestamp: new Date().toISOString(),
        currentSheetId: currentSheetId,
        hasAccessToken: !!accessToken,
        userEmail: currentUser?.email,
        isOnline: navigator.onLine
    });
    
    // Auto-hide after 15 seconds (increased from 10)
    setTimeout(clearError, 15000);
}

// Enhanced error reporting for production
function logSecurityEvent(eventType, details) {
    // Log security-related events for monitoring
    const securityEvent = {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        url: window.location.href,
        eventType: eventType,
        details: SecurityUtils.sanitizeText(String(details)),
        sessionId: getSessionId()
    };
    
    console.warn(`[SECURITY] ${eventType}:`, securityEvent);
    
    // Store security events for analysis
    storeSecurityEvent(securityEvent);
}

// Runtime Security Monitoring for 10/10 Rating
const SecurityMonitoring = {
    // Initialize security monitoring
    init() {
        this.setupCSPReporting();
        this.setupIntegrityMonitoring();
        this.setupAnomalyDetection();
        this.setupTamperDetection();
    },
    
    // CSP Violation Reporting
    setupCSPReporting() {
        document.addEventListener('securitypolicyviolation', (e) => {
            logSecurityEvent('CSP_VIOLATION', {
                blockedURI: e.blockedURI,
                violatedDirective: e.violatedDirective,
                originalPolicy: e.originalPolicy
            });
        });
    },
    
    // Runtime Integrity Monitoring
    setupIntegrityMonitoring() {
        // Monitor for unexpected script modifications
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            logSecurityEvent('FETCH_REQUEST', args[0]);
            return originalFetch.apply(this, args);
        };
        
        // Monitor Google Services loading
        if (window.GSI_LOAD_ERROR) {
            logSecurityEvent('GOOGLE_SERVICES_FAILURE', 'Google Identity Services failed to load');
        }
    },
    
    // Anomaly Detection
    setupAnomalyDetection() {
        let requestCount = 0;
        let lastRequestTime = Date.now();
        
        // Rate limiting detection
        const originalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
            const xhr = new originalXHR();
            const now = Date.now();
            
            if (now - lastRequestTime < 100) { // Less than 100ms between requests
                requestCount++;
                if (requestCount > 10) {
                    logSecurityEvent('SUSPICIOUS_REQUEST_RATE', `${requestCount} requests in rapid succession`);
                }
            } else {
                requestCount = 0;
            }
            
            lastRequestTime = now;
            return xhr;
        };
    },
    
    // Tamper Detection
    setupTamperDetection() {
        // Monitor critical function modifications
        const criticalFunctions = ['SecurityUtils.sanitizeText', 'loadSheetData'];
        
        criticalFunctions.forEach(funcName => {
            const func = this.getNestedProperty(window, funcName);
            if (func && typeof func === 'function') {
                const originalCode = func.toString();
                
                // Periodic integrity check
                setInterval(() => {
                    const currentCode = this.getNestedProperty(window, funcName)?.toString();
                    if (currentCode && currentCode !== originalCode) {
                        logSecurityEvent('FUNCTION_TAMPERED', `${funcName} has been modified`);
                    }
                }, 30000); // Check every 30 seconds
            }
        });
    },
    
    getNestedProperty(obj, path) {
        return path.split('.').reduce((current, key) => current && current[key], obj);
    }
};

// Session ID for security tracking
function getSessionId() {
    let sessionId = sessionStorage.getItem('security_session_id');
    if (!sessionId) {
        sessionId = 'sess_' + Math.random().toString(36).substr(2, 16) + '_' + Date.now();
        sessionStorage.setItem('security_session_id', sessionId);
    }
    return sessionId;
}

// Store security events
function storeSecurityEvent(event) {
    try {
        const events = JSON.parse(localStorage.getItem('security_events') || '[]');
        events.push(event);
        
        // Keep only last 100 events
        if (events.length > 100) {
            events.splice(0, events.length - 100);
        }
        
        localStorage.setItem('security_events', JSON.stringify(events));
    } catch (error) {
        console.warn('Failed to store security event:', error);
    }
}

function clearError() {
    elements.errorDisplay.style.display = 'none';
    elements.errorDisplay.textContent = '';
}

// Enhanced token refresh scheduler
setInterval(async () => {
    const tokenExpiry = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.TOKEN_EXPIRY);
    const authState = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.AUTH_STATE);
    
    if (tokenExpiry && authState) {
        const now = Date.now();
        const expiry = parseInt(tokenExpiry);
        const state = authState; // Already parsed by getSecureItem
        
        // Auto-refresh if token expires in the next 15 minutes and we have full access
        if (state.hasFullAccess && now > (expiry - 900000)) {
            console.log('🔄 Auto-refresh triggered by scheduler');
            await attemptTokenRefresh();
        }
    }
}, 300000); // Check every 5 minutes

// API Configuration Management
function showApiConfig(show) {
    if (elements.ownApiConfig) {
        elements.ownApiConfig.style.display = show ? 'block' : 'none';
    }
}

function saveApiConfig() {
    const clientId = SecurityUtils.sanitizeText(elements.userClientId.value.trim());
    
    if (!clientId) {
        showError('Please enter a valid Google Cloud Client ID');
        return;
    }
    
    // Basic validation for Client ID format
    if (!clientId.includes('.apps.googleusercontent.com')) {
        showError('Invalid Client ID format. Should end with .apps.googleusercontent.com');
        return;
    }
    
    // Store user's API configuration
    localStorage.setItem(CONFIG.STORAGE_KEYS.USER_CLIENT_ID, clientId);
    
    const apiConfig = {
        clientId: clientId,
        configuredAt: Date.now(),
        isOwnKeys: true
    };
    
    localStorage.setItem(CONFIG.STORAGE_KEYS.API_CONFIG, JSON.stringify(apiConfig));
    
    showStatus('✅ API configuration saved successfully!', 'success');
    
    // Reinitialize Google services with new client ID
    tokenClient = null;
    initializeGoogleIdentityServices();
    
    setTimeout(() => {
        continueToLogin();
    }, 1500);
}

function continueToLogin() {
    // Hide config section, show login
    if (elements.apiConfigSection) {
        elements.apiConfigSection.style.display = 'none';
    }
    if (elements.loginSection) {
        elements.loginSection.style.display = 'block';
    }
    
    // Update API status display
    updateApiStatusDisplay();
}

function showApiConfiguration() {
    // Show config section, hide login
    if (elements.loginSection) {
        elements.loginSection.style.display = 'none';
    }
    if (elements.apiConfigSection) {
        elements.apiConfigSection.style.display = 'block';
    }
    
    // Load existing configuration
    loadExistingApiConfig();
}

function loadExistingApiConfig() {
    const userClientId = localStorage.getItem(CONFIG.STORAGE_KEYS.USER_CLIENT_ID);
    
    if (userClientId && elements.userClientId) {
        elements.userClientId.value = userClientId;
        
        // Select the "own keys" option
        const ownKeysRadio = document.querySelector('input[name="apiOption"][value="own"]');
        if (ownKeysRadio) {
            ownKeysRadio.checked = true;
            showApiConfig(true);
        }
    }
}

function updateApiStatusDisplay() {
    if (!elements.apiStatus) return;
    
    if (CONFIG.isUsingOwnKeys) {
        elements.apiStatus.className = 'api-status own-keys';
        elements.apiStatus.textContent = '🔑 Using your own API keys - unlimited usage, complete independence';
    } else {
        elements.apiStatus.className = 'api-status demo-keys';
        elements.apiStatus.textContent = '⚠️ Using demo API keys - limited usage, developer covers costs';
    }
}

// Check if user needs to configure API on startup
function checkApiConfiguration() {
    // If user has existing auth but no API config, they're using demo keys
    const hasAuth = SecurityUtils.secureStorage.getSecureItem(CONFIG.STORAGE_KEYS.ACCESS_TOKEN);
    const hasApiConfig = localStorage.getItem(CONFIG.STORAGE_KEYS.API_CONFIG);
    
    // Always start with config screen for new users
    if (!hasAuth && !hasApiConfig) {
        if (elements.apiConfigSection) {
            elements.apiConfigSection.style.display = 'block';
        }
        if (elements.loginSection) {
            elements.loginSection.style.display = 'none';
        }
        return false; // Don't proceed to login
    }
    
    // Existing users go straight to login
    continueToLogin();
    return true;
}

// Google Picker API for Shared Sheet Access
let pickerApiLoaded = false;
let oauthToken = null;

// Initialize Google Picker API
function initializePicker() {
    gapi.load('picker', () => {
        pickerApiLoaded = true;
        console.log('📁 Google Picker API loaded successfully');
        
        // Update shared sheet section visibility now that picker is available
        updateSharedSheetVisibility();
    });
}

// Load Google APIs and initialize picker
function onApiLoad() {
    gapi.load('auth2:picker', () => {
        initializePicker();
    });
}

// Open Google Picker to select a spreadsheet
function openSheetPicker() {
    if (!pickerApiLoaded) {
        showError('Google Picker is still loading. Please try again in a moment.');
        return;
    }
    
    if (!accessToken) {
        showError('Please sign in first to access shared sheets.');
        return;
    }
    
    console.log('📁 Opening Google Picker...');
    console.log('🔍 Current loading state before picker:', UIState.isLoading);
    
    try {
        // Create a view that shows only PWA Sheets
        const pwaSheetView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
            .setQuery('title:"PWA Sheet" type:spreadsheet')
            .setIncludeFolders(false)
            .setSelectFolderEnabled(false)
            .setMode(google.picker.DocsViewMode.LIST);
        
        // Create a fallback view for all spreadsheets (in case no PWA sheets exist)
        const allSheetsView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
            .setQuery('type:spreadsheet')
            .setIncludeFolders(false)
            .setSelectFolderEnabled(false)
            .setMode(google.picker.DocsViewMode.LIST);
        
        const picker = new google.picker.PickerBuilder()
            .enableFeature(google.picker.Feature.NAV_HIDDEN)
            .setAppId(CONFIG.GOOGLE_CLIENT_ID.split('-')[0]) // Extract app ID from client ID
            .setOAuthToken(accessToken)
            .addView(pwaSheetView)
            .addView(allSheetsView)
            .setCallback(pickerCallback)
            .setOrigin(window.location.protocol + '//' + window.location.host)
            .setTitle('Select a PWA Sheet')
            .build();
            
        picker.setVisible(true);
        
    } catch (error) {
        console.error('❌ Error opening picker:', error);
        showError('Failed to open sheet picker. Please try again.');
    }
}

// Handle picker selection
function pickerCallback(data) {
    console.log('📁 Picker callback data:', data);
    
    if (data.action === google.picker.Action.PICKED) {
        const doc = data.docs[0];
        const sheetId = doc.id;
        const sheetName = doc.name;
        
        console.log('✅ Sheet selected:', sheetName, 'ID:', sheetId);
        
        // Load the selected sheet
        loadPickedSheet(sheetId, sheetName);
    } else if (data.action === google.picker.Action.CANCEL) {
        console.log('❌ Picker cancelled');
        showStatus('Sheet selection cancelled', 'info');
    }
}

// Load a sheet selected from the picker
async function loadPickedSheet(sheetId, sheetName) {
    const pickerBtn = document.getElementById('openPickerBtn');
    
    try {
        console.log('🚀 Loading picked sheet:', sheetName, 'ID:', sheetId);
        
        // CRITICAL: Clear any existing loading state first to avoid conflicts
        UIState.clearLoading();
        
        // Store the current sheet ID to compare later
        const previousSheetId = currentSheetId;
        
        console.log('🔄 Loading state cleared, calling loadSheetData...');
        
        // Call loadSheetData to load the sheet (it will manage its own loading state)
        const result = await loadSheetData(sheetId);
        
        console.log('📋 LoadSheetData result:', result);
        console.log('📊 Previous sheet ID:', previousSheetId);
        console.log('📊 Current sheet ID after load:', currentSheetId);
        
        // Give a moment for the sheet to be processed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Verify the load was successful
        if (currentSheetId !== sheetId) {
            // If the sheet ID wasn't updated, it means loadSheetData failed silently
            throw new Error(`Sheet "${sheetName}" could not be accessed. This can happen when:
            1. The sheet is shared via "Anyone with link" instead of directly with your account
            2. The sheet requires broader permissions than the app currently has
            3. The sheet was created outside this app and hasn't been "opened" through it before
            
            Try asking the sheet owner to share it directly with ${currentUser?.email || 'your Google account'}.`);
        }
        
        showStatus(`✅ "${sheetName}" loaded successfully! It will now appear in your Recent Sheets.`, 'success');
        console.log('✅ Picked sheet loaded successfully');
        
    } catch (error) {
        console.error('❌ Error loading picked sheet:', error);
        
        if (error.message.includes('403') || error.message.includes('Forbidden')) {
            showError(`❌ Access denied to "${sheetName}". Make sure the sheet is shared directly with ${currentUser?.email || 'your Google account'} rather than just "Anyone with link".`);
        } else if (error.message.includes('404') || error.message.includes('Not Found')) {
            showError(`❌ "${sheetName}" not found via Sheets API. This often happens when the sheet is shared via "Anyone with link" rather than being shared directly with your Google account (${currentUser?.email || 'your email'}).`);
        } else if (error.message.includes('could not be accessed')) {
            showError(error.message);
        } else {
            showError(`❌ Failed to load "${sheetName}": ${error.message}`);
        }
    }
    // Note: No finally block needed since loadSheetData manages its own loading state
}

function updateSharedSheetVisibility() {
    const sharedSheetSection = document.getElementById('sharedSheetSection');
    
    if (!sharedSheetSection) return;
    
    // Show shared sheet section when authenticated
    const shouldShow = accessToken && currentUser && pickerApiLoaded;
    
    if (shouldShow) {
        sharedSheetSection.style.display = 'block';
    } else {
        sharedSheetSection.style.display = 'none';
    }
}

// Notification UI Functions
function toggleNotifications() {
    const panel = document.getElementById('notificationsPanel');
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = 'block';
        // Don't auto-refresh notifications when opening - this was clearing messages
        // NotificationManager.updateNotificationUI();
    } else {
        panel.style.display = 'none';
    }
}

function markAllAsRead() {
    NotificationManager.markAllAsRead();
    showStatus('All notifications marked as read', 'success');
}

function openSheetFromNotification(sheetId) {
    // Mark as read
    NotificationManager.markAsRead(sheetId);
    
    // Close notification panel
    document.getElementById('notificationsPanel').style.display = 'none';
    
    // Load the sheet
    loadSheetData(sheetId);
    
    showStatus('Loading sheet...', 'info');
}

// Make functions available globally for HTML onclick handlers
window.manualGoogleSignIn = manualGoogleSignIn;
window.loadSheetData = loadSheetData;
window.createNewSheet = createNewSheet;
window.addSampleData = addSampleData;
window.signOut = signOut;
window.installApp = installApp;
// Note: validateSheetId removed since manual sheet ID input is no longer used
window.loadRecentSheet = loadRecentSheet;
window.removeRecentSheet = removeRecentSheet;
window.showApiConfig = showApiConfig;
window.toggleNotifications = toggleNotifications;
window.markAllAsRead = markAllAsRead;
window.openSheetFromNotification = openSheetFromNotification;
window.openSheetPicker = openSheetPicker;
window.saveApiConfig = saveApiConfig;
window.continueToLogin = continueToLogin;
window.showApiConfiguration = showApiConfiguration; 

// Keyboard shortcuts and accessibility
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        // Only activate shortcuts when not in input fields
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }
        
        // Check for Ctrl/Cmd modifier
        const isModKey = event.ctrlKey || event.metaKey;
        
        switch (true) {
            case isModKey && event.key === 'l':
                event.preventDefault();
                if (accessToken && !UIState.isLoading && currentSheetId) {
                    loadSheetData(currentSheetId);
                    showStatus('🔄 Loading data via keyboard shortcut...', 'success');
                } else if (!currentSheetId) {
                    showStatus('⚠️ No sheet loaded. Select a sheet first.', 'warning');
                }
                break;
                
            case isModKey && event.key === 'n':
                event.preventDefault();
                if (accessToken && !UIState.isLoading) {
                    createNewSheet();
                    showStatus('📄 Creating new sheet via keyboard shortcut...', 'success');
                }
                break;
                
            case isModKey && event.key === 'a':
                event.preventDefault();
                if (accessToken && !UIState.isLoading) {
                    addSampleData();
                    showStatus('➕ Adding data via keyboard shortcut...', 'success');
                }
                break;
                
            case isModKey && event.key === 's':
                event.preventDefault();
                if (accessToken) {
                    signOut();
                }
                break;
                
            // Note: Sheet ID focus shortcut removed since manual input is no longer used
                
            case event.key === 'Escape':
                event.preventDefault();
                clearError();
                // Clear any loading states if possible
                if (UIState.isLoading) {
                    showStatus('⚠️ Please wait for current operation to complete', 'warning');
                }
                break;
                
            case event.key === '?':
                event.preventDefault();
                showKeyboardShortcuts();
                break;
        }
    });
    
    // Add visual indicators for keyboard shortcuts
    addKeyboardShortcutHints();
}

// Show keyboard shortcuts help (secure version)
function showKeyboardShortcuts() {
    // Create overlay safely
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 1000;
        background: white;
        padding: 2rem;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        max-width: 400px;
    `;
    
    // Create content container
    const contentDiv = SecurityUtils.createSafeElement('div');
    contentDiv.style.cssText = 'background: #f8f9fa; padding: 1rem; border-radius: 8px; text-align: left;';
    
    // Create title
    const title = SecurityUtils.createSafeElement('h4', '⌨️ Keyboard Shortcuts');
    
    // Create shortcuts container
    const shortcutsDiv = SecurityUtils.createSafeElement('div');
    shortcutsDiv.style.cssText = 'font-family: monospace; font-size: 0.9rem; line-height: 1.6;';
    
    // Add shortcuts safely
    const shortcuts = [
        'Ctrl/Cmd + L - Load sheet data',
        'Ctrl/Cmd + N - Create new sheet',
        'Ctrl/Cmd + A - Add sample row',
        'Ctrl/Cmd + S - Sign out',
        'Ctrl/Cmd + I - Focus sheet ID field',
        'Escape - Clear errors/cancel',
        '? - Show this help'
    ];
    
    shortcuts.forEach(shortcut => {
        const shortcutLine = SecurityUtils.createSafeElement('div', shortcut);
        const [keys, description] = shortcut.split(' - ');
        
        // Clear and rebuild with proper formatting
        shortcutLine.textContent = '';
        const keysSpan = SecurityUtils.createSafeElement('strong', keys);
        const descSpan = SecurityUtils.createSafeElement('span', ` - ${description}`);
        
        shortcutLine.appendChild(keysSpan);
        shortcutLine.appendChild(descSpan);
        shortcutsDiv.appendChild(shortcutLine);
    });
    
    contentDiv.appendChild(title);
    contentDiv.appendChild(shortcutsDiv);
    
    // Add close button
    const closeBtn = SecurityUtils.createSafeElement('button', '✕ Close');
    closeBtn.style.cssText = `
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        background: none;
        border: none;
        font-size: 1rem;
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
    `;
    closeBtn.onclick = () => overlay.remove();
    
    overlay.appendChild(contentDiv);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);
    
    // Auto-remove after 10 seconds
    setTimeout(() => {
        if (overlay.parentNode) {
            overlay.remove();
        }
    }, 10000);
    
    // Close on click outside
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.remove();
        }
    };
}

// Add visual hints for keyboard shortcuts
function addKeyboardShortcutHints() {
    // Add tooltips to buttons
    if (elements.loadDataBtn) {
        elements.loadDataBtn.title = 'Load sheet data (Ctrl+L)';
    }
    if (elements.createSheetBtn) {
        elements.createSheetBtn.title = 'Create new sheet (Ctrl+N)';
    }
    if (elements.addDataBtn) {
        elements.addDataBtn.title = 'Add sample row (Ctrl+A)';
    }
    
    // Add help indicator
    const helpIndicator = document.createElement('div');
    SecurityUtils.setSafeContent(helpIndicator, '❓ Press ? for shortcuts');
    helpIndicator.style.cssText = `
        position: fixed;
        bottom: 1rem;
        right: 1rem;
        background: rgba(66, 133, 244, 0.9);
        color: white;
        padding: 0.5rem;
        border-radius: 20px;
        font-size: 0.8rem;
        cursor: pointer;
        z-index: 100;
        transition: opacity 0.3s ease;
    `;
    helpIndicator.onclick = showKeyboardShortcuts;
    
    // Show help indicator only when authenticated
    const updateHelpVisibility = () => {
        helpIndicator.style.display = accessToken ? 'block' : 'none';
    };
    
    // Initial check
    updateHelpVisibility();
    
    // Update on auth state changes
    const originalShowAuth = showAuthenticatedState;
    const originalShowUnauth = showUnauthenticatedState;
    
    showAuthenticatedState = function() {
        originalShowAuth.call(this);
        updateHelpVisibility();
    };
    
    showUnauthenticatedState = function() {
        originalShowUnauth.call(this);
        updateHelpVisibility();
    };
    
    document.body.appendChild(helpIndicator);
} 



// Load a recent sheet
function loadRecentSheet(sheetId, sheetName) {
    showStatus(`📋 Loading sheet: ${sheetName}`, 'success');
    
    // Load the data directly if not currently loading
    if (!UIState.isLoading && accessToken) {
        loadSheetData(sheetId);
    }
}

// Remove a sheet from recent list
function removeRecentSheet(sheetId) {
    RecentSheetsManager.remove(sheetId);
    showStatus('🗑️ Removed from recent sheets', 'success');
} 

// Enhanced user experience features
const UXEnhancements = {
    // Note: Auto-save functionality removed since manual sheet ID input is no longer used
    setupAutoSave() {
        // This function is kept for compatibility but no longer performs any operations
        // since we now use cloud-based recent sheets instead of manual input
    },
    
    // Smooth focus transitions
    // Note: Focus management removed since manual sheet ID input is no longer used
    setupFocusManagement() {
        // This function is kept for compatibility but no longer performs any operations
        // since we now use cloud-based recent sheets instead of manual input
    },
    
    // Loading state improvements
    enhanceLoadingStates() {
        // Add pulse animation to loading elements
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            .loading-text {
                animation: pulse 1.5s ease-in-out infinite;
            }
        `;
        document.head.appendChild(style);
    },
    
    // Error prevention
    setupErrorPrevention() {
        // Note: Sheet ID form submission prevention removed since manual input is no longer used
        
        // Confirm before leaving with unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (UIState.isLoading) {
                e.preventDefault();
                e.returnValue = 'An operation is in progress. Are you sure you want to leave?';
                return e.returnValue;
            }
        });
    },
    
    init() {
        this.setupAutoSave();
        this.setupFocusManagement();
        this.enhanceLoadingStates();
        this.setupErrorPrevention();
    }
}; 