// Interface language. The interface is written in French; in English, the visible texts (text nodes,
// tooltips, accessible names, placeholders, the window title, confirmation messages) are swapped for
// their translation as they appear, and swapped back when French is chosen again.
import EN from './i18n-en.json';

export type Lang = 'en' | 'fr';

const exact = new Map<string, string>();
const patterns: { re: RegExp; to: string; keys: number[] }[] = [];
for (const [fr, en] of Object.entries(EN as Record<string, string>)) {
  if (!/\{\d+\}/.test(fr)) { exact.set(fr, en); continue; }
  // « … {0} … » → a regular expression capturing each placeholder.
  const keys: number[] = [];
  const src = fr.split(/(\{\d+\})/).map((part) => {
    const m = part.match(/^\{(\d+)\}$/);
    if (m) { keys.push(+m[1]); return '(.+?)'; }
    return part.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  }).join('');
  patterns.push({ re: new RegExp(`^${src}$`, 's'), to: en, keys });
}

/** English for a French interface text (unchanged when unknown). */
export function toEnglish(text: string): string {
  const t = text.trim();
  if (!t) return text;
  let out = exact.get(t);
  if (out === undefined) {
    for (const p of patterns) {
      const m = t.match(p.re);
      if (!m) continue;
      out = p.to;
      p.keys.forEach((k, i) => { out = out!.split(`{${k}}`).join(toEnglish(m[i + 1])); });
      break;
    }
  }
  if (out === undefined) return text;
  // Keep the spaces around the text (labels followed by a value).
  const lead = text.match(/^\s*/)![0], trail = text.match(/\s*$/)![0];
  return lead + out + trail;
}

/** The language of the browser or system: French for French, English otherwise. */
export function systemLang(): Lang {
  return (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

const ATTRS = ['title', 'aria-label', 'placeholder'];
const original = new WeakMap<Node, string>();
const originalAttr = new WeakMap<Element, Map<string, string>>();
let current: Lang = 'fr';
let observer: MutationObserver | null = null;
let applying = false;

function translateText(node: Text): void {
  const parent = node.parentElement;
  if (!parent || parent.closest('script, style, textarea, [contenteditable], [data-no-i18n]')) return;
  const value = node.nodeValue ?? '';
  const known = original.get(node);
  // A text changed by the app since the last pass: take it as the new French text.
  const fr = known !== undefined && toEnglish(known) === value ? known : value;
  // A label whose meaning differs from the dictionary's carries its own English (data-en).
  const own = parent.getAttribute('data-en');
  const en = own !== null && parent.childNodes.length === 1 ? own : toEnglish(fr);
  if (en !== fr) { original.set(node, fr); if (value !== en) node.nodeValue = en; }
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const value = el.getAttribute(a);
    if (!value) continue;
    let map = originalAttr.get(el);
    const known = map?.get(a);
    const fr = known !== undefined && toEnglish(known) === value ? known : value;
    const en = toEnglish(fr);
    if (en === fr) continue;
    if (!map) { map = new Map(); originalAttr.set(el, map); }
    map.set(a, fr);
    if (value !== en) el.setAttribute(a, en);
  }
}

function walk(root: Node, fn: (n: Node) => void): void {
  fn(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) fn(n);
}

function translate(root: Node): void {
  walk(root, (n) => {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else if (n.nodeType === Node.ELEMENT_NODE) translateAttrs(n as Element);
  });
}

function restore(root: Node): void {
  walk(root, (n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const fr = original.get(n);
      if (fr !== undefined) n.nodeValue = fr;
      original.delete(n);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const map = originalAttr.get(n as Element);
      if (!map) return;
      for (const [a, fr] of map) if ((n as Element).getAttribute(a) === toEnglish(fr)) (n as Element).setAttribute(a, fr);
      originalAttr.delete(n as Element);
    }
  });
}

const nativeConfirm = window.confirm.bind(window);
let titleFr = '';

/** Shows the interface in `lang` from now on (the DOM is translated as it changes). */
export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
  observer?.disconnect();
  observer = null;
  if (lang === 'fr') {
    restore(document.body);
    if (titleFr) document.title = titleFr;
    window.confirm = nativeConfirm;
    return;
  }
  translate(document.body);
  window.confirm = (msg?: string) => nativeConfirm(msg === undefined ? msg : toEnglish(String(msg)));
  observer = new MutationObserver((records) => {
    if (applying) return;
    applying = true;
    try {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach((n) => translate(n));
        else if (r.type === 'characterData') translateText(r.target as Text);
        else if (r.type === 'attributes' && r.target.nodeType === Node.ELEMENT_NODE) translateAttrs(r.target as Element);
      }
      const title = document.title;
      const enTitle = toEnglish(title);
      if (enTitle !== title) { titleFr = title; document.title = enTitle; }
    } finally {
      applying = false;
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const t = document.title, en = toEnglish(t);
  if (en !== t) { titleFr = t; document.title = en; }
}

export const currentLang = (): Lang => current;
