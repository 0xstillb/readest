import type {
  ShelfPage,
  ShelfSnapshot,
  ShelfSnapshotStatus,
  ShelfSyncAdapter,
  ShelfSyncBook,
} from './types';

export type { ShelfSnapshotStatus };

/**
 * Creates a complete shelf snapshot with confirmed membership.
 */
export function createCompleteSnapshot<TBook = ShelfSyncBook<unknown>>(
  books: TBook[],
): ShelfSnapshot<TBook> {
  return {
    status: 'complete',
    books,
  };
}

/**
 * Creates a failed shelf snapshot.
 */
export function createFailedSnapshot<TBook = ShelfSyncBook<unknown>>(
  error: unknown,
  books: TBook[] = [],
): ShelfSnapshot<TBook> {
  return {
    status: 'failed',
    books,
    error,
  };
}

/**
 * Creates a partial shelf snapshot resulting from mid-pagination error or interruption.
 */
export function createPartialSnapshot<TBook = ShelfSyncBook<unknown>>(
  books: TBook[],
  error?: unknown,
  cursor?: string | null,
): ShelfSnapshot<TBook> {
  return {
    status: 'partial',
    books,
    error,
    cursor,
  };
}

/**
 * Creates a cancelled shelf snapshot.
 */
export function createCancelledSnapshot<TBook = ShelfSyncBook<unknown>>(
  books: TBook[] = [],
  error?: unknown,
): ShelfSnapshot<TBook> {
  return {
    status: 'cancelled',
    books,
    error: error ?? new Error('Shelf sync cancelled'),
  };
}

/**
 * Creates a snapshot indicating that pagination state is invalid/expired and restart is required.
 */
export function createRestartRequiredSnapshot<TBook = ShelfSyncBook<unknown>>(
  books: TBook[] = [],
  error?: unknown,
): ShelfSnapshot<TBook> {
  return {
    status: 'restart_required',
    books,
    restartRequired: true,
    error: error ?? new Error('Shelf pagination restart required'),
  };
}

/**
 * Type guard verifying if a snapshot is confirmed complete and successful.
 */
export function isCompleteSnapshot<TBook = ShelfSyncBook<unknown>>(
  snapshot: ShelfSnapshot<TBook> | null | undefined,
): snapshot is ShelfSnapshot<TBook> & { status: 'complete' } {
  return (
    snapshot != null &&
    snapshot.status === 'complete' &&
    !snapshot.restartRequired &&
    Array.isArray(snapshot.books)
  );
}

/**
 * Generic snapshot collector.
 *
 * Traverses pages or fetches complete snapshots from an adapter while enforcing the Data Safety Invariant:
 * - Offline / error before first page -> failed snapshot
 * - Mid-pagination error -> partial snapshot (preserves retrieved books, but marks incomplete)
 * - AbortSignal cancellation before or mid-pagination -> cancelled snapshot
 * - Malformed page payloads (non-object, missing/non-array books, corrupt book items) -> failed or partial
 * - restartRequired flag on page or snapshot -> restart_required snapshot
 * - Looping or duplicate cursor -> partial snapshot with loop error (prevents infinite cycles)
 * - Confirmed complete empty shelf -> complete snapshot with books: []
 */
export async function collectShelfSnapshot<
  TId extends string | number = string | number,
  TBook extends ShelfSyncBook<TId> = ShelfSyncBook<TId>,
