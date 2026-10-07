/**
 * Institution branding. `accent` is the optional narrow stripe used to
 * tell apart near-identical brand blues (established for Nationwide, usable
 * for any future account). `ink` is the text/icon colour used on top of the
 * brand colour (banner, hover buttons); defaults to white, so only light
 * brand colours (Klarna's pink) need to set it.
 */
export const INSTITUTIONS = {
  barclaycard: { label: 'Barclaycard', colour: '#037CC2', accent: null },
  nationwide: { label: 'Nationwide', colour: '#0071BF', accent: '#D0021B' },
  mbna: { label: 'MBNA', colour: '#045FA9', accent: null },
  monzo: { label: 'Monzo', colour: '#FF4D56', accent: null },
  chase: { label: 'Chase', colour: '#117ACA', accent: null },
  // Monzo Flex card: dark navy base with the coral stripe. Navy is from
  // memory of Monzo's palette, not confirmed against the card: adjust if needed.
  monzoflex: { label: 'Monzo Flex', colour: '#14233C', accent: '#FF4D56' },
  // Klarna pink #FFA8CD is from Klarna's own docs; their black #0B051D is
  // the text colour on pink (white on this pink is unreadable).
  klarna: { label: 'Klarna', colour: '#FFA8CD', accent: null, ink: '#0B051D' },
  // Very: PLACEHOLDER neutral charcoal. No official hex found; replace.
  very: { label: 'Very', colour: '#2B2B2B', accent: null },
  other: { label: 'Other', colour: '#6B7280', accent: null },
};

export function institutionStyle(key) {
  return { ink: '#FFFFFF', ...(INSTITUTIONS[key] ?? INSTITUTIONS.other) };
}
