import { describe, expect, it } from 'vitest';
import { bidiLevels, visualOrder } from '../src/geometry/bidi';

const vis = (s: string) => visualOrder(Array.from(s)).join('');

describe('bidirectional algorithm (UAX #9, left-to-right line)', () => {
  it('leaves left-to-right text alone', () => {
    expect(vis('Hello, world! 123')).toBe('Hello, world! 123');
  });

  it('reverses a right-to-left run inside left-to-right text', () => {
    expect(vis('ab שלום cd')).toBe('ab םולש cd');
  });

  it('keeps numbers left to right inside a right-to-left run', () => {
    // Hebrew then a number: the number stays readable, the whole run is right to left.
    expect(vis('שלום 123')).toBe('123 םולש');
    expect(bidiLevels(Array.from('שלום 123'))).toEqual([1, 1, 1, 1, 1, 2, 2, 2]);
  });

  it('puts punctuation between two right-to-left words on their side', () => {
    // Arabic word, colon, Arabic word: one right-to-left run, colon included.
    expect(vis('ابت: ثج')).toBe('جث :تبا');
  });

  it('mirrors parentheses inside a right-to-left run', () => {
    expect(vis('א(ב)ג')).toBe('ג(ב)א');
  });

  it('keeps a number with separators together (W4) and joins terminators (W5)', () => {
    expect(vis('א 1,234.5 ב')).toBe('ב 1,234.5 א');
    expect(vis('א 50% ב')).toBe('ב 50% א');
  });

  it('treats Arabic-Indic digits as Arabic numbers after Arabic letters', () => {
    expect(vis('ا ١٢٣')).toBe('١٢٣ ا');
  });

  it('returns trailing whitespace to the line direction', () => {
    expect(bidiLevels(Array.from('שלום  ')).slice(-2)).toEqual([0, 0]);
  });
});
