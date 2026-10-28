export interface Page<T> {
  page: number;
  pages: number;
  items: T[];
}

export function pageSlice<T>(items: readonly T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const safe = Math.min(Math.max(0, page), pages - 1);
  return {
    page: safe,
    pages,
    items: items.slice(safe * size, safe * size + size),
  };
}
