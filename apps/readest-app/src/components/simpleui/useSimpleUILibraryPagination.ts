import { useCallback, useMemo, useState } from 'react';

type LibraryRow = { type: 'divider' | 'heading' | 'empty' | 'carousel' | 'items' };

export function paginateBookshelfRows<T extends LibraryRow>(rows: T[], rowsPerPage = 2): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let pending: T[] = [];
  let contentRows = 0;
  for (const row of rows) {
    if (row.type === 'heading' || row.type === 'divider') {
      pending.push(row);
      continue;
    }
    if (contentRows === rowsPerPage) {
      pages.push(page);
      page = [];
      contentRows = 0;
    }
    page.push(...pending, row);
    pending = [];
    contentRows++;
  }
  page.push(...pending);
  if (page.length) pages.push(page);
  return pages;
}

export function useSimpleUILibraryPagination<T extends LibraryRow>(
  rows: T[],
  rowKeys: string,
  enabled: boolean,
  rowsPerPage = 2,
) {
  const pages = useMemo(
    () => (enabled ? paginateBookshelfRows(rows, rowsPerPage) : []),
    [enabled, rows, rowsPerPage],
  );
  const [state, setState] = useState({ rowKeys, pageIndex: 0 });
  const pageIndex = state.rowKeys === rowKeys ? state.pageIndex : 0;
  const currentPageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const turnPage = useCallback(
    (direction: number) => {
      setState((current) => {
        const index = current.rowKeys === rowKeys ? current.pageIndex : 0;
        return { rowKeys, pageIndex: Math.max(0, Math.min(pages.length - 1, index + direction)) };
      });
    },
    [pages.length, rowKeys],
  );
  return {
    pages,
    currentPageIndex,
    visibleRows: enabled ? (pages[currentPageIndex] ?? []) : rows,
    turnPage,
  };
}
