import { describe, expect, it } from 'vitest';
import { pickFreeHighPort } from './settings';
import { createTabletDevProxy } from './tablet-dev-proxy';

describe('tablet dev proxy', () => {
  it('returns 503 when the upstream dev server is unavailable', async () => {
    const port = await pickFreeHighPort();
    const proxy = createTabletDevProxy(`http://127.0.0.1:${port}`);

    const response = await proxy.fetch(new Request('http://127.0.0.1/src/App.tsx'));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    await expect(response.text()).resolves.toContain('Tablet dev server unavailable.');
  });
});