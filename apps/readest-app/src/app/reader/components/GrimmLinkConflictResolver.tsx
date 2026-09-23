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
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

const timestamp = (value: string | number | undefined) => {
  if (value == null) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
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
  const localTimestamp = timestamp(details.local.updatedAt);
  const remoteTimestamp = timestamp(details.remote.updatedAt);
  const newerSide =
    localTimestamp != null && remoteTimestamp != null && localTimestamp !== remoteTimestamp
      ? localTimestamp > remoteTimestamp
        ? 'local'
        : 'remote'
      : null;

  return (
    <Dialog isOpen={true} onClose={onClose} title={_('Reading progress conflict')}>
      <p className='text-base-content/70 mb-5 mt-1 px-1 text-center text-sm leading-relaxed'>
        {_('Readest found two different reading positions. Nothing changes until you choose.')}
      </p>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='eink-bordered border-base-300 bg-base-100 flex min-h-32 w-full flex-col rounded-xl border px-4 py-3.5'>
          <div className='flex items-center justify-between gap-2'>
            <SectionTitle as='span' className='ps-0!'>
              {_('This device')}
            </SectionTitle>
            {newerSide === 'local' && (
              <span className='badge badge-outline badge-sm'>{_('Newer')}</span>
            )}
          </div>
          <span className='text-base-content/65 mt-1 line-clamp-1 text-xs'>{localDevice}</span>
          <span className='mt-2 line-clamp-2 text-base font-semibold'>{localSummary}</span>
          {localTime && (
            <span className='text-base-content/65 mt-auto pt-2 text-xs'>{localTime}</span>
          )}
        </div>
        <div className='eink-bordered border-base-300 bg-base-100 flex min-h-32 w-full flex-col rounded-xl border px-4 py-3.5'>
          <div className='flex items-center justify-between gap-2'>
            <SectionTitle as='span' className='ps-0!'>
              {_('Grimmory')}
            </SectionTitle>
            {newerSide === 'remote' && (
              <span className='badge badge-outline badge-sm'>{_('Newer')}</span>
            )}
          </div>
          <span className='text-base-content/65 mt-1 line-clamp-1 text-xs'>{remoteDevice}</span>
          <span className='mt-2 line-clamp-2 text-base font-semibold'>{remoteSummary}</span>
          {remoteTime && (
            <span className='text-base-content/65 mt-auto pt-2 text-xs'>{remoteTime}</span>
          )}
        </div>
      </div>
      <div className='mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end'>
        <button
          type='button'
          onClick={onResolveWithLocal}
          className='btn btn-ghost eink-bordered min-h-11 flex-1 sm:flex-none'
        >
          {_('Continue here')}
        </button>
        <button
          type='button'
          onClick={onResolveWithRemote}
          className='btn btn-contrast min-h-11 flex-1 sm:flex-none'
        >
          {_('Use Grimmory position')}
        </button>
      </div>
    </Dialog>
  );
};

export default GrimmLinkConflictResolver;
