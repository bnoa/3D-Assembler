// Unicode Bidirectional Algorithm (UAX #9) for one line, as Windows text layout applies it
// for 3D Builder: left-to-right paragraph (the default reading direction), weak types (W1-W7),
// neutrals (N1-N2), implicit levels (I1-I2), trailing whitespace (L1), reordering (L2) and
// mirroring of paired punctuation (L4). Explicit embeddings and isolates (LRE, RLO, LRI…) are
// treated as boundary neutrals; the character classes are taken by Unicode ranges.

type T = 'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN' | 'CS' | 'NSM' | 'BN' | 'B' | 'S' | 'WS' | 'ON';

const inR = (cp: number, ranges: number[]) => {
  for (let i = 0; i < ranges.length; i += 2) if (cp >= ranges[i] && cp <= ranges[i + 1]) return true;
  return false;
};

const NSM = [0x0300, 0x036f, 0x0483, 0x0489, 0x0591, 0x05bd, 0x05bf, 0x05bf, 0x05c1, 0x05c2, 0x05c4, 0x05c5, 0x05c7, 0x05c7,
  0x0610, 0x061a, 0x064b, 0x065f, 0x0670, 0x0670, 0x06d6, 0x06dc, 0x06df, 0x06e4, 0x06e7, 0x06e8, 0x06ea, 0x06ed,
  0x0711, 0x0711, 0x0730, 0x074a, 0x07a6, 0x07b0, 0x07eb, 0x07f3, 0x0816, 0x082d, 0x0859, 0x085b, 0x08d3, 0x08e1, 0x08e3, 0x08ff,
  0x0900, 0x0902, 0x093a, 0x093a, 0x093c, 0x093c, 0x0941, 0x0948, 0x094d, 0x094d, 0x0e31, 0x0e31, 0x0e34, 0x0e3a, 0x0e47, 0x0e4e,
  0x1ab0, 0x1aff, 0x1dc0, 0x1dff, 0x20d0, 0x20ff, 0xfe00, 0xfe0f, 0xfe20, 0xfe2f];
const ON = [0x0021, 0x0022, 0x0026, 0x002a, 0x003b, 0x0040, 0x005b, 0x0060, 0x007b, 0x007e, 0x00a1, 0x00a1, 0x00a6, 0x00a9,
  0x00ab, 0x00ac, 0x00ae, 0x00af, 0x00b4, 0x00b4, 0x00b6, 0x00b8, 0x00bb, 0x00bf, 0x00d7, 0x00d7, 0x00f7, 0x00f7,
  0x02b9, 0x02ba, 0x02c2, 0x02cf, 0x02d2, 0x02df, 0x0606, 0x0607, 0x060e, 0x060f, 0x06de, 0x06de, 0x06e9, 0x06e9,
  0x2010, 0x2027, 0x2035, 0x2043, 0x2045, 0x205e, 0x207c, 0x207e, 0x208c, 0x208e, 0x2100, 0x2101, 0x2103, 0x2106, 0x2108, 0x2109,
  0x2116, 0x2118, 0x211e, 0x2123, 0x2125, 0x2125, 0x2127, 0x2127, 0x2129, 0x2129, 0x2140, 0x2144, 0x214a, 0x214d,
  0x2190, 0x2211, 0x2214, 0x2335, 0x237b, 0x2394, 0x2396, 0x2487, 0x24ea, 0x26ab, 0x26ad, 0x27ff, 0x2900, 0x2b73,
  0x2e00, 0x2e5d, 0x3001, 0x3004, 0x3008, 0x3020, 0xfd3e, 0xfd3f, 0xfe10, 0xfe19, 0xfe30, 0xfe4f, 0xfe51, 0xfe51, 0xfe54, 0xfe54,
  0xfe56, 0xfe5e, 0xfe60, 0xfe61, 0xfe64, 0xfe66, 0xfe68, 0xfe68, 0xfe6b, 0xfe6b, 0xff01, 0xff02, 0xff06, 0xff0a, 0xff1b, 0xff20,
  0xff3b, 0xff40, 0xff5b, 0xff65, 0x1f000, 0x1faff];

export function bidiClass(cp: number): T {
  if (cp === 0x200e) return 'L';
  if (cp === 0x200f) return 'R';
  if (cp === 0x061c) return 'AL';
  if (cp === 0x0a || cp === 0x0d || (cp >= 0x1c && cp <= 0x1e) || cp === 0x85 || cp === 0x2029) return 'B';
  if (cp === 0x09 || cp === 0x0b || cp === 0x1f) return 'S';
  if (cp === 0x20 || cp === 0x0c || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x205f || cp === 0x3000) return 'WS';
  if (cp <= 0x08 || (cp >= 0x0e && cp <= 0x1b) || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad || (cp >= 0x200b && cp <= 0x200d) ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff) return 'BN';
  if ((cp >= 0x30 && cp <= 0x39) || cp === 0xb2 || cp === 0xb3 || cp === 0xb9 || (cp >= 0x06f0 && cp <= 0x06f9) ||
    (cp >= 0x2070 && cp <= 0x2079 && cp !== 0x2071 && cp !== 0x2072 && cp !== 0x2073) || (cp >= 0x2080 && cp <= 0x2089) || (cp >= 0xff10 && cp <= 0xff19) || (cp >= 0x1d7ce && cp <= 0x1d7ff)) return 'EN';
  if ((cp >= 0x0600 && cp <= 0x0605) || (cp >= 0x0660 && cp <= 0x0669) || cp === 0x066b || cp === 0x066c || cp === 0x06dd || cp === 0x08e2) return 'AN';
  if (cp === 0x2b || cp === 0x2d || cp === 0x207a || cp === 0x207b || cp === 0x208a || cp === 0x208b || cp === 0x2212 || cp === 0xfb29 || cp === 0xfe62 || cp === 0xfe63 || cp === 0xff0b || cp === 0xff0d) return 'ES';
  if ((cp >= 0x23 && cp <= 0x25) || (cp >= 0xa2 && cp <= 0xa5) || cp === 0xb0 || cp === 0xb1 || cp === 0x058f || cp === 0x0609 || cp === 0x060a || cp === 0x066a ||
    (cp >= 0x2030 && cp <= 0x2034) || (cp >= 0x20a0 && cp <= 0x20cf) || cp === 0x2213 || (cp >= 0xff03 && cp <= 0xff05) || cp === 0xffe0 || cp === 0xffe1 || cp === 0xffe5 || cp === 0xffe6) return 'ET';
  if (cp === 0x2c || cp === 0x2e || cp === 0x2f || cp === 0x3a || cp === 0xa0 || cp === 0x060c || cp === 0x202f || cp === 0x2044 ||
    cp === 0xfe50 || cp === 0xfe52 || cp === 0xfe55 || cp === 0xff0c || cp === 0xff0e || cp === 0xff0f || cp === 0xff1a) return 'CS';
  if (inR(cp, NSM)) return 'NSM';
  if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0x07c0 && cp <= 0x085f) || (cp >= 0xfb1d && cp <= 0xfb4f) || (cp >= 0x10800 && cp <= 0x10fff) || (cp >= 0x1e800 && cp <= 0x1edff) || (cp >= 0x1ef00 && cp <= 0x1efff)) return 'R';
  if ((cp >= 0x0600 && cp <= 0x07bf) || (cp >= 0x0860 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdcf) || (cp >= 0xfdf0 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefe) || (cp >= 0x1ee00 && cp <= 0x1eeff)) return 'AL';
  if (inR(cp, ON)) return 'ON';
  return 'L';
}

const MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«', '‹': '›', '›': '‹',
  '⁅': '⁆', '⁆': '⁅', '≤': '≥', '≥': '≤', '∈': '∋', '∋': '∈', '⟨': '⟩', '⟩': '⟨', '〈': '〉', '〉': '〈', '「': '」', '」': '「', '『': '』', '』': '『',
  '（': '）', '）': '（', '［': '］', '］': '［', '｛': '｝', '｝': '｛', '﴾': '﴿', '﴿': '﴾',
};

