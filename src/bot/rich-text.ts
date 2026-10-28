import type { RichText } from 'node-telegram-bot-api';

type Style = 'bold' | 'italic' | 'code';

interface Styled {
  type: Style;
  text: RichText;
}

type Piece = string | Styled;

/** Keep chat titles and other outside text from being read as formatting. */
export function mdEscape(value: string): string {
  return value.replace(/[\\*`]/g, (char) => `\\${char}`);
}

/**
 * A small markdown subset for dialog copy: **bold**, *italic*, and `code`.
 * A backslash keeps the next character literal. Unclosed markers stay as text.
 */
export function richInline(source: string): RichText {
  return collapse(read(source, 0, source.length, true));
}

function read(source: string, start: number, end: number, styled: boolean): Piece[] {
  const pieces: Piece[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain.length === 0) return;
    pieces.push(plain);
    plain = '';
  };
  for (let index = start; index < end; ) {
    if (styled && source[index] === '\\' && index + 1 < end) {
      plain += source[index + 1];
      index += 2;
      continue;
    }
    const token = styled ? tokenAt(source, index) : null;
    if (token) {
      const close = indexOfToken(source, index + token.length, end, token);
      if (close >= 0) {
        flush();
        const text =
          token === '`'
            ? source.slice(index + 1, close)
            : collapse(read(source, index + token.length, close, true));
        if (text !== '') pieces.push({ type: styleFor(token), text });
        index = close + token.length;
        continue;
      }
    }
    plain += source[index];
    index += 1;
  }
  flush();
  return pieces;
}

function styleFor(token: string): Style {
  if (token === '**') return 'bold';
  if (token === '`') return 'code';
  return 'italic';
}

function tokenAt(source: string, index: number): '**' | '*' | '`' | null {
  if (source.startsWith('**', index)) return '**';
  if (source[index] === '*') return '*';
  if (source[index] === '`') return '`';
  return null;
}

function indexOfToken(source: string, from: number, end: number, token: string): number {
  for (let index = from; index < end; index += 1) {
    if (source[index] === '\\' && token !== '`') {
      index += 1;
      continue;
    }
    if (token === '*' && source.startsWith('**', index)) {
      index += 1;
      continue;
    }
    if (source.startsWith(token, index)) return index;
  }
  return -1;
}

function collapse(pieces: Piece[]): RichText {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    if (typeof piece === 'string' && piece.length === 0) continue;
    const previous = merged.at(-1);
    if (typeof piece === 'string' && typeof previous === 'string') merged[merged.length - 1] = previous + piece;
    else merged.push(piece);
  }
  if (merged.length === 0) return '';
  if (merged.length === 1 && typeof merged[0] === 'string') return merged[0];
  return merged.map((piece) => (typeof piece === 'string' ? piece : { type: piece.type, text: piece.text }));
}
