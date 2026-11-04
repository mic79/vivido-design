/* Valu app shell (Vue root component, auth wiring, navigation, groups).
 * Extracted from index.html (was an inline <script type="module">) so a strict Content-Security-Policy is possible. */
    import GoogleAuth from './googleAuth.js';
    import SheetsApi, { normalizeDiscontinuedCell, isDemoSheet } from './sheetsApi.js';
    import { demoGroupMeta, demoSettingsObject, demoAccountsList, getDemoSettings, DEMO_SHEET_ID } from './demoData.js';
    import ValuOrb from './valu.js';
    import { killValuAppLandingIntro } from './valu-landing-intro.js';
    import HomePage from './HomePage.js';
    import AccountsPage from './AccountsPage.js';
    import ExpensesPage from './ExpensesPage.js';
    import IncomePage from './IncomePage.js';
    import GroupsPage from './GroupsPage.js';
    import SettingsPage from './SettingsPage.js';
    import ActivityPage from './ActivityPage.js';
    import FaqPage from './FaqPage.js';
    import AboutPage from './AboutPage.js';
    import ValuAssistant from './ValuAssistant.js';
    import FiCalculatorPage from './FiCalculatorPage.js';
    import ForecastPage from './ForecastPage.js';
    import ValuDateField from './ValuDateField.js';
    import ValuDropdown from './ValuDropdown.js';
    import ValuCurrencyPicker from './ValuCurrencyPicker.js';

    const { createApp, ref, computed, watch, onMounted, nextTick, provide } = Vue;

    const app = createApp({
      components: { HomePage, AccountsPage, ExpensesPage, IncomePage, GroupsPage, SettingsPage, ActivityPage, FaqPage, AboutPage, ValuAssistant, FiCalculatorPage, ForecastPage },

      setup() {
        // ── Auth state ──────────────────────────────────────────────────────
        const isAuthenticated = ref(false);
        const authLoading = ref(true);
        const userProfile = ref(null);
        const demoMode = ref(false);
        const landingShowCtas = ref(false);
        const showSignInFromLanding = ref(false);
        let ensurePersonalInFlight = false;
        const _urlParams = new URLSearchParams(window.location.search);
        const requestedDemo = _urlParams.has('demo');

        // ── Group state ─────────────────────────────────────────────────────
        const groups = ref([]);
        const activeGroup = ref(null);
        const groupSettings = ref({});
        const groupLoading = ref(false);
        const accountsList = ref([]);

        // ── Navigation ──────────────────────────────────────────────────────
        const currentPage = ref('home');
        const accountsEntryIntent = ref(null);
        const sideNavOpen = ref(false);
        const showGroupSwitcher = ref(false);
        const dataLoaded = ref(false);
        const needsReconnect = ref(false);
        const swUpdateReady = ref(false);
        let waitingSW = null;
        let swRegistration = null;
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches
          || window.navigator.standalone === true;
        const appInstalled = ref(isStandalone || !!localStorage.getItem('valu_app_installed'));
        let deferredInstallPrompt = null;

        const PAGE_MAP = {
          home:     'HomePage',
          accounts: 'AccountsPage',
          expenses: 'ExpensesPage',
          income:   'IncomePage',
          groups:   'GroupsPage',
          settings: 'SettingsPage',
          activity: 'ActivityPage',
          faq: 'FaqPage',
          about: 'AboutPage',
          assistant: 'ValuAssistant',
          fi: 'FiCalculatorPage',
          forecast: 'ForecastPage',
        };

        const currentPageComponent = computed(() => PAGE_MAP[currentPage.value] || 'HomePage');
        const activeSheetId = computed(() => activeGroup.value ? activeGroup.value.id : null);
        const activeGroupName = computed(() => {
          const name = activeGroup.value ? activeGroup.value.name : '';
          return name ? name.replace('Valu: ', '') : '';
        });

        const inAppShell = computed(() => isAuthenticated.value || demoMode.value);

        const groupsForSwitcher = computed(() => {
          const real = groups.value.filter((g) => g.id !== DEMO_SHEET_ID);
          const demo = demoGroupMeta();
          if (!isAuthenticated.value && demoMode.value) return [demo];
          if (isAuthenticated.value) return [demo, ...real];
          return [demo];
        });

        const demoHomeCallout = computed(() => {
          if (!activeGroup.value || !isDemoSheet(activeGroup.value.id)) return 'none';
          if (!isAuthenticated.value) return 'signin';
          return 'readonly';
        });
        const demoNoticeDismissed = ref(false);
        watch(demoHomeCallout, () => { demoNoticeDismissed.value = false; });

        provide('activeSheetId', activeSheetId);
        provide('groupSettings', groupSettings);
        provide('activeGroup', activeGroup);

        // ── Global dialog system (replaces native alert/confirm) ─────────
        const dialogVisible = ref(false);
        const dialogMessage = ref('');
        const dialogIsConfirm = ref(false);
        let dialogResolve = null;

        function showAlert(message) {
          return new Promise(resolve => {
            dialogMessage.value = message;
            dialogIsConfirm.value = false;
            dialogResolve = resolve;
            dialogVisible.value = true;
          });
        }
        function showConfirm(message) {
          return new Promise(resolve => {
            dialogMessage.value = message;
            dialogIsConfirm.value = true;
            dialogResolve = resolve;
            dialogVisible.value = true;
          });
        }
        function dialogOk() {
          dialogVisible.value = false;
          if (dialogResolve) dialogResolve(true);
          dialogResolve = null;
        }
        function dialogCancel() {
          dialogVisible.value = false;
          if (dialogResolve) dialogResolve(false);
          dialogResolve = null;
        }

        provide('showAlert', showAlert);
        provide('showConfirm', showConfirm);
        provide('installBanner', { installed: appInstalled, install: installApp });

        // ── Hash-based routing ───────────────────────────────────────────
        let _navFromPopstate = false;
        function readHash() {
          const h = window.location.hash.replace('#', '');
          return PAGE_MAP[h] ? h : 'home';
        }
        watch(currentPage, (page) => {
          if (_navFromPopstate) { _navFromPopstate = false; return; }
          const hash = page === 'home' ? '' : '#' + page;
          if (window.location.hash !== hash) {
            history.pushState({ page }, '', hash || window.location.pathname + window.location.search);
          }
        });
        window.addEventListener('popstate', () => {
          _navFromPopstate = true;
          currentPage.value = readHash();
        });

        async function navigateTo(page, opts) {
          const allowedWithoutGroup = page === 'home' || page === 'groups' || page === 'settings';
          if (!activeGroup.value && !allowedWithoutGroup) {
            currentPage.value = 'home';
            accountsEntryIntent.value = null;
            return;
          }
          if (page === 'groups' && opts && opts.autoOpenConfig) {
            currentPage.value = page;
            setTimeout(() => {
              const pill = document.querySelector('.groups-active-pill');
              const btn = pill ? pill.closest('button') : null;
              if (btn) {
                btn.click();
              } else {
                const card = document.getElementsByClassName('groups-list-card')[0];
                if (card) card.click();
              }
            }, 600);
            return;
          }
          currentPage.value = page;
          if (page !== 'accounts') {
            accountsEntryIntent.value = null;
          } else if (opts && opts.accountsIntent) {
            accountsEntryIntent.value = opts.accountsIntent;
          } else {
            accountsEntryIntent.value = null;
          }
          if (opts && opts.scrollTo) {
            const scrollTarget = opts.scrollTo;
            const tryScroll = (attempts) => {
              let el = document.getElementById(scrollTarget);
              if (!el) {
                const titles = document.querySelectorAll('.activity-feed-title');
                for (const t of titles) {
                  if (t.textContent.includes("What's New")) { el = t.closest('.card'); break; }
                }
              }
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              } else if (attempts > 0) {
                setTimeout(() => tryScroll(attempts - 1), 300);
              }
            };
            nextTick(() => setTimeout(() => tryScroll(8), 200));
          }
          if (!dataLoaded.value && activeGroup.value) {
            await loadGroupData();
          }
          if (page === 'home' && activeGroup.value) {
            if (isDemoSheet(activeGroup.value.id)) {
              groupSettings.value = getDemoSettings();
              localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));
            } else {
              SheetsApi.getSettings(activeGroup.value.id).then(s => {
                groupSettings.value = s;
                localStorage.setItem('valu_settings_cache', JSON.stringify(s));
              }).catch(() => {});
            }
          }
        }

        function isListEnabled(key) {
          const enabled = (groupSettings.value?.listsEnabled || '').split(',');
          return enabled.includes(key);
        }

        // ── Auth ────────────────────────────────────────────────────────────

        function applyDemoShellState() {
          activeGroup.value = demoGroupMeta();
          groupSettings.value = getDemoSettings();
          accountsList.value = demoAccountsList();
          dataLoaded.value = true;
          groupLoading.value = false;
          needsReconnect.value = false;
          localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));
          SheetsApi.stopChangeDetection();
        }

        function startQuickLookDemo() {
          killValuAppLandingIntro();
          demoMode.value = true;
          showSignInFromLanding.value = false;
          currentPage.value = 'home';
          applyDemoShellState();
        }

        function leaveDemoToSignIn() {
          demoMode.value = false;
          sideNavOpen.value = false;
          activeGroup.value = null;
          groupSettings.value = {};
          accountsList.value = [];
          dataLoaded.value = false;
          groupLoading.value = false;
          showSignInFromLanding.value = true;
          landingShowCtas.value = true;
          localStorage.removeItem('valu_last_group');
          localStorage.removeItem('valu_last_group_name');
          localStorage.removeItem('valu_settings_cache');
        }

        function onAuthChange(signedIn, profile) {
          isAuthenticated.value = signedIn;
          userProfile.value = profile;
          authLoading.value = false;

          if (signedIn) {
            killValuAppLandingIntro();
            showSignInFromLanding.value = false;

            const prevEmail = localStorage.getItem('valu_last_user_email') || '';
            const curEmail = profile?.email || '';
            if (curEmail && curEmail !== prevEmail) {
              localStorage.removeItem('valu_onboarding_dismissed');
              localStorage.removeItem('valu_default_group');
              localStorage.removeItem('valu_groups_cache');
              localStorage.removeItem('valu_settings_cache');
              localStorage.removeItem('valu_last_group');
              localStorage.removeItem('valu_last_group_name');
              groups.value = [];
              activeGroup.value = null;
              groupSettings.value = {};
              localStorage.setItem('valu_last_user_email', curEmail);
            }

            if (requestedDemo) {
              demoMode.value = false;
              switchGroup(demoGroupMeta());
              refreshGroupsList();
              return;
            }

            demoMode.value = false;

            const cachedGroups = localStorage.getItem('valu_groups_cache');
            const cachedSettings = localStorage.getItem('valu_settings_cache');
            let lastGroupId = localStorage.getItem('valu_last_group');

            if (isDemoSheet(lastGroupId)) {
              lastGroupId = null;
              localStorage.removeItem('valu_last_group');
              localStorage.removeItem('valu_last_group_name');
              localStorage.removeItem('valu_settings_cache');
            }

            if (!lastGroupId) {
              const defaultGroup = localStorage.getItem('valu_default_group');
              if (defaultGroup) lastGroupId = defaultGroup;
            }


            if (cachedGroups) {
              try { groups.value = JSON.parse(cachedGroups); } catch {}
            }

            if (lastGroupId && cachedSettings) {
              const lastGroup = groups.value.find((g) => g.id === lastGroupId);
              if (lastGroup && lastGroup.id) {
                activeGroup.value = lastGroup;
                try { groupSettings.value = JSON.parse(cachedSettings); } catch {}
                currentPage.value = readHash();
                groupLoading.value = false;
                loadGroupData(true);
              } else {
                activeGroup.value = null;
                groupSettings.value = {};
                dataLoaded.value = false;
                localStorage.removeItem('valu_last_group');
                localStorage.removeItem('valu_last_group_name');
                localStorage.removeItem('valu_settings_cache');
                currentPage.value = 'home';
                groupLoading.value = true;
              }
            } else {
              currentPage.value = 'home';
              groupLoading.value = true;
            }

            refreshGroupsList();
          } else if (!demoMode.value) {
            groups.value = [];
            activeGroup.value = null;
            groupSettings.value = {};
            dataLoaded.value = false;
            groupLoading.value = false;
            needsReconnect.value = false;
            currentPage.value = 'home';
            SheetsApi.stopChangeDetection();
            localStorage.removeItem('valu_groups_cache');
            localStorage.removeItem('valu_settings_cache');
          }
        }

        function connect() {
          authLoading.value = true;
          setTimeout(() => { authLoading.value = false; }, 60000);
          GoogleAuth.connect();
        }

        function signOut() {
          sideNavOpen.value = false;
          GoogleAuth.signOut();
        }

        function applySwUpdate() {
          if (waitingSW) {
            waitingSW.postMessage({ type: 'SKIP_WAITING' });
          } else {
            window.location.reload();
          }
        }

        // ── PWA Install Prompt ───────────────────────────────────────────────

        window.addEventListener('beforeinstallprompt', (e) => {
          e.preventDefault();
          deferredInstallPrompt = e;
        });

        window.addEventListener('appinstalled', () => {
          appInstalled.value = true;
          localStorage.setItem('valu_app_installed', '1');
          deferredInstallPrompt = null;
        });

        function installApp() {
          if (deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            deferredInstallPrompt.userChoice.then((result) => {
              if (result.outcome === 'accepted') {
                appInstalled.value = true;
                localStorage.setItem('valu_app_installed', '1');
              }
              deferredInstallPrompt = null;
            });
          } else {
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const msg = isIOS
              ? 'To install Valu, tap the Share button in Safari, then "Add to Home Screen".'
              : 'To install Valu, open your browser menu and look for "Install app" or "Add to Home Screen".';
            showAlert(msg);
          }
        }

        // ── Groups ──────────────────────────────────────────────────────────

        function mapAccountRows(rows) {
          return rows.map(r => ({
            id: r[0], name: r[1], currency: r[2],
            type: r[3], discontinued: normalizeDiscontinuedCell(r[4]), order: r[5],
          }));
        }

        function setupChangeDetection(sheetId) {
          SheetsApi.startChangeDetection([sheetId], async (changedId) => {
            if (changedId === activeGroup.value?.id) {
              try {
                groupSettings.value = await SheetsApi.getSettings(activeGroup.value.id);
                localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));
                const accRows = await SheetsApi.getTabData(activeGroup.value.id, 'Accounts');
                accountsList.value = mapAccountRows(accRows);
              } catch (err) {
                console.warn('Change detection refresh failed:', err);
              }
            }
          });
        }

        async function loadGroupData(background = false) {
          if (!activeGroup.value || dataLoaded.value) return;
          if (isDemoSheet(activeGroup.value.id)) {
            applyDemoShellState();
            return;
          }
          if (!background) groupLoading.value = true;
          needsReconnect.value = false;
          try {
            groupSettings.value = await SheetsApi.getSettings(activeGroup.value.id);
            localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));

            const accRows = await SheetsApi.getTabData(activeGroup.value.id, 'Accounts');
            accountsList.value = mapAccountRows(accRows);

            dataLoaded.value = true;
            setupChangeDetection(activeGroup.value.id);
          } catch (err) {
            if (!background) {
              needsReconnect.value = true;
              console.error('Failed to load group data:', err);
            }
          } finally {
            groupLoading.value = false;
          }
        }

        async function refreshGroupsList() {
          try {
            const files = await SheetsApi.listSpreadsheets();
            groups.value = files;
            localStorage.setItem('valu_groups_cache', JSON.stringify(files));

            if (activeGroup.value && !isDemoSheet(activeGroup.value.id) && !files.find((f) => f.id === activeGroup.value.id)) {
              activeGroup.value = null;
              groupSettings.value = {};
              dataLoaded.value = false;
              groupLoading.value = false;
              localStorage.removeItem('valu_last_group');
              localStorage.removeItem('valu_last_group_name');
              localStorage.removeItem('valu_settings_cache');
              currentPage.value = 'groups';
            }

            if (isAuthenticated.value && !activeGroup.value && files.length > 0) {
              const lastId = localStorage.getItem('valu_last_group');
              const defaultId = localStorage.getItem('valu_default_group');
              const match = files.find(f => f.id === lastId) || (defaultId && files.find(f => f.id === defaultId));
              await switchGroup(match || files[0]);
            }

            if (isAuthenticated.value && files.length === 0 && userProfile.value?.email && !ensurePersonalInFlight) {
              ensurePersonalInFlight = true;
              try {
                const created = await SheetsApi.createSpreadsheet('Personal', userProfile.value.email);
                groups.value = [created];
                localStorage.setItem('valu_groups_cache', JSON.stringify(groups.value));
                await switchGroup(created);
              } catch (e) {
                console.error('ensurePersonalGroup:', e);
              } finally {
                ensurePersonalInFlight = false;
              }
            }
          } catch (err) {
            console.warn('Background groups refresh failed:', err);
          }
        }

        async function switchGroup(group, navOptions = {}) {
          if (!group || !group.id) {
            console.error('switchGroup: invalid group object:', JSON.stringify(group));
            currentPage.value = 'groups';
            return;
          }

          if (isDemoSheet(group.id)) {
            activeGroup.value = group;
            localStorage.setItem('valu_last_group', group.id);
            localStorage.setItem('valu_last_group_name', group.name || '');
            dataLoaded.value = true;
            groupLoading.value = false;
            applyDemoShellState();
            if (currentPage.value === 'groups' && !navOptions.keepOnGroupsPage) {
              currentPage.value = 'home';
            }
            return;
          }

          activeGroup.value = group;
          localStorage.setItem('valu_last_group', group.id);
          localStorage.setItem('valu_last_group_name', group.name || '');
          dataLoaded.value = false;
          groupLoading.value = true;

          try {
            groupSettings.value = await SheetsApi.getSettings(group.id);
            localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));

            const accRows = await SheetsApi.getTabData(group.id, 'Accounts');
            accountsList.value = mapAccountRows(accRows);

            dataLoaded.value = true;
            setupChangeDetection(group.id);

            if (currentPage.value === 'groups' && !navOptions.keepOnGroupsPage) {
              currentPage.value = 'home';
            }
          } catch (err) {
            console.error('Failed to load group settings:', err);
            if (err.message && (err.message.includes('404') || err.message.includes('403'))) {
              groups.value = groups.value.filter(g => g.id !== group.id);
              localStorage.setItem('valu_groups_cache', JSON.stringify(groups.value));
              activeGroup.value = null;
              groupSettings.value = {};
              dataLoaded.value = false;
              localStorage.removeItem('valu_last_group');
              localStorage.removeItem('valu_last_group_name');
              localStorage.removeItem('valu_settings_cache');
              currentPage.value = 'groups';
            } else {
              needsReconnect.value = true;
            }
          } finally {
            groupLoading.value = false;
          }
        }

        async function onGroupCreated(payload) {
          if (!payload || !payload.id) {
            console.error('onGroupCreated: createSpreadsheet returned no id:', payload);
            showAlert('Failed to create group — no spreadsheet ID returned.');
            return;
          }
          const keepOnGroupsPage = payload.keepOnGroupsPage === true;
          const result = { id: payload.id, name: payload.name };
          upsertGroup(result);
          await switchGroup(result, { keepOnGroupsPage });
        }

        /** Add a group to the list, or update it if it is already there (never create a duplicate). */
        function upsertGroup(entry) {
          const idx = groups.value.findIndex((g) => g.id === entry.id);
          if (idx >= 0) {
            groups.value[idx] = { ...groups.value[idx], ...entry };
          } else {
            groups.value.push(entry);
          }
          localStorage.setItem('valu_groups_cache', JSON.stringify(groups.value));
        }

        async function onSharedOpened(picked) {
          const entry = { id: picked.id, name: picked.name };
          const alreadyListed = groups.value.some((g) => g.id === entry.id);
          upsertGroup(entry);
          await switchGroup(entry);

          // A newly added group has no "Last modified" yet; fill it in right away instead of
          // showing a blank until the next full refresh.
          if (!alreadyListed && !isDemoSheet(entry.id)) {
            SheetsApi.getFileModifiedTime(entry.id).then((modifiedTime) => {
              const idx = groups.value.findIndex((g) => g.id === entry.id);
              if (idx >= 0 && modifiedTime && !groups.value[idx].modifiedTime) {
                groups.value[idx] = { ...groups.value[idx], modifiedTime };
                localStorage.setItem('valu_groups_cache', JSON.stringify(groups.value));
              }
            }).catch(() => {});
          }
        }

        function onAccountsUpdated(updatedAccounts) {
          accountsList.value = updatedAccounts;
        }

        function onSettingsUpdated(partial) {
          groupSettings.value = { ...groupSettings.value, ...partial };
          localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));

          if (partial.groupName && activeGroup.value) {
            const newName = 'Valu: ' + partial.groupName;
            activeGroup.value = { ...activeGroup.value, name: newName };
            const idx = groups.value.findIndex(g => g.id === activeGroup.value.id);
            if (idx >= 0) {
              groups.value[idx] = { ...groups.value[idx], name: newName };
              localStorage.setItem('valu_groups_cache', JSON.stringify(groups.value));
            }
          }
        }

        async function reconnect() {
          try {
            needsReconnect.value = false;
            await GoogleAuth.getAccessToken();
            if (activeGroup.value) {
              dataLoaded.value = false;
              await loadGroupData();
            }
          } catch (err) {
            needsReconnect.value = true;
            GoogleAuth.connect();
          }
        }

        async function refreshCurrentPage() {
          if (!dataLoaded.value && activeGroup.value) {
            await loadGroupData();
            return;
          }
          if (!activeGroup.value || isDemoSheet(activeGroup.value.id)) return;
          try {
            groupSettings.value = await SheetsApi.getSettings(activeGroup.value.id);
            localStorage.setItem('valu_settings_cache', JSON.stringify(groupSettings.value));
            const accRows = await SheetsApi.getTabData(activeGroup.value.id, 'Accounts');
            accountsList.value = mapAccountRows(accRows);
          } catch (err) {
            console.warn('Background refresh failed:', err);
          }
        }

        // ── Init ────────────────────────────────────────────────────────────

        let _orbRafId = 0;
        function reinitOrbs() {
          cancelAnimationFrame(_orbRafId);
          nextTick(() => {
            cancelAnimationFrame(_orbRafId);
            _orbRafId = requestAnimationFrame(() => { ValuOrb.initAll(); });
          });
        }

        watch(isAuthenticated, reinitOrbs);
        watch(inAppShell, reinitOrbs);
        watch(currentPage, reinitOrbs);

        onMounted(() => {
          if (requestedDemo) {
            startQuickLookDemo();
            window.history.replaceState({}, '', window.location.pathname);
          } else {
            setTimeout(() => { landingShowCtas.value = true; }, 2000);
          }
          GoogleAuth.init(onAuthChange);
        });

        // ── Service Worker ──────────────────────────────────────────────────

        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then(reg => {
            swRegistration = reg;
            reg.update().catch(() => {});
            reg.addEventListener('updatefound', () => {
              const newSW = reg.installing;
              if (!newSW) return;
              newSW.addEventListener('statechange', () => {
                if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
                  waitingSW = newSW;
                  swUpdateReady.value = true;
                }
              });
            });
          }).catch(() => {});

          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && swRegistration) {
              swRegistration.update().catch(() => {});
            }
          });

          navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
          });
        }

        return {
          isAuthenticated, authLoading, userProfile,
          demoSheetId: DEMO_SHEET_ID, appVersion: window.VALU_VERSION || '',
          inAppShell, demoMode, landingShowCtas, showSignInFromLanding,
          groups, groupsForSwitcher, activeGroup, groupSettings, groupLoading, dataLoaded, accountsList,
          currentPage, accountsEntryIntent, currentPageComponent,
          activeSheetId, activeGroupName, sideNavOpen, showGroupSwitcher,
          demoHomeCallout, demoNoticeDismissed,
          needsReconnect, reconnect, connect, swUpdateReady, applySwUpdate,
          navigateTo, isListEnabled,
          onAuthChange, signOut,
          startQuickLookDemo, leaveDemoToSignIn,
          switchGroup, onGroupCreated, onSharedOpened,
          onAccountsUpdated, onSettingsUpdated, refreshCurrentPage, refreshGroupsList,
          dialogVisible, dialogMessage, dialogIsConfirm, dialogOk, dialogCancel,
        };
      },
    });

    app.component('ValuDateField', ValuDateField);
    app.component('ValuDropdown', ValuDropdown);
    app.component('ValuCurrencyPicker', ValuCurrencyPicker);
    app.mount('#app');

    // ── Init Valu orb animations after first render ──────────────────────
    requestAnimationFrame(() => {
      ValuOrb.initAll();
    });

    // ── Global sheet swipe-to-close ──────────────────────────────────────
    (function() {
      const THRESHOLD = 80;

      document.addEventListener('touchstart', function onStart(e) {
        const handle = e.target.closest('.sheet-handle');
        if (!handle) return;
        const modal = handle.closest('.modal');
        if (!modal) return;

        const startY = e.touches[0].clientY;
        let currentY = startY;
        let dragging = false;

        function onMove(ev) {
          currentY = ev.touches[0].clientY;
          const dy = currentY - startY;
          if (dy > 0) {
            dragging = true;
            modal.style.transition = 'none';
            modal.style.transform = 'translateY(' + dy + 'px)';
          }
        }

        function onEnd() {
          const dy = currentY - startY;
          modal.style.transition = '';
          modal.style.transform = '';

          if (dragging && dy > THRESHOLD) {
            const closeBtn = modal.querySelector('.modal-header .btn-icon');
            if (closeBtn) closeBtn.click();
          }

          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
        }

        document.addEventListener('touchmove', onMove, { passive: true });
        document.addEventListener('touchend', onEnd);
      }, { passive: true });
    })();
  