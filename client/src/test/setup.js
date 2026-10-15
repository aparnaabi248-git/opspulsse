import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { tokenStore } from '../api/client';

/**
 * Frontend test setup.
 *
 * Tests run in jsdom with no backend, so every network call is intercepted by
 * the individual test file. Nothing here pretends an API succeeded unless the
 * test explicitly says so.
 */

// jsdom does not implement these; several components call them
beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  // Recharts measures its container; jsdom reports 0x0 which breaks layout maths
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);

  window.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  tokenStore.set(null);
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});