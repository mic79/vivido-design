let tokenClient;
let accessToken = null;
const CLIENT_ID = '778093944102-hs9c9949mulivlrd17nh9vnbveblgc9v.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

export function initGoogleAuth() {
  return new Promise((resolve) => {
    const checkGoogleLoaded = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        clearInterval(checkGoogleLoaded);
        google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (response) => {
            if (window.handleCredentialResponse) {
              window.handleCredentialResponse(response);
            } else {
              console.error('handleCredentialResponse not defined in main app');
            }
          },
          auto_select: true, // Enable automatic sign-in
          prompt_parent_id: 'googleSignInButton' // Specify where to render the One Tap UI
        });
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: '', // defined later
        });
        resolve();
      }
    }, 100);
  });
}

export function renderSignInButton() {
  const buttonElement = document.getElementById('googleSignInButton');
  if (buttonElement) {
    google.accounts.id.renderButton(buttonElement, { theme: 'outline', size: 'large' });
  } else {
    console.error('Google Sign-In button element not found');
  }
}

export async function loadSheetData(sheetId, range) {
  try {
    const token = await getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      if (response.status === 401) {
        await handleAuthError();
        return null;
      }
      throw new Error('Failed to load sheet data');
    }
    const data = await response.json();
    return data.values;
  } catch (err) {
    console.error('Error loading sheet data:', err);
    throw err;
  }
}

export async function updateSheetData(sheetId, range, values) {
  const token = await getAccessToken();
  try {
    // First, try to update the specified range
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: values })
    });

    // If the response is not OK, check if it's a 400 error
    if (!response.ok) {
      if (response.status === 400) {
        // If the row does not exist, use the append method
        console.warn(`Row does not exist. Appending data to ${range}.`);
        const appendResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=RAW`, {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values: values })
        });

        if (!appendResponse.ok) {
          const errorData = await appendResponse.json();
          throw new Error(`Failed to append sheet data: ${errorData.error.message}`);
        }
        return await appendResponse.json();
      }
      const errorData = await response.json();
      throw new Error(`Failed to update sheet data: ${errorData.error.message}`);
    }
    return await response.json();
  } catch (err) {
    console.error('Error updating sheet data:', err);
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
}

export async function checkForChanges(sheetId) {
  const token = await getAccessToken();
  try {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}?fields=modifiedTime`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Failed to check for changes');
    const data = await response.json();
    return data.modifiedTime;
  } catch (err) {
    console.error('Error checking for changes:', err);
    throw err;
  }
}

export async function getAccessToken() {
  if (accessToken && await isTokenValid()) {
    return accessToken;
  }

  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error !== undefined) {
        reject(resp);
      }
      accessToken = resp.access_token;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({prompt: ''});
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
  google.accounts.id.prompt((notification) => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      // If One Tap is not displayed or skipped, render the normal sign-in button
      renderSignInButton();
    }
  });
}

export function checkExistingCredential() {
  return new Promise((resolve) => {
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response) => {
        if (window.handleCredentialResponse) {
          window.handleCredentialResponse(response);
        } else {
          console.error('handleCredentialResponse not defined in main app');
        }
        resolve(true);
      },
      auto_select: true,
    });

    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        console.log('No credential available');
        resolve(false);
      }
    });
  });
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

const GoogleAuth = {
  initGoogleAuth,
  renderSignInButton,
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
};

export default GoogleAuth;
