import clsx from 'clsx';
import React from 'react';
import Dialog from '@/components/Dialog';
import { SectionTitle } from '@/components/settings/primitives';
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
    ? `Page ${currentPage + 1} / ${totalPages}`
    : null;

const timeLabel = (value: string | number | undefined) => {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const positionSummary = (details: SyncDetails, side: 'local' | 'remote', fallback: string) => {
  const position = details[side];
  const chapter = position.chapter?.trim();
  const page = pageLabel(position.currentPage, position.totalPages);
  const percentage = positionLabel(
    position.percentage == null ? undefined : position.percentage * 100,
    fallback,
  );
  return [chapter || page, percentage].filter(Boolean).join(' · ') || fallback;
};

/** GrimmLink conflict UI never exposes CFI/XPointer/hash identifiers. */
const GrimmLinkConflictResolver: React.FC<GrimmLinkConflictResolverProps> = ({
  details,
  onResolveWithLocal,
  onResolveWithRemote,
  onClose,
}) => {
  const _ = useTranslation();
  if (!details) return null;

  const localDevice = details.local.device || _('this device');
  const remoteDevice = details.remote.device || _('another device');
  const localSummary = positionSummary(details, 'local', _('Current position'));
  const remoteSummary = positionSummary(details, 'remote', _('Remote position'));
  const localTime = timeLabel(details.local.updatedAt);
  const remoteTime = timeLabel(details.remote.updatedAt);

  return (
    <Dialog isOpen={true} onClose={onClose} title={_('Reading progress conflict')}>
      <p className='text-base-content/70 mb-5 mt-1 px-1 text-center text-sm leading-relaxed'>
        {_('Choose the position you want to continue from.')}
      </p>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div
          role='group'
          className={clsx(
            'eink-bordered group flex min-h-28 w-full flex-col items-start rounded-xl border px-4 py-3.5 text-left',
            'border-base-300 bg-base-100 hover:bg-base-200/60',
            'focus-visible:ring-base-content/20 focus-visible:outline-hidden focus-visible:ring-2',
          )}
        >
          <SectionTitle as='span' className='ps-0! text-base-content/60!'>
            {_('This device')}
          </SectionTitle>
          <span className='mt-1 line-clamp-1 font-medium'>{localDevice}</span>
          <span className='mt-1 line-clamp-2 text-sm font-semibold'>{localSummary}</span>
          {localTime && <span className='mt-auto pt-1 text-xs opacity-60'>{localTime}</span>}
        </div>
        <div
          role='group'
          className={clsx(
            'btn btn-primary group flex min-h-28 w-full flex-col items-start justify-start rounded-xl px-4 py-3.5 text-left font-normal normal-case',
            'focus-visible:ring-primary/40 focus-visible:outline-hidden focus-visible:ring-2',
          )}
        >
          <SectionTitle as='span' className='ps-0! text-current! opacity-75'>
            {_('Grimmory')}
          </SectionTitle>
          <span className='mt-1 line-clamp-1 font-medium'>{remoteDevice}</span>
          <span className='mt-1 line-clamp-2 text-sm font-semibold'>{remoteSummary}</span>
          {remoteTime && <span className='mt-auto pt-1 text-xs opacity-75'>{remoteTime}</span>}
        </div>
      </div>
      <div className='mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end'>
        <button
          type='button'
          onClick={onResolveWithLocal}
          className='btn btn-outline min-h-11 flex-1 sm:flex-none'
        >
          {_('Continue here')}
        </button>
        <button
          type='button'
          onClick={onResolveWithRemote}
          className='btn btn-primary min-h-11 flex-1 sm:flex-none'
        >
          {_('Use Grimmory position')}
        </button>
      </div>
    </Dialog>
  );
};

export default GrimmLinkConflictResolver;
