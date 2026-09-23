import { describe, expect, it } from 'vitest';
import type { BookDoc } from '@/libs/document';
import { getRemoteChapterLabel } from '@/app/reader/hooks/useGrimmLinkSync';

const bookDoc = {
  toc: [
    { id: 1, label: 'บทนำ', href: 'intro.xhtml', index: 0 },
    { id: 2, label: 'บทที่ 2 — เริ่มต้น', href: 'chapter-2.xhtml', index: 4 },
  ],
} as BookDoc;

describe('getRemoteChapterLabel', () => {
  it('maps Grimmory XPointer DocFragment to the local TOC label', () => {
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
