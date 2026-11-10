/** Hall appearance: Roman colonnades, Mughal court, or Subside-like future. */
export const STYLE_CLASSIC = 'classic';
export const STYLE_MUGHAL = 'mughal';
export const STYLE_FUTURE = 'future';
export const STYLES = [
  { id: STYLE_CLASSIC, label: 'Classic', hint: 'Columns, arches, coffered vaults' },
  { id: STYLE_MUGHAL, label: 'Mughal', hint: 'Pointed iwans, sandstone and marble, onion dome' },
  { id: STYLE_FUTURE, label: 'Future', hint: 'Soft capsules, open mouths, oculus rings' },
];

const KEY = 'mg5.envStyle.v1';
const IDS = new Set(STYLES.map((s) => s.id));

export function loadEnvStyle() {
  try {
    const v = localStorage.getItem(KEY);
    if (IDS.has(v)) return v;
  } catch { /* */ }
  return STYLE_CLASSIC;
}

export function saveEnvStyle(id) {
  const v = IDS.has(id) ? id : STYLE_CLASSIC;
  try { localStorage.setItem(KEY, v); } catch { /* */ }
  return v;
}
