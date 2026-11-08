/** Hall appearance preference: classical colonnades vs Subside-like seamless future. */
export const STYLE_CLASSIC = 'classic';
export const STYLE_FUTURE = 'future';
export const STYLES = [
  { id: STYLE_CLASSIC, label: 'Classic', hint: 'Columns, arches, coffered vaults' },
  { id: STYLE_FUTURE, label: 'Future', hint: 'Soft capsules, open mouths, oculus rings' },
];

const KEY = 'mg5.envStyle.v1';

export function loadEnvStyle() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === STYLE_FUTURE || v === STYLE_CLASSIC) return v;
  } catch { /* */ }
  return STYLE_CLASSIC;
}

export function saveEnvStyle(id) {
  const v = id === STYLE_CLASSIC ? STYLE_CLASSIC : STYLE_FUTURE;
  try { localStorage.setItem(KEY, v); } catch { /* */ }
  return v;
}
