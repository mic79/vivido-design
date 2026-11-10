/** Hall appearance: Roman colonnades, Mughal court, or Subside-like future. */
export const STYLE_CLASSIC = 'classic';
export const STYLE_MUGHAL = 'mughal';
export const STYLE_FUTURE = 'future';
export const STYLES = [
  { id: STYLE_CLASSIC, label: 'Classic', hint: 'Columns, arches, coffered vaults' },
  { id: STYLE_MUGHAL, label: 'Mughal', hint: 'Pointed iwans, sandstone and marble, onion dome' },
  { id: STYLE_FUTURE, label: 'Future', hint: 'Soft capsules, open mouths, oculus rings', hidden: true },
];

/** Styles offered in the UI (hidden ones remain loadable via ?style=). */
export const STYLES_UI = STYLES.filter((s) => !s.hidden);

const KEY = 'mg5.envStyle.v1';
const IDS = new Set(STYLES.map((s) => s.id));
const UI_IDS = new Set(STYLES_UI.map((s) => s.id));

export function loadEnvStyle() {
  try {
    const v = localStorage.getItem(KEY);
    if (UI_IDS.has(v)) return v;
    // Saved "future" (now hidden) falls back to classic unless URL forces it.
    if (IDS.has(v) && !UI_IDS.has(v)) return STYLE_CLASSIC;
  } catch { /* */ }
  return STYLE_CLASSIC;
}

export function saveEnvStyle(id) {
  const v = UI_IDS.has(id) ? id : (IDS.has(id) ? id : STYLE_CLASSIC);
  // Don't persist a hidden style as the default preference.
  try { localStorage.setItem(KEY, UI_IDS.has(v) ? v : STYLE_CLASSIC); } catch { /* */ }
  return v;
}
