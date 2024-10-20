let idClient = null;
let tokenClient = null;
let accessToken = null;
export const CLIENT_ID = '778093944102-hs9c9949mulivlrd17nh9vnbveblgc9v.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

export function initGoogleAuth() {
  return new Promise((resolve) => {
    const checkGoogleLoaded = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        clearInterval(checkGoogleLoaded);
        idClient = google.accounts.id;
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: '', // defined later
        });
        
        resolve({ idClient, tokenClient });
      }
    }, 100);
  });
}

export function getIdClient() {
  return idClient;
}

export function getTokenClient() {
  return tokenClient;
}

export function loadSheetData(sheetId, range) {
  return getAccessToken(tokenClient).then(token => {
    return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(response => {
      if (!response.ok) {
        if (response.status === 401) {
          return handleAuthError();
        }
        throw new Error('Failed to load sheet data');
      }
      return response.json();
    });
  });
}

export function updateSheetData(sheetId, range, values) {
  return getAccessToken(tokenClient).then(token => {
    // First, try to update the specified range
    return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: values })
    }).then(response => {
      // If the response is not OK, check if it's a 400 error
      if (!response.ok) {
        if (response.status === 400) {
          // If the row does not exist, use the append method
          console.warn(`Row does not exist. Appending data to ${range}.`);
          return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=RAW`, {
            method: 'POST',
            headers: { 
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: values })
          });
        }
        return response.json().then(errorData => {
          throw new Error(`Failed to update sheet data: ${errorData.error.message}`);
        });
      }
      return response.json();
    });
  }).catch(err => {
    console.error('Error updating sheet data:', err);
    throw err;
  });
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
          { properties: { title: 'Groceries' } },
          { properties: { title: 'Locations' } }
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

export async function initGooglePicker(callback) {
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
}

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

export async function getAccessToken() {
  if (accessToken && await isTokenValid()) {
    return accessToken;
  }

  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error('Token client not initialized'));
      return;
    }

    tokenClient.callback = (resp) => {
      if (resp.error !== undefined) {
        reject(resp);
      }
      accessToken = resp.access_token;
      resolve(accessToken);
    };

    tokenClient.requestAccessToken({ prompt: '' });
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
  if (!accessToken) return false;
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + accessToken);
    return response.ok;
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

export function checkExistingSession() {
  return new Promise((resolve) => {
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response) => {
        if (window.handleCredentialResponse) {
          window.handleCredentialResponse(response);
          resolve(true);
        } else {
          console.error('handleCredentialResponse not defined in main app');
          resolve(false);
        }
      },
      use_fedcm_for_prompt: true,
      auto_select: true,
      cancel_on_tap_outside: false
    });

    // Instead of using prompt, we'll use a timeout
    setTimeout(() => {
      resolve(false);
    }, 1000); // Adjust this timeout as needed

    google.accounts.id.prompt();
  });
}

const GoogleAuth = {
  initGoogleAuth,
  loadSheetData,
  updateSheetData,
  createNewSheet,
  initGooglePicker,
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
  checkExistingSession,
  getTokenClient,
  getIdClient,
};

export default GoogleAuth;
