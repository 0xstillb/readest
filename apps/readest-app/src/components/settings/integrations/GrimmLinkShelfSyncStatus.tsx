import React from 'react';
import { MdCheckCircle, MdClose, MdErrorOutline, MdSync } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import type { GrimmLinkShelfSyncStatus as ShelfSyncStatus } from '@/hooks/useGrimmLinkShelfSync';

interface GrimmLinkShelfSyncStatusProps {
  syncing: boolean;
  status: ShelfSyncStatus | null;
  onCancel?: () => void;
  compact?: boolean;
}

const GrimmLinkShelfSyncStatus: React.FC<GrimmLinkShelfSyncStatusProps> = ({
  syncing,
  status,
  onCancel,
  compact = false,
}) => {
  const _ = useTranslation();
  if (!status) return null;

  const percent =
    status.stage === 'downloading' && status.total && status.total > 0
      ? Math.max(0, Math.min(100, Math.round(((status.progress ?? 0) / status.total) * 100)))
      : null;
  const title = (() => {
    const book = status.book ? ` ${status.book}` : '';
    switch (status.stage) {
      case 'starting':
        return _('Preparing shelf sync…');
      case 'downloading':
        return `${_('Downloading')}${book}…`;
      case 'importing':
        return `${_('Importing')}${book}…`;
      case 'done':
        return status.message || _('Shelf sync complete');
      case 'error':
        return status.message || _('Shelf sync failed');
      case 'info':
        return status.message || _('Shelf sync status');
      default:
        return _('Shelf sync');
    }
  })();
  const tone =
    status.stage === 'error' ? 'text-error' : status.stage === 'done' ? 'text-success' : '';
  const icon =
    status.stage === 'done' ? (
      <MdCheckCircle aria-hidden='true' className='text-success shrink-0' />
    ) : status.stage === 'error' ? (
      <MdErrorOutline aria-hidden='true' className='text-error shrink-0' />
    ) : (
      <MdSync aria-hidden='true' className={`shrink-0 ${syncing ? 'animate-spin' : ''}`} />
    );

  return (
    <div
      role='status'
      aria-live='polite'
      className={`eink-bordered border-base-200 bg-base-100 min-w-0 max-w-full overflow-hidden rounded-lg border ${compact ? 'w-80 max-w-[90vw] px-2.5 py-2' : 'w-full px-3 py-2.5'}`}
    >
      <div className='flex w-full min-w-0 items-center gap-2 overflow-hidden'>
        {icon}
        <span className={`w-0 min-w-0 flex-1 truncate text-xs font-medium ${tone}`}>{title}</span>
        {percent !== null && <span className='shrink-0 text-xs tabular-nums'>{percent}%</span>}
        {syncing && onCancel && (
          <button
            type='button'
            className='btn btn-ghost btn-xs shrink-0 gap-1'
            onClick={onCancel}
            aria-label={_('Cancel shelf sync')}
          >
            <MdClose aria-hidden='true' />
            {!compact && _('Cancel')}
          </button>
        )}
      </div>
      {syncing && status.stage === 'downloading' && (
        <progress
          className='progress mt-2 h-1.5 w-full'
          value={percent ?? undefined}
          max='100'
          aria-label={_('Shelf sync progress')}
        />
      )}
      {syncing && status.stage === 'importing' && (
        <progress
          className='progress progress-accent mt-2 h-1.5 w-full'
          aria-label={_('Importing book')}
        />
      )}
    </div>
  );
};

export default GrimmLinkShelfSyncStatus;
