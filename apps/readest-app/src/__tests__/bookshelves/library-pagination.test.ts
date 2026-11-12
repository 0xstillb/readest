// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import type { ShelfSection } from '@/app/library/components/BookshelfStream';
import { buildBookshelfRows } from '@/app/library/components/BookshelfStream';
import { paginateBookshelfRows } from '@/components/simpleui/useSimpleUILibraryPagination';
import { defaultBookshelves } from '@/services/bookshelves/definitions';

const defaultShelf = defaultBookshelves({}).find((shelf) => shelf.id === 'default')!;
const makeSection = (count: number): ShelfSection => ({
  definition: { ...defaultShelf, layout: 'grid' },
  items: Array.from(
    { length: count },
    (_, index) =>
      ({ hash: `book-${index}`, title: `Book ${index}`, author: 'Author', format: 'EPUB' }) as Book,
  ),
});
const itemCountsPerPage = (columns: number) =>
  paginateBookshelfRows(buildBookshelfRows([makeSection(9)], columns)).map((page) =>
    page.reduce((count, row) => count + (row.items?.length ?? 0), 0),
  );

describe('Simple UI Library pagination', () => {
  it('shows two grid rows per page when Readest uses two columns', () => {
    expect(itemCountsPerPage(2)).toEqual([4, 4, 1]);
  });

  it('shows two grid rows per page when Readest uses three columns', () => {
    expect(itemCountsPerPage(3)).toEqual([6, 3]);
  });
});
