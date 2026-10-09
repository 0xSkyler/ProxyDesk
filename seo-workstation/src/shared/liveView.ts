export const LIVE_VIEWPORT_WIDTH = 390;
export const LIVE_VIEWPORT_HEIGHT = 844;

export interface LiveViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LiveViewPoint {
  x: number;
  y: number;
}

/**
 * Maps a pointer position in the renderer card to Playwright CSS-pixel
 * coordinates. The preview uses object-fit: contain, so clicks in the
 * letterboxed area are ignored instead of being sent to the page.
 */
export function mapLiveViewPoint(
  clientX: number,
  clientY: number,
  rect: LiveViewRect,
  viewportWidth = LIVE_VIEWPORT_WIDTH,
  viewportHeight = LIVE_VIEWPORT_HEIGHT
): LiveViewPoint | undefined {
  if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return undefined;
  const scale = Math.min(rect.width / viewportWidth, rect.height / viewportHeight);
  const renderedWidth = viewportWidth * scale;
  const renderedHeight = viewportHeight * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) return undefined;
  return {
    x: Math.min(viewportWidth - 1, Math.max(0, localX / scale)),
    y: Math.min(viewportHeight - 1, Math.max(0, localY / scale))
  };
}

export function normalizePlaywrightKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key;
}

export function composePlaywrightShortcut(
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
): string {
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push('Control');
  if (modifiers.alt) parts.push('Alt');
  if (modifiers.shift) parts.push('Shift');
  if (modifiers.meta) parts.push('Meta');
  parts.push(normalizePlaywrightKey(key));
  return parts.join('+');
}
