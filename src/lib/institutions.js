/**
 * Institution branding. `accent` is the optional narrow stripe used to
 * tell apart near-identical brand blues (established for Nationwide, usable
 * for any future account).
 */
export const INSTITUTIONS = {
  barclaycard: { label: 'Barclaycard', colour: '#037CC2', accent: null },
  nationwide: { label: 'Nationwide', colour: '#0071BF', accent: '#D0021B' },
  mbna: { label: 'MBNA', colour: '#045FA9', accent: null },
  monzo: { label: 'Monzo', colour: '#FF4D56', accent: null },
  chase: { label: 'Chase', colour: '#117ACA', accent: null },
  other: { label: 'Other', colour: '#6B7280', accent: null },
};

export function institutionStyle(key) {
  return INSTITUTIONS[key] ?? INSTITUTIONS.other;
}
