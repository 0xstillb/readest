import { useCallback, useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useDeviceControlStore } from '@/store/deviceStore';
import { eventDispatcher } from '@/utils/event';
import { isPencilNativeKey, normalizeDomKeyEvent, resolvePageTurn } from '@/utils/keybinding';

/** Wheel pixels that make one page turn; a trackpad flick adds up to this. */
const WHEEL_PAGE_THRESHOLD = 50;
const TOUCH_PAGE_THRESHOLD = 24;

export function useLibraryPagination(
  scroller: HTMLElement | null,
  enabled: boolean,
  onPageTurn?: (direction: number) => void,
) {
  const { appService } = useEnv();
  const hardware = useSettingsStore((s) => s.settings.hardwarePageTurner);
  const volumeKeys = useSettingsStore((s) => !!s.settings.globalViewSettings?.volumeKeysToFlip);

  const turnPage = useCallback(
    (direction: number) => {
      if (!scroller) return;
      if (onPageTurn) {
        onPageTurn(direction);
        return;
      }
      const viewport = scroller.getBoundingClientRect();
      const top = scroller.scrollTop;
      const height = scroller.clientHeight;
      const anchors: { top: number; bottom: number }[] = [];
      let headingTop: number | undefined;
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-page-row]')) {
        const bounds = row.getBoundingClientRect();
        const rowTop = bounds.top - viewport.top + top;
        if (row.dataset['pageRow'] === 'heading' || row.dataset['pageRow'] === 'divider') {
          headingTop ??= rowTop;
        } else {
          anchors.push({ top: headingTop ?? rowTop, bottom: bounds.bottom - viewport.top + top });
          headingTop = undefined;
        }
      }
      // Repeat a partly visible row on the next page. Group headings/dividers
      // with their first row rather than leaving a heading alone at the bottom.
      const target =
        direction > 0
          ? anchors.find((row) => row.bottom > top + height + 1)
          : anchors.find((row) => row.top >= top - height - 1 && row.top < top - 1);
      // A single oversized row (for example a large-cover carousel) still needs
      // to be traversable. Never skip its middle or get stuck on its heading.
      const next =
        target && (direction > 0 ? target.top > top + 1 : target.top < top - 1)
          ? target.top
          : top + direction * height;
      scroller.scrollTo({ top: Math.max(0, next), behavior: 'instant' });
    },
    [onPageTurn, scroller],
  );

  useEffect(() => {
    if (!enabled || !scroller) return;
    const blocked = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : document.activeElement;
      return (
        (element instanceof HTMLElement &&
          !!element.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )) ||
        Array.from(
          document.querySelectorAll<HTMLElement>(
            'dialog[open], [role="dialog"], [role="menu"], [data-capture-blocking-overlay="true"], [data-shortcut-recording="true"]',
          ),
        ).some((el) => el.getClientRects().length > 0)
      );
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || blocked(event.target)) return;
      const action = hardware && resolvePageTurn(hardware, normalizeDomKeyEvent(event));
      let direction = action === 'pagePrev' ? -1 : action === 'pageNext' ? 1 : 0;
      if (!action && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey)
        direction = event.key === 'PageUp' ? -1 : event.key === 'PageDown' ? 1 : 0;
      if (!direction) return;
      // Preserve native activation of focused controls even if Enter/Space is bound.
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        event.target instanceof HTMLElement &&
        event.target.closest('button, a, [role="button"]')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) turnPage(direction);
    };
    const onNativeKey = (event: CustomEvent) => {
      if (blocked(document.activeElement)) return;
      const keyName = event.detail?.keyName;
      if (volumeKeys && (keyName === 'VolumeUp' || keyName === 'VolumeDown')) {
        turnPage(keyName === 'VolumeUp' ? -1 : 1);
        return;
      }
      if (!hardware) return;
      const action = resolvePageTurn(hardware, { source: 'native', id: keyName });
      if (action === 'pagePrev' || action === 'pageNext') turnPage(action === 'pagePrev' ? -1 : 1);
    };
    const nativeBindings = hardware?.enabled
      ? [hardware.bindings.pagePrev, hardware.bindings.pageNext].filter(
          (b) => b?.source === 'native',
        )
      : [];
    const device = useDeviceControlStore.getState();
    const intercept =
      appService?.isMobileApp && nativeBindings.some((b) => b && !isPencilNativeKey(b.id));
    if (intercept) device.acquirePageTurnerKeyInterception();
    if (appService?.isMobileApp && nativeBindings.length) device.ensureKeyForwarding();
    const interceptVolume = appService?.isMobileApp && volumeKeys;
    if (interceptVolume) device.acquireVolumeKeyInterception();
    window.addEventListener('keydown', onKey, true);
    eventDispatcher.on('native-key-down', onNativeKey);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      eventDispatcher.off('native-key-down', onNativeKey);
      if (intercept) device.releasePageTurnerKeyInterception();
      if (interceptVolume) device.releaseVolumeKeyInterception();
    };
  }, [enabled, scroller, hardware, volumeKeys, appService, turnPage]);

  useEffect(() => {
    if (!enabled || !scroller) return;
    // An e-ink panel redraws every pixel of movement, so a free scroll would
    // flash the library instead of turning a page. The pointer joins the keys:
    // a wheel tick or a vertical drag turns one page and the list never
    // scrolls under the finger.
    let wheelDelta = 0;
    let startX = 0;
    let startY = 0;
    let turned = false;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      // Firefox reports a mouse notch as three lines, so a line is worth more
      // than a pixel here: one notch has to turn exactly one page.
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? window.innerHeight : 1;
      wheelDelta += event.deltaY * unit;
      if (Math.abs(wheelDelta) < WHEEL_PAGE_THRESHOLD) return;
      const direction = wheelDelta > 0 ? 1 : -1;
      wheelDelta = 0;
      turnPage(direction);
    };
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      startX = touch?.clientX ?? 0;
      startY = touch?.clientY ?? 0;
      turned = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!event.touches) return;
      // A second finger turns the gesture into a pinch, which is not a page
      // turn.
      if (event.touches.length > 1) {
        turned = true;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // Ignore tap jitter until the finger has clearly committed to a drag.
      if (Math.abs(dy) < TOUCH_PAGE_THRESHOLD) return;
      // A horizontal drag belongs to the carousel that took it.
      if (Math.abs(dx) > Math.abs(dy)) return;
      // At the very top a downward drag is the pull-to-refresh gesture, and
      // there is no page above the first one to turn to.
      if (!onPageTurn && dy > 0 && scroller.scrollTop <= 0) return;
      event.preventDefault();
      if (turned) return;
      turned = true;
      turnPage(dy < 0 ? 1 : -1);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, [enabled, scroller, turnPage]);

  return turnPage;
}
