import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookDoc } from '@/libs/document';

const mocks = vi.hoisted(() => ({
  getCFIFromXPointer: vi.fn(),
}));

vi.mock('@/utils/xcfi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/xcfi')>()),
  getCFIFromXPointer: mocks.getCFIFromXPointer,
}));

import { applyRemotePosition, getRemoteChapterLabel } from '@/app/reader/hooks/useGrimmLinkSync';

const bookDoc = {
  toc: [
    { id: 1, label: 'บทนำ', href: 'intro.xhtml', index: 0 },
    { id: 2, label: 'บทที่ 2 — เริ่มต้น', href: 'chapter-2.xhtml', index: 4 },
  ],
} as BookDoc;

const createView = () => ({
  goTo: vi.fn(),
  goToFraction: vi.fn(),
  select: vi.fn(),
});

describe('getRemoteChapterLabel', () => {
  it('maps an Adapter v2 CFI to the local TOC label', () => {
    expect(getRemoteChapterLabel({ cfi: 'epubcfi(/6/10!/4/2/1:0)' }, bookDoc)).toBe(
      'บทที่ 2 — เริ่มต้น',
    );
  });

  it('maps the KOReader XPointer fallback to the local TOC label', () => {
    expect(
      getRemoteChapterLabel({ xpointer: '/body/DocFragment[5]/body/p[3]/text().0' }, bookDoc),
    ).toBe('บทที่ 2 — เริ่มต้น');
  });

  it('maps a legacy XPointer location to the local TOC label', () => {
    expect(
      getRemoteChapterLabel({ location: '/body/DocFragment[5]/body/p[3]/text().0' }, bookDoc),
    ).toBe('บทที่ 2 — เริ่มต้น');
  });

  it('accepts a remote display label when Grimmory provides one', () => {
    expect(getRemoteChapterLabel({ chapterTitle: '  Chapter 41  ' }, bookDoc)).toBe('Chapter 41');
  });

  it('returns no chapter for an unsupported or missing position', () => {
    expect(getRemoteChapterLabel({ progress: '47%' }, bookDoc)).toBeUndefined();
    expect(getRemoteChapterLabel({}, bookDoc)).toBeUndefined();
  });
});

describe('applyRemotePosition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies the remote CFI first and ignores the other locators', async () => {
    const view = createView();
    await applyRemotePosition(
      view,
      {
        cfi: 'epubcfi(/6/10!/4/2/1:0)',
        xpointer: '/body/DocFragment[5]/body/p[3]/text().0',
        currentPage: 12,
        percentage: 0.5,
      },
      { fixedLayout: false },
    );
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/10!/4/2/1:0)');
    expect(mocks.getCFIFromXPointer).not.toHaveBeenCalled();
    expect(view.goToFraction).not.toHaveBeenCalled();
    expect(view.select).not.toHaveBeenCalled();
  });

  it('converts a remote XPointer locally when the adapter sent no CFI', async () => {
    mocks.getCFIFromXPointer.mockResolvedValueOnce('epubcfi(/6/10!/4/2/1:0)');
    const view = createView();
    await applyRemotePosition(
      view,
      { xpointer: '/body/DocFragment[5]/body/p[3]/text().0', percentage: 0.5 },
      { fixedLayout: false },
    );
    expect(mocks.getCFIFromXPointer).toHaveBeenCalledWith(
      '/body/DocFragment[5]/body/p[3]/text().0',
      undefined,
      undefined,
      undefined,
    );
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/10!/4/2/1:0)');
    expect(view.goToFraction).not.toHaveBeenCalled();
  });

  it('falls back to the fraction when the XPointer cannot be converted', async () => {
    mocks.getCFIFromXPointer.mockRejectedValueOnce(new Error('unresolvable pointer'));
    const view = createView();
    await applyRemotePosition(
      view,
      { xpointer: '/body/DocFragment[99]/body/p[3]/text().0', percentage: 0.42 },
      { fixedLayout: false },
    );
    expect(view.goTo).not.toHaveBeenCalled();
    expect(view.goToFraction).toHaveBeenCalledWith(0.42);
  });

  it('accepts a legacy XPointer carried in `progress` only', async () => {
    mocks.getCFIFromXPointer.mockResolvedValueOnce('epubcfi(/6/10!/4/2/1:0)');
    const view = createView();
    await applyRemotePosition(
      view,
      { progress: '/body/DocFragment[5]/body/p[3]/text().0' },
      { fixedLayout: false },
    );
    expect(view.goTo).toHaveBeenCalledWith('epubcfi(/6/10!/4/2/1:0)');
  });

  it('selects the adapter page for a fixed-layout book', async () => {
    const view = createView();
    await applyRemotePosition(view, { currentPage: 12, percentage: 0.5 }, { fixedLayout: true });
    expect(view.select).toHaveBeenCalledWith(11);
    expect(view.goToFraction).not.toHaveBeenCalled();
    expect(view.goTo).not.toHaveBeenCalled();
  });

  it('accepts a legacy fixed-layout page carried in `progress` only', async () => {
    const view = createView();
    await applyRemotePosition(view, { progress: '12' }, { fixedLayout: true });
    expect(view.select).toHaveBeenCalledWith(11);
  });

  it('falls back to the fraction last', async () => {
    const view = createView();
    await applyRemotePosition(view, { percentage: 0.25 }, { fixedLayout: false });
    expect(view.goToFraction).toHaveBeenCalledWith(0.25);
    expect(view.goTo).not.toHaveBeenCalled();
    expect(view.select).not.toHaveBeenCalled();
  });

  it('does not move the reader when the remote position carries nothing usable', async () => {
    const view = createView();
    await applyRemotePosition(view, {}, { fixedLayout: false });
    expect(view.goTo).not.toHaveBeenCalled();
    expect(view.goToFraction).not.toHaveBeenCalled();
    expect(view.select).not.toHaveBeenCalled();
  });
});
