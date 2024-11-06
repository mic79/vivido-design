let idClient = null;
let tokenClient = null;
let accessToken = null;
export const CLIENT_ID = '778093944102-hs9c9949mulivlrd17nh9vnbveblgc9v.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
let user = null;
let isSignedIn = false;

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (error) {
        console.error("Error parsing JWT:", error);
        return null;
    }
}

export function initGoogleAuth() {
    console.log('initGoogleAuth called');
    return new Promise((resolve) => {
        const checkGoogleLoaded = setInterval(() => {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
                clearInterval(checkGoogleLoaded);
                console.log('Creating new tokenClient');
                
                // Configure Google Identity Services
                google.accounts.id.initialize({
                    client_id: CLIENT_ID,
                    callback: handleCredentialResponse,
                    auto_select: true,
                    prompt_parent_id: 'googleSignInButton',
                    context: 'signin',
                    itp_support: true // Enable Intelligent Tracking Prevention support
                });

                tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: CLIENT_ID,
                    scope: SCOPES,
                    callback: handleCredentialResponse,
                    prompt: ''  // Reduces prompts
                });
                
                console.log('tokenClient created:', tokenClient);
                resolve(tokenClient);
            }
        }, 100);
    });
}

export function getIdClient() {
  return idClient;
}

export function getTokenClient() {
    console.log('getTokenClient called, tokenClient is:', tokenClient);
    return tokenClient;
}

export async function loadSheetData(sheetId, range) {
  try {
    const token = await getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      if (response.status === 429) {  // Too Many Requests
        const retryAfter = response.headers.get('Retry-After');
        const error = new Error('Failed to fetch data. Please try again.');
        error.originalMessage = `Rate limit exceeded. Please wait ${retryAfter || 'a few'} seconds before trying again.`;
        error.isRateLimit = true;  // Add a flag to identify rate limit errors
        throw error;
      }
      if (response.status === 401) {
        return handleAuthError();
      }
      throw new Error('Failed to load sheet data');
    }
    return response.json();
  } catch (err) {
    // If it's our rate limit error, preserve its properties
    if (err.isRateLimit) {
      const error = new Error(err.originalMessage);
      error.isRateLimit = true;
      throw error;
    }
    console.error('API Error:', err);
    throw err;
  }
}

export async function createNewSheet(title) {
  const token = await getAccessToken();
  try {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: { title: title },
        sheets: [
          {
            properties: { title: 'Groceries' },
            data: [{
              startRow: 0,
              startColumn: 0,
              rowData: [{
                values: [
                  { userEnteredValue: { stringValue: 'ID' } },
                  { userEnteredValue: { stringValue: 'Title' } },
                  { userEnteredValue: { stringValue: 'Amount' } },
                  { userEnteredValue: { stringValue: 'Price' } },
                  { userEnteredValue: { stringValue: 'Order' } },
                  { userEnteredValue: { stringValue: 'Location' } },
                  { userEnteredValue: { stringValue: 'DateChecked' } },
                  { userEnteredValue: { stringValue: 'Date' } },
                  { userEnteredValue: { stringValue: 'Location Title' } }
                ]
              }]
            }]
          },
          {
            properties: { title: 'Locations' },
            data: [{
              startRow: 0,
              startColumn: 0,
              rowData: [{
                values: [
                  { userEnteredValue: { stringValue: 'Title' } },
                  { userEnteredValue: { stringValue: 'Order' } },
                  { userEnteredValue: { stringValue: 'ID' } },
                  { userEnteredValue: { stringValue: 'Hidden' } },
                  { userEnteredValue: { stringValue: 'City' } }
                ]
              }]
            }]
          }
        ]
      })
    });

    if (!response.ok) throw new Error('Failed to create new sheet');
    const data = await response.json();
    return data.spreadsheetId;
  } catch (err) {
    console.error('Error creating new sheet:', err);
    throw err;
  }
}

/*export async function initGooglePicker(callback) {
  try {
    if (!tokenClient) {
      await initGoogleAuth();
    }
    const token = await getAccessToken();
    
    if (typeof gapi === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js';
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
      });
    }
    
    await new Promise((resolve) => gapi.load('picker', { callback: resolve }));

    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
      .setIncludeFolders(true)
      .setMimeTypes("application/vnd.google-apps.spreadsheet")
      .setQuery("GroceriesApp");

    const picker = new google.picker.PickerBuilder()
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setAppId(CLIENT_ID)
      .setOAuthToken(token)
      .addView(view)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          callback(data.docs[0].id);
        } else if (data.action === google.picker.Action.CANCEL) {
          console.log('Picker was cancelled');
        }
      })
      .build();

    picker.setVisible(true);
  } catch (error) {
    console.error('Error initializing Google Picker:', error);
  }
}*/

