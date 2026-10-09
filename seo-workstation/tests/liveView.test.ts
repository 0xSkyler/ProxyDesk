import { describe, expect, it } from 'vitest';
import { composePlaywrightShortcut, mapLiveViewPoint } from '../src/shared/liveView';

describe('interactive live view coordinate mapping', () => {
  it('maps the center of a contained 390x844 viewport back to its center', () => {
    const point = mapLiveViewPoint(195, 422, { left: 0, top: 0, width: 390, height: 844 });
    expect(point?.x).toBeCloseTo(195, 4);
    expect(point?.y).toBeCloseTo(422, 4);
  });

  it('accounts for side letterboxing in a wide browser card', () => {
    const point = mapLiveViewPoint(300, 177.5, { left: 0, top: 0, width: 600, height: 355 });
    expect(point?.x).toBeCloseTo(195, 1);
    expect(point?.y).toBeCloseTo(422, 1);
    expect(mapLiveViewPoint(10, 177.5, { left: 0, top: 0, width: 600, height: 355 })).toBeUndefined();
  });

  it('builds Playwright-compatible keyboard shortcuts', () => {
    expect(composePlaywrightShortcut('a', { ctrl: true })).toBe('Control+a');
    expect(composePlaywrightShortcut('ArrowLeft', { ctrl: true, shift: true })).toBe('Control+Shift+ArrowLeft');
  });
});
