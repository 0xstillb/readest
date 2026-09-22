import clsx from 'clsx';
import React from 'react';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import type { SyncDetails } from '../hooks/useKOSync';

interface GrimmLinkConflictResolverProps {
  details: SyncDetails | null;
  onResolveWithLocal: () => void;
  onResolveWithRemote: () => void;
  onClose: () => void;
}

const positionLabel = (percentage: number | undefined, fallback: string) =>
  typeof percentage === 'number' && Number.isFinite(percentage)
    ? `${Math.round(Math.max(0, Math.min(100, percentage)))}%`
    : fallback;

const pageLabel = (currentPage: number | undefined, totalPages: number | undefined) =>
  currentPage != null && totalPages != null && totalPages > 0
    ? `Page ${currentPage} / ${totalPages}`
    : null;

/** GrimmLink conflict UI intentionally never exposes CFI/XPointer/hash identifiers. */
const GrimmLinkConflictResolver: React.FC<GrimmLinkConflictResolverProps> = ({
  details,
  onResolveWithLocal,
  onResolveWithRemote,
  onClose,
}) => {
  const _ = useTranslation();
  if (!details) return null;
  const remoteDevice = details.remote.device || _('another device');
  return (
    <Dialog isOpen={true} onClose={onClose} title={_('Reading progress differs')}>
      <p className='text-base-content/70 mb-5 mt-1 px-1 text-center text-sm leading-relaxed'>
        {_('Choose which reading position should be kept in Grimmory.')}
      </p>
      <div className='flex flex-col gap-2.5'>
        <button
          type='button'
          onClick={onResolveWithLocal}
          className={clsx(
            'eink-bordered flex w-full items-start rounded-xl border px-4 py-3.5 text-left',
            'border-base-200 bg-base-100 hover:bg-base-200/60',
          )}
        >
          <span className='flex min-w-0 flex-1 flex-col gap-1'>
            <span className='font-medium'>{_('Continue from this device')}</span>
            <span className='text-sm opacity-70'>
              {[
                details.local.device,
                pageLabel(details.local.currentPage, details.local.totalPages) ??
                  positionLabel(
                    details.local.percentage == null ? undefined : details.local.percentage * 100,
                    _('Current position'),
                  ),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </button>
        <button
          type='button'
          onClick={onResolveWithRemote}
          className={clsx(
            'btn btn-primary h-auto min-h-0 w-full justify-start rounded-xl px-4 py-3.5 text-left font-normal normal-case',
          )}
        >
          <span className='flex min-w-0 flex-1 flex-col items-start gap-1'>
            <span className='font-medium'>{_('Continue from Grimmory')}</span>
            <span className='text-sm opacity-80'>{`${remoteDevice} · ${pageLabel(details.remote.currentPage, details.remote.totalPages) ?? positionLabel(details.remote.percentage == null ? undefined : details.remote.percentage * 100, _('Remote position'))}${details.remote.updatedAt ? ` · ${new Date(details.remote.updatedAt).toLocaleString()}` : ''}`}</span>
          </span>
        </button>
      </div>
    </Dialog>
  );
};

export default GrimmLinkConflictResolver;