>(
  adapter: ShelfSyncAdapter<TId, TBook>,
  shelfType: string,
  shelfId: string | number,
  options?: { signal?: AbortSignal },
): Promise<ShelfSnapshot<TBook>> {
  const id = shelfId as TId;
  if (options?.signal?.aborted) {
    return createCancelledSnapshot();
  }

  // 1. Direct snapshot method
  if (typeof adapter.getShelfSnapshot === 'function') {
    try {
      const snapshot = options?.signal
        ? await adapter.getShelfSnapshot(shelfType, id, options)
        : await adapter.getShelfSnapshot(shelfType, id);
      if (options?.signal?.aborted) {
        return createCancelledSnapshot(snapshot?.books);
      }
      if (!snapshot || typeof snapshot !== 'object') {
        return createFailedSnapshot(new Error('Malformed shelf snapshot: expected an object'));
      }
      if (snapshot.restartRequired || snapshot.status === 'restart_required') {
        return createRestartRequiredSnapshot(
          Array.isArray(snapshot.books) ? snapshot.books : [],
          snapshot.error,
        );
      }
      if (!Array.isArray(snapshot.books)) {
        return createFailedSnapshot(new Error('Malformed shelf snapshot: books is not an array'));
      }
      return snapshot;
    } catch (err) {
      if (options?.signal?.aborted) {
        return createCancelledSnapshot([], err);
      }
      return createFailedSnapshot(err);
    }
  }

  // 2. Paginated retrieval method
  if (typeof adapter.getShelfPage === 'function') {
    const books: TBook[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;

    while (true) {
      if (options?.signal?.aborted) {
        return createCancelledSnapshot(books);
      }

      let page: ShelfPage<TBook>;
      try {
        page = await adapter.getShelfPage(shelfType, id, { cursor, signal: options?.signal });
      } catch (err) {
        if (options?.signal?.aborted) {
          return createCancelledSnapshot(books, err);
        }
        if (books.length > 0) {
          return createPartialSnapshot(books, err, cursor);
        }
        return createFailedSnapshot(err);
      }

      if (options?.signal?.aborted) {
        return createCancelledSnapshot(books);
      }

      if (!page || typeof page !== 'object') {
        const error = new Error('Malformed shelf page: expected a page object');
        return books.length > 0
          ? createPartialSnapshot(books, error, cursor)
          : createFailedSnapshot(error);
      }

      if (page.restartRequired) {
        return createRestartRequiredSnapshot(books);
      }

      if (!Array.isArray(page.books)) {
        const error = new Error('Malformed shelf page: books is not an array');
        return books.length > 0
          ? createPartialSnapshot(books, error, cursor)
          : createFailedSnapshot(error);
      }

      // Check for malformed items in the page
      for (const item of page.books) {
        if (
          !item ||
          typeof item !== 'object' ||
          (item as unknown as { bookId?: unknown }).bookId == null
        ) {
          const error = new Error('Malformed shelf page: invalid book record in page');
          return books.length > 0
            ? createPartialSnapshot(books, error, cursor)
            : createFailedSnapshot(error);
        }
      }

      books.push(...page.books);

      const nextCursor = page.nextCursor;
      const hasMore = page.hasMore ?? Boolean(nextCursor && nextCursor !== cursor);

      if (!hasMore || !nextCursor) {
        break;
      }

      // Looping cursor detection
      if (nextCursor === cursor) {
        return createPartialSnapshot(
          books,
          new Error(`Looping cursor detected: cursor '${nextCursor}' repeated`),
          nextCursor,
        );
      }

      if (seenCursors.has(nextCursor)) {
        return createPartialSnapshot(
          books,
          new Error(`Looping cursor detected: cursor '${nextCursor}' already visited`),
          nextCursor,
        );
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return createCompleteSnapshot(books);
  }

  // 3. Fallback: getShelfBooks
  if (typeof adapter.getShelfBooks === 'function') {
    try {
      const result = options?.signal
        ? await adapter.getShelfBooks(shelfType, id, options)
        : await adapter.getShelfBooks(shelfType, id);
      if (options?.signal?.aborted) {
        return createCancelledSnapshot();
      }

      // Support adapter returning a ShelfSnapshot directly
      if (
        result &&
        typeof result === 'object' &&
        'status' in result &&
        Array.isArray((result as ShelfSnapshot<TBook>).books)
      ) {
        const snapshot = result as ShelfSnapshot<TBook>;
        if (snapshot.restartRequired || snapshot.status === 'restart_required') {
          return createRestartRequiredSnapshot(snapshot.books, snapshot.error);
        }
        return snapshot;
      }

      if (!Array.isArray(result)) {
        return createFailedSnapshot(new Error('Malformed shelf response: expected array of books'));
      }

      for (const item of result) {
        if (
          !item ||
          typeof item !== 'object' ||
          (item as unknown as { bookId?: unknown }).bookId == null
        ) {
          return createFailedSnapshot(
            new Error('Malformed shelf response: invalid book entry in array'),
          );
        }
      }

      return createCompleteSnapshot(result);
    } catch (err) {
      if (options?.signal?.aborted) {
        return createCancelledSnapshot([], err);
      }
      return createFailedSnapshot(err);
    }
  }

  return createFailedSnapshot(new Error('Adapter does not implement shelf retrieval methods'));
}
