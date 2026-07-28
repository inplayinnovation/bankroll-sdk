// @vitest-environment node
//
// Deliberately the NODE environment: the guarantee worth testing is that these
// render on a server, where there is no window and no host. A jsdom run would
// silently pass whether or not that held.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DevTools, useBankrollStatus, type DevRow } from '../src/react';

const ROWS: DevRow[] = [
  { label: 'Treasury', value: 'Trea5uryAddre55', ok: true, copy: true },
  { label: 'RPC', value: 'https://api.mainnet-beta.solana.com', display: 'mainnet-beta', ok: false },
];

describe('useBankrollStatus', () => {
  // Server and client must agree on 'unavailable', or a phone already inside
  // Bankroll sees "open this in Bankroll" until hydration corrects it.
  it("is 'unavailable' during a server render", () => {
    function Probe() {
      return <span>{useBankrollStatus()}</span>;
    }
    expect(renderToString(<Probe />)).toContain('unavailable');
  });
});

describe('DevTools', () => {
  it('renders on the server without a window', () => {
    expect(renderToString(<DevTools rows={ROWS} />)).toContain('Bankroll developer tools');
  });

  // Collapsed by default: it overlays a running app, so it must not cover it
  // until asked for.
  it('does not render the panel until opened', () => {
    const html = renderToString(<DevTools rows={ROWS} />);
    expect(html).not.toContain('Treasury');
    expect(html).toContain('aria-expanded="false"');
  });

  // Inline styles rather than utility classes — scanners ignore node_modules,
  // so a class-based overlay would ship with no styles at all.
  it('carries its own styles rather than depending on the app CSS', () => {
    const html = renderToString(<DevTools rows={ROWS} />);
    expect(html).toContain('style=');
    expect(html).not.toContain('class=');
  });

  it('renders no rows without crashing', () => {
    expect(() => renderToString(<DevTools rows={[]} />)).not.toThrow();
  });
});