export async function checkForChanges(sheetId) {
  try {
    const token = await getAccessToken(tokenClient);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}?fields=modifiedTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorData.error.message}`);
    }
    const data = await response.json();
    return data.modifiedTime;
  } catch (error) {
    console.error('Error in checkForChanges:', error);
    if (error.message.includes('401')) {
      // Token might be expired, try to refresh it
      accessToken = null;
      return checkForChanges(sheetId);
    }
    throw new Error(`Failed to check for changes: ${error.message}`);
  }
}

export function getAccessToken() {
    return new Promise((resolve, reject) => {
        if (!tokenClient) {
            reject(new Error('Token client not initialized'));
            return;
        }

        if (accessToken && isTokenValid()) {
            resolve(accessToken);
            return;
        }

        tokenClient.requestAccessToken({
            prompt: '',
            hint: localStorage.getItem('gsi_session')
        });

        tokenClient.callback = (resp) => {
            if (resp.error !== undefined) {
                reject(resp);
                return;
            }
            accessToken = resp.access_token;
            resolve(accessToken);
        };
    });
}

export function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {
      console.log('Access token revoked');
      accessToken = null;
    });
  }
}

export function promptForSignIn() {
  //google.accounts.id.prompt();
}

export function checkExistingCredential() {
  return Promise.resolve();
  /*return new Promise((resolve) => {
    google.accounts.id.cancel(); // Cancel any existing prompt
    google.accounts.id.prompt((notification) => {
      // We're not using any status methods here, just resolving the promise
      resolve();
    });
  });*/
}

export async function batchUpdateSpreadsheet(spreadsheetId, requests) {
    const accessToken = await getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requests })
    });

    if (!response.ok) {
        const error = await response.json();
        console.error('Error response from Sheets API:', JSON.stringify(error, null, 2));
        throw new Error(`Error updating spreadsheet: ${error.error.message}`);
    }

    return await response.json();
}

export async function getValues(spreadsheetId, range) {
    const accessToken = await getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });
    return await response.json();
}

export async function isTokenValid() {
  console.log('Checking token validity. Current token:', accessToken ? 'exists' : 'null');
  if (!accessToken) {
    // Try to retrieve from localStorage as fallback
    const savedToken = localStorage.getItem('gsi_session');
    if (savedToken) {
      console.log('Retrieved token from localStorage');
      accessToken = savedToken;
    } else {
      console.log('No token found in localStorage');
      return false;
    }
  }

  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + accessToken);
    const isValid = response.ok;
    console.log('Token validity check result:', isValid);
    return isValid;
  } catch (error) {
    console.error('Error checking token validity:', error);
    return false;
  }
}

export async function handleAuthError() {
  accessToken = null;
  // Notify the main app that authentication has failed
  if (window.handleAuthFailure) {
    window.handleAuthFailure();
  } else {
    console.error('handleAuthFailure not defined in main app');
  }
  return Promise.reject(new Error('Authentication failed'));
}

export async function getSheetMetadata(sheetId) {
  const token = await getAccessToken();
  try {
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.modifiedTime,properties.title`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Failed to get sheet metadata');
    const data = await response.json();
    return {
      modifiedTime: data.properties.modifiedTime,
      title: data.properties.title
    };
  } catch (err) {
    console.error('Error getting sheet metadata:', err);
    throw err;
  }
}

export function handleCredentialResponse(response) {
    console.log("Handling credential response in googleAuth.js");
    if (response.credential) {
        try {
            const decodedToken = parseJwt(response.credential);
            if (decodedToken && decodedToken.email) {
                const user = {
                    email: decodedToken.email,
                    name: decodedToken.name,
                    picture: decodedToken.picture
                };
                localStorage.setItem('gsi_session', response.credential);
                
                if (!tokenClient) {
                    tokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: CLIENT_ID,
                        scope: SCOPES,
                        callback: (resp) => {
                            accessToken = resp.access_token;
                        }
                    });
                }
                
                if (window.vueApp && window.vueApp.proxy) {
                    console.log("Updating auth state with user:", user);
                    window.vueApp.proxy.updateAuthState({
                        user: user,
                        isSignedIn: true
                    });
                    return true;
                }
            }
        } catch (error) {
            console.error("Error parsing JWT token:", error);
            localStorage.removeItem('gsi_session');
            return false;
        }
    }
    return false;
}

