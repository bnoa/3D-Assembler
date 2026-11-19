// Arabic contextual shaping. Windows shapes Arabic text for 3D Builder (OpenType init/medi/fina/isol
// and the mandatory lam-alef ligatures). Here each letter is replaced by its Unicode presentation
// form for its position; Windows fonts map these forms to the same glyphs the OpenType features
// select. Letters keep their nominal form when no font has the presentation form.

// Presentation forms per letter: [isolated, final, initial, medial]; two entries = joins on the right only.
const FORMS: Record<number, number[]> = {
  0x0621: [0xfe80],
  0x0622: [0xfe81, 0xfe82], 0x0623: [0xfe83, 0xfe84], 0x0624: [0xfe85, 0xfe86], 0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c], 0x0627: [0xfe8d, 0xfe8e], 0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94], 0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98], 0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0], 0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4], 0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa], 0x0630: [0xfeab, 0xfeac], 0x0631: [0xfead, 0xfeae], 0x0632: [0xfeaf, 0xfeb0],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4], 0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8], 0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0], 0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4], 0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc], 0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4], 0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8], 0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0], 0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4], 0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec], 0x0648: [0xfeed, 0xfeee], 0x0649: [0xfeef, 0xfef0], 0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  // Persian and Urdu letters (Presentation Forms-A).
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59], 0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d], 0x0698: [0xfb8a, 0xfb8b],
  0x06a9: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91], 0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95], 0x06cc: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff],
};
const TATWEEL = 0x0640;
// Lam followed by an alef: mandatory ligature [isolated, final].
const LAM_ALEF: Record<number, [number, number]> = { 0x0622: [0xfef5, 0xfef6], 0x0623: [0xfef7, 0xfef8], 0x0625: [0xfef9, 0xfefa], 0x0627: [0xfefb, 0xfefc] };

/** Presentation form → the nominal characters it stands for (used when no font has the form). */
export const NOMINAL = new Map<number, string>();
for (const [base, forms] of Object.entries(FORMS)) for (const f of forms) NOMINAL.set(f, String.fromCodePoint(+base));
for (const [alef, forms] of Object.entries(LAM_ALEF)) for (const f of forms) NOMINAL.set(f, 'ل' + String.fromCodePoint(+alef));

const isMark = (cp: number) => (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || (cp >= 0x06d6 && cp <= 0x06ed);
type Join = 'D' | 'R' | 'U';
const joining = (cp: number): Join => (cp === TATWEEL ? 'D' : FORMS[cp] ? (FORMS[cp].length === 4 ? 'D' : FORMS[cp].length === 2 ? 'R' : 'U') : 'U');

/** Replaces Arabic letters (logical order) by their contextual presentation forms. */
export function shapeArabic(chars: string[]): string[] {
  const cps = chars.map((c) => c.codePointAt(0)!);
  if (!cps.some((cp) => FORMS[cp])) return chars;
  const out: string[] = [];
  // Nearest non-mark neighbour on each side.
  const neighbour = (i: number, step: number) => {
    for (let j = i + step; j >= 0 && j < cps.length; j += step) if (!isMark(cps[j])) return j;
    return -1;
  };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const forms = FORMS[cp];
    if (!forms) { out.push(chars[i]); continue; }
    const p = neighbour(i, -1), n = neighbour(i, 1);
    const joinsPrev = p >= 0 && joining(cps[p]) === 'D' && joining(cp) !== 'U';
    // Lam-alef ligature (the alef directly after the lam, marks aside).
    if (cp === 0x0644 && n >= 0 && LAM_ALEF[cps[n]]) {
      out.push(String.fromCodePoint(LAM_ALEF[cps[n]][joinsPrev ? 1 : 0]));
      for (let j = i + 1; j < n; j++) out.push(chars[j]); // marks between them
      i = n;
      continue;
    }
    const joinsNext = joining(cp) === 'D' && n >= 0 && joining(cps[n]) !== 'U';
    let f: number;
    if (forms.length === 1) f = forms[0];
    else if (forms.length === 2) f = forms[joinsPrev ? 1 : 0];
    else f = forms[joinsPrev && joinsNext ? 3 : joinsNext ? 2 : joinsPrev ? 1 : 0];
    out.push(String.fromCodePoint(f));
  }
  return out;
}