/** Embedding levels of a left-to-right line (0 = left to right, odd = right to left). */
export function bidiLevels(chars: string[]): number[] {
  const n = chars.length;
  const t: T[] = chars.map((c) => bidiClass(c.codePointAt(0)!));
  const orig = t.slice();
  const sor: T = 'L', eor: T = 'L';
  // X9 (simplified): boundary neutrals take the type of what precedes them, like NSM.
  // W1: NSM takes the type of the previous character (sor at the start).
  for (let i = 0; i < n; i++) if (t[i] === 'NSM' || t[i] === 'BN') t[i] = i ? t[i - 1] : sor;
  // W2: EN after AL (as last strong) becomes AN.
  let strong: T = sor;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R' || t[i] === 'AL') strong = t[i];
    else if (t[i] === 'EN' && strong === 'AL') t[i] = 'AN';
  }
  // W3: AL becomes R.
  for (let i = 0; i < n; i++) if (t[i] === 'AL') t[i] = 'R';
  // W4: a single separator between two numbers of the same kind joins them.
  for (let i = 1; i + 1 < n; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    else if (t[i] === 'CS' && t[i - 1] === t[i + 1] && (t[i - 1] === 'EN' || t[i - 1] === 'AN')) t[i] = t[i - 1];
  }
  // W5: terminators next to European numbers become EN.
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue;
    let j = i;
    while (j < n && t[j] === 'ET') j++;
    if ((i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN')) for (let k = i; k < j; k++) t[k] = 'EN';
    i = j - 1;
  }
  // W6: remaining separators and terminators become ON.
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'ET' || t[i] === 'CS') t[i] = 'ON';
  // W7: EN after L (as last strong) becomes L.
  strong = sor;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R') strong = t[i];
    else if (t[i] === 'EN' && strong === 'L') t[i] = 'L';
  }
  // N1/N2: neutral sequences take the direction around them if both sides agree (numbers count
  // as R), else the embedding direction (L).
  const isNeutral = (x: T) => x === 'B' || x === 'S' || x === 'WS' || x === 'ON';
  const dirOf = (x: T): 'L' | 'R' => (x === 'L' ? 'L' : 'R');
  for (let i = 0; i < n; i++) {
    if (!isNeutral(t[i])) continue;
    let j = i;
    while (j < n && isNeutral(t[j])) j++;
    const before = i > 0 ? dirOf(t[i - 1]) : dirOf(sor);
    const after = j < n ? dirOf(t[j]) : dirOf(eor);
    const d: T = before === after ? before : 'L';
    for (let k = i; k < j; k++) t[k] = d;
    i = j - 1;
  }
  // I1: on the even paragraph level, R goes up one, numbers up two.
  const lv = t.map((x) => (x === 'R' ? 1 : x === 'AN' || x === 'EN' ? 2 : 0));
  // L1: segment separators and trailing whitespace return to the paragraph level.
  for (let i = 0; i < n; i++) if (orig[i] === 'S' || orig[i] === 'B') lv[i] = 0;
  for (let i = n - 1; i >= 0 && (orig[i] === 'WS' || orig[i] === 'S' || orig[i] === 'BN' || orig[i] === 'B'); i--) lv[i] = 0;
  return lv;
}

/** Characters in display order (L2), with paired punctuation mirrored on right-to-left levels (L4). */
export function visualOrder(chars: string[]): string[] {
  const lv = bidiLevels(chars);
  const idx = chars.map((_, i) => i);
  const max = Math.max(0, ...lv);
  for (let level = max; level >= 1; level--) {
    for (let i = 0; i < idx.length; i++) {
      if (lv[idx[i]] < level) continue;
      let j = i;
      while (j < idx.length && lv[idx[j]] >= level) j++;
      const seg = idx.slice(i, j).reverse();
      for (let k = 0; k < seg.length; k++) idx[i + k] = seg[k];
      i = j - 1;
    }
  }
  return idx.map((i) => (lv[i] % 2 && MIRROR[chars[i]] ? MIRROR[chars[i]] : chars[i]));
}