export async function batchUpdateSheetData(sheetId, sheetName, items, isNewRow = false) {
    console.log('batchUpdateSheetData called with:', {
        sheetId,
        sheetName,
        items,
        isNewRow,
        stackTrace: new Error().stack
    });

    const token = await getAccessToken(tokenClient);
    
    // If it's a new row, go straight to append
    if (isNewRow) {
        console.log('Adding new row');
        const baseSheetName = sheetName.split('!')[0];
        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${baseSheetName}:append?valueInputOption=USER_ENTERED`;
        const appendResponse = await fetch(appendUrl, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: items })
        });

        if (!appendResponse.ok) {
            const errorData = await appendResponse.json();
            console.error('Append failed:', errorData);
            throw new Error(`Failed to update sheet data: ${errorData.error.message}`);
        }

        const result = await appendResponse.json();
        console.log('Append successful:', result);
        return result;
    }
    
    // For updates, we need to find the specific row
    const baseSheetName = sheetName.split('!')[0];
    
    // First, get the current data to find the row
    const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${baseSheetName}!A2:Z`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    const values = data.values || [];
    
    // Find the row index where the ID matches
    // For Locations sheet, ID is in column C (index 2)
    // For Groceries sheet, ID is in column A (index 0)
    const idColumnIndex = baseSheetName === 'Locations' ? 2 : 0;
    const itemId = baseSheetName === 'Locations' ? items[0][2] : items[0][0];
    
    console.log('Looking for item with ID:', itemId, 'in column:', idColumnIndex);
    const rowIndex = values.findIndex(row => row[idColumnIndex] === itemId);
    
    if (rowIndex === -1) {
        console.error('Row not found for ID:', itemId);
        throw new Error('Row not found');
    }
    
    const actualRowIndex = rowIndex + 2; // Add 2 to account for 0-based index and header row
    console.log('Found row index:', rowIndex, 'Actual row index:', actualRowIndex);
    
    // Use the actual row index in the update URL
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${baseSheetName}!A${actualRowIndex}:Z${actualRowIndex}?valueInputOption=USER_ENTERED`;
    
    const updateResponse = await fetch(updateUrl, {
        method: 'PUT',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: items })
    });

    if (!updateResponse.ok) {
        const errorData = await updateResponse.json();
        console.error('Update failed:', errorData);
        throw new Error(`Failed to update sheet data: ${errorData.error.message}`);
    }

    const result = await updateResponse.json();
    console.log('Update successful:', result);
    return result;
}

export async function batchDuplicateGroceryItems(sheetId, items) {
    const newItems = items.map(item => [
        `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        item.title,
        item.amount.toString(),
        item.price.toString(),
        (parseInt(item.order) + items.length).toString(),
        item.location,
        '',
        ''
    ]);

    return batchUpdateSheetData(sheetId, 'Groceries!A:H', newItems, true);
}

export async function deleteSheetRow(sheetId, sheetName, rowId, isLocationSheet = false) {
    const token = await getAccessToken(tokenClient);
    const baseSheetName = sheetName.split('!')[0];
    
    // Get current data and spreadsheet info
    const [dataResponse, sheetResponse] = await Promise.all([
        fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${baseSheetName}!A2:Z`,
            { headers: { Authorization: `Bearer ${token}` } }
        ),
        fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        )
    ]);

    const data = await dataResponse.json();
    const sheetInfo = await sheetResponse.json();
    const values = data.values || [];
    
    // Find the row index where the ID matches (column C for Locations, column A for Groceries)
    const idColumnIndex = isLocationSheet ? 2 : 0;
    const rowIndex = values.findIndex(row => row[idColumnIndex] === rowId);
    
    if (rowIndex === -1) {
        throw new Error('Row not found');
    }
    
    const actualRowIndex = rowIndex + 2; // Add 2 for header and 0-based index

    // Find the sheet ID
    const sheet = sheetInfo.sheets.find(s => s.properties.title === baseSheetName);
    if (!sheet) {
        throw new Error('Sheet not found');
    }

    // Delete the row using batchUpdate
    const deleteUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
    const deleteResponse = await fetch(deleteUrl, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheet.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: actualRowIndex - 1,  // 0-based index
                        endIndex: actualRowIndex  // exclusive end index
                    }
                }
            }]
        })
    });

    if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        throw new Error(`Failed to delete row: ${errorData.error.message}`);
    }

    return deleteResponse.json();
}

const GoogleAuth = {
  initGoogleAuth,
  loadSheetData,
  createNewSheet,
  //initGooglePicker,
  checkForChanges,
  getAccessToken,
  signOut,
  promptForSignIn,
  checkExistingCredential,
  batchUpdateSpreadsheet,
  getValues,
  isTokenValid,
  handleAuthError,
  getSheetMetadata,
  getTokenClient,
  getIdClient,
  batchUpdateSheetData,
  batchDuplicateGroceryItems,
  deleteSheetRow,
  handleCredentialResponse,
  parseJwt
};

export default GoogleAuth;
