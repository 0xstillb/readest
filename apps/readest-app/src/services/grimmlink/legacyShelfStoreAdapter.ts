import type { GetShelfSubscriptionsOptions } from '@/services/shelfSync/ShelfSyncStore';
import { ShelfSyncStore } from '@/services/shelfSync/ShelfSyncStore';
import type { IShelfSyncStore } from '@/services/shelfSync/ShelfSyncEngine';
import type { ShelfCleanupPolicy, ShelfDownloadPolicy } from '@/services/shelfSync/types';

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Normalizes legacy GrimmLink stores (such as GrimmLinkSyncStore or legacy mock doubles)
 * into a store satisfying the provider-neutral IShelfSyncStore.
 *
 * Encapsulates legacy GrimmLink column names (`managed_by_grimmlink`, `managedByGrimmLink`),
 * parameter ordering variations, and reference count query fallbacks.
 */
export function wrapLegacyShelfStore(
  store: unknown,
  defaultProvider = 'grimmlink',
  defaultConnectionId = 'default',
): IShelfSyncStore {
  if (store instanceof ShelfSyncStore) {
    return store;
  }

  const s = store as Record<string, unknown>;
  const provider = (s['provider'] as string) || defaultProvider;
  const connectionId = (s['connectionId'] as string) || defaultConnectionId;

  return {
    provider,
    connectionId,

    async getShelfSubscriptions(options?: GetShelfSubscriptionsOptions) {
      if (typeof s['getShelfSubscriptions'] === 'function') {
        const rows = (await (s['getShelfSubscriptions'] as AnyFn)(options)) as Array<
          Record<string, unknown>
        >;
        const mapped = rows.map((row) => ({
          provider: (row['provider'] as string) || provider,
          connectionId: (row['connectionId'] as string) || connectionId,
          shelfType: (row['shelfType'] as string) || 'default',
          shelfId: String(row['shelfId']),
          enabled:
            row['enabled'] != null ? Number(row['enabled']) === 1 || row['enabled'] === true : true,
          cleanupPolicy: (row['cleanupPolicy'] as ShelfCleanupPolicy) || 'keep_local',
          downloadPolicy: (row['downloadPolicy'] as ShelfDownloadPolicy) || 'always',
          createdAt: Number(row['createdAt']) || 0,
          updatedAt: Number(row['updatedAt']) || 0,
        }));
        if (options?.enabledOnly) {
          return mapped.filter((r) => r.enabled);
        }
        return mapped;
      }
      return [];
    },

    async saveShelfSubscription(shelfIdOrInput, enabled, cleanupPolicy, downloadPolicy, shelfType) {
      if (typeof s['saveShelfSubscription'] === 'function') {
        const fn = s['saveShelfSubscription'] as AnyFn;
        if (typeof shelfIdOrInput === 'object') {
          await fn(
            shelfIdOrInput.shelfType ?? 'default',
            shelfIdOrInput.shelfId,
            shelfIdOrInput.enabled ?? true,
            shelfIdOrInput.cleanupPolicy ?? 'keep_local',
            shelfIdOrInput.downloadPolicy ?? 'always',
          );
        } else {
          await fn(
            shelfType ?? 'default',
            shelfIdOrInput,
            enabled ?? true,
            cleanupPolicy ?? 'keep_local',
            downloadPolicy ?? 'always',
          );
        }
      }
    },

    async deleteShelfSubscription(shelfId, shelfType, options) {
      if (typeof s['deleteShelfSubscription'] === 'function') {
        await (s['deleteShelfSubscription'] as AnyFn)(shelfId, shelfType, options);
      }
    },

    async getShelfEntries(shelfId, shelfType = 'default', options) {
      if (typeof s['getShelfEntries'] === 'function') {
        const fn = s['getShelfEntries'] as AnyFn;
        // Try (shelfId, shelfType) first (ShelfSyncStore), then (shelfType, shelfId) (GrimmLinkSyncStore)
        let rows = (await Promise.resolve(fn(shelfId, shelfType, options)).catch(
          () => [],
        )) as Array<Record<string, unknown>>;
        if ((!rows || rows.length === 0) && shelfType) {
          const altRows = (await Promise.resolve(fn(shelfType, shelfId, options)).catch(
            () => [],
          )) as Array<Record<string, unknown>>;
          if (altRows && altRows.length > 0) {
            rows = altRows;
          }
        }
        return (rows || []).map((row) => ({
          provider: (row['provider'] as string) || provider,
          connectionId: (row['connectionId'] as string) || connectionId,
          shelfType: (row['shelfType'] as string) || shelfType,
          shelfId: String(shelfId),
          bookId: String(row['bookId']),
          fileId: (row['fileId'] as string) ?? null,
          bookHash: (row['bookHash'] as string) ?? null,
          contentVersion: (row['contentVersion'] as string) ?? null,
          localPath: (row['localPath'] as string) ?? null,
          managedByProvider:
            row['managedByProvider'] != null
              ? !!row['managedByProvider']
              : !!row['managedByGrimmLink'],
          lastSeenAt: Number(row['lastSeenAt']) || Date.now(),
        }));
      }
      return [];
    },

    async markShelfEntries(entries) {
      if (!entries.length) return;
      if (typeof s['markShelfEntries'] === 'function') {
        await (s['markShelfEntries'] as AnyFn)(
          entries.map((e) => ({
            ...e,
            shelfType: e.shelfType ?? 'default',
            shelfId: Number(e.shelfId) || e.shelfId,
            bookId: Number(e.bookId) || e.bookId,
            bookHash: e.bookHash ?? '',
            localPath: e.localPath ?? null,
            managedByGrimmLink: !!e.managedByProvider,
            managedByProvider: !!e.managedByProvider,
          })),
        );
      } else if (typeof s['markShelfEntry'] === 'function') {
        const fn = s['markShelfEntry'] as AnyFn;
        for (const e of entries) {
          if (fn.length <= 1) {
            await fn(e);
          } else {
            await fn(
              e.shelfType ?? 'default',
              Number(e.shelfId) || e.shelfId,
              Number(e.bookId) || e.bookId,
              e.bookHash ?? '',
              e.localPath ?? null,
              !!e.managedByProvider,
            );
          }
        }
      }
    },

    async removeShelfEntries(entries) {
      if (!entries.length) return;
      if (typeof s['removeShelfEntries'] === 'function') {
        await (s['removeShelfEntries'] as AnyFn)(
          entries.map((e) => ({
            ...e,
            shelfType: e.shelfType ?? 'default',
            shelfId: Number(e.shelfId) || e.shelfId,
            bookId: Number(e.bookId) || e.bookId,
          })),
        );
      } else if (typeof s['removeShelfEntry'] === 'function') {
        const fn = s['removeShelfEntry'] as AnyFn;
        for (const e of entries) {
          await fn(
            e.shelfType ?? 'default',
            Number(e.shelfId) || e.shelfId,
            Number(e.bookId) || e.bookId,
          );
        }
      }
    },

    async getManagedShelfReferenceCounts(localPaths, options) {
      const result = new Map<string, number>();
      for (const path of localPaths) result.set(path, 0);
      if (!localPaths.length) return result;

      if (typeof s['getManagedShelfReferenceCounts'] === 'function') {
        return (await (s['getManagedShelfReferenceCounts'] as AnyFn)(localPaths, options)) as Map<
          string,
          number
        >;
      }
      if (typeof s['getManagedShelfEntryReferences'] === 'function') {
        const fn = s['getManagedShelfEntryReferences'] as AnyFn;
        for (const path of localPaths) {
          result.set(path, Number(await fn(path, options)) || 0);
        }
        return result;
      }
      return result;
    },

    async getAllShelfReferenceCounts(localPaths, options) {
      const result = new Map<string, number>();
      for (const path of localPaths) result.set(path, 0);
      if (!localPaths.length) return result;

      if (typeof s['getAllShelfReferenceCounts'] === 'function') {
        return (await (s['getAllShelfReferenceCounts'] as AnyFn)(localPaths, options)) as Map<
          string,
          number
        >;
      }
      if (typeof s['getAllShelfEntryReferences'] === 'function') {
        const fn = s['getAllShelfEntryReferences'] as AnyFn;
        for (const path of localPaths) {
          result.set(path, Number(await fn(path, options)) || 0);
        }
        return result;
      }
      if (typeof s['getManagedShelfReferenceCounts'] === 'function') {
        return (await (s['getManagedShelfReferenceCounts'] as AnyFn)(localPaths, options)) as Map<
          string,
          number
        >;
      }
      if (typeof s['getManagedShelfEntryReferences'] === 'function') {
        const fn = s['getManagedShelfEntryReferences'] as AnyFn;
        for (const path of localPaths) {
          result.set(path, Number(await fn(path, options)) || 0);
        }
        return result;
      }
      return result;
    },
  };
}
