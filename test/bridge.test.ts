// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BridgePage,
  HELLO_PATIENCE_MS,
  HOST_FEATURES,
  installBridge,
  NO_SIMULATOR,
  resetBridge,
  SIMULATOR_CHANNEL,
} from '../src/bridge';

type Host = Record<string, (input?: unknown) => Promise<unknown>> & { version: string; refused(method: string, reason: string): void };

const SIMULATOR = 'http://localhost:4100';
const APP = 'http://localhost:3000';
const HELLO = { bankroll: SIMULATOR_CHANNEL, type: 'hello' };
const result = (id: number, value?: unknown) => ({ bankroll: SIMULATOR_CHANNEL, type: 'result', id, ok: true, value });
const refusal = (id: number, error: string) => ({ bankroll: SIMULATOR_CHANNEL, type: 'result', id, ok: false, error });

// A page in a frame: a parent that records what it is posted, a way to deliver
// a message as that parent or as someone else, and whatever else the page has.
function framed(origin = APP, extra: Partial<BridgePage> = {}) {
  const posts: { message: Record<string, unknown>; to: string }[] = [];
  const parent = { postMessage: (message: Record<string, unknown>, to: string) => posts.push({ message, to }) };
  let listener: (event: { source: unknown; origin: string; data: unknown }) => void = () => {};
  const page: BridgePage = {
    parent,
    location: { origin },
    addEventListener: (_type, handler) => {
      listener = handler;
    },
    ...extra,
  };
  const installed = installBridge(page);
  const hear = (from: string, data: unknown, source: unknown = parent) => listener({ source, origin: from, data });
  return { installed, page, host: page.bankroll as Host, posts, hear, parent };
}

// As much of a page's stylesheets as the bridge uses: a document that adopts
// them, and a sheet that keeps the text it was last given.
function stylesheets() {
  const made: { text: string }[] = [];
  class CSSStyleSheet {
    text = '';
    constructor() {
      made.push(this);
    }
    replaceSync(text: string) {
      this.text = text;
    }
  }
  const document = { adoptedStyleSheets: [] as { replaceSync(text: string): void }[] };
  return { made, document, extra: { document, CSSStyleSheet } };
}

afterEach(() => {
  resetBridge();
  vi.useRealTimers();
});

describe('installBridge: where a bridge goes', () => {
  it('goes on a local page in a frame, and says it is there', () => {
    const { installed, host, posts } = framed();
    expect(installed).toBe(true);
    expect(host.version).toBe('5');
    expect(posts).toEqual([{ message: { bankroll: SIMULATOR_CHANNEL, type: 'ready', sdk: expect.any(String) }, to: '*' }]);
    for (const method of Object.keys(HOST_FEATURES)) expect(typeof host[method]).toBe('function');
  });

  // A test, a plain tab and a phone all run the app as the top window.
  it('not on a page that is the top window', () => {
    const page: BridgePage = { parent: null, location: { origin: APP }, addEventListener: () => {} };
    page.parent = page as unknown as BridgePage['parent'];
    expect(installBridge(page)).toBe(false);
    expect(page.bankroll).toBeUndefined();
  });

  it('not on a deployed app, whoever frames it', () => {
    const { installed, page } = framed('https://game.example');
    expect(installed).toBe(false);
    expect(page.bankroll).toBeUndefined();
  });

  it('not when the browser says the parent is not on this computer', () => {
    const { installed, page } = framed(APP, { location: { origin: APP, ancestorOrigins: ['https://evil.example'] } });
    expect(installed).toBe(false);
    expect(page.bankroll).toBeUndefined();
    resetBridge();
    expect(framed(APP, { location: { origin: APP, ancestorOrigins: [SIMULATOR] } }).installed).toBe(true);
  });

  it('leaves a host that is already there, and says so', () => {
    const theirs = { version: '5' };
    const { installed, page, posts } = framed(APP, { bankroll: theirs });
    expect(installed).toBe(true);
    expect(page.bankroll).toBe(theirs);
    expect(posts).toEqual([]);
  });

  it('is tried once per page', () => {
    const { page, posts } = framed();
    expect(installBridge(page)).toBe(true);
    delete page.bankroll;
    expect(installBridge(page)).toBe(false);
    expect(posts).toHaveLength(1);
  });
});

describe('installBridge: a call across the frame', () => {
  it("keeps calls until a page on this computer says hello, then sends them there by the phone's names", async () => {
    const { host, posts, hear } = framed();
    const paying = host.pay!({ amountCents: 500, memo: 'one game' });
    void host.balances!();
    expect(posts).toHaveLength(1);

    // Somebody else's page framing the app, and a local page that is not the parent.
    hear('https://simulator.example', HELLO);
    hear(SIMULATOR, HELLO, {});
    expect(posts).toHaveLength(1);

    hear(SIMULATOR, HELLO);
    expect(posts.slice(1)).toEqual([
      { message: { bankroll: SIMULATOR_CHANNEL, type: 'call', id: 1, feature: 'bankroll:pay', input: { amountCents: 500, memo: 'one game' }, at: expect.any(Number) }, to: SIMULATOR },
      { message: { bankroll: SIMULATOR_CHANNEL, type: 'call', id: 2, feature: 'bankroll:balances', at: expect.any(Number) }, to: SIMULATOR },
    ]);
    hear(SIMULATOR, result(1, 'sig'));
    await expect(paying).resolves.toBe('sig');
  });

  it('answers each call with what the simulator said, and only the simulator', async () => {
    const { host, hear } = framed();
    hear(SIMULATOR, HELLO);
    const balances = host.balances!();
    const paying = host.pay!({ amountCents: 1 });
    // Answers from anyone else, and for calls that were never made.
    hear('https://simulator.example', result(1, { cashCents: 0 }));
    hear(SIMULATOR, result(1, { cashCents: 0 }), {});
    hear(SIMULATOR, result(99, 'nothing'));
    hear(SIMULATOR, result(1, { cashCents: 12_00, creditsCents: 0, tokens: {} }));
    hear(SIMULATOR, refusal(2, 'insufficient_funds'));
    await expect(balances).resolves.toEqual({ cashCents: 12_00, creditsCents: 0, tokens: {} });
    await expect(paying).rejects.toThrow('insufficient_funds');
    // Answered once: a second answer finds nothing waiting.
    hear(SIMULATOR, result(1, 'again'));
  });

  it('takes the version of the Bankroll app the simulator imitates', () => {
    const { host, hear } = framed();
    hear(SIMULATOR, { ...HELLO, version: '4' });
    expect(host.version).toBe('4');
    hear(SIMULATOR, { ...HELLO, version: '' });
    expect(host.version).toBe('4');
  });

  it('keeps to the first simulator that said hello', () => {
    const { posts, hear, host } = framed();
    hear(SIMULATOR, HELLO);
    hear('http://localhost:4200', HELLO);
    void host.haptics!();
    expect(posts.at(-1)?.to).toBe(SIMULATOR);
  });

  it('refuses the calls waiting when nobody says hello in time, and tries again for the next', async () => {
    vi.useFakeTimers();
    const { host, hear, posts } = framed();
    const first = host.session!();
    vi.advanceTimersByTime(HELLO_PATIENCE_MS);
    await expect(first).rejects.toThrow(NO_SIMULATOR);

    const second = host.session!();
    hear(SIMULATOR, HELLO);
    // Only the second was kept for the simulator.
    expect(posts.filter((post) => post.message.type === 'call').map((post) => post.message.id)).toEqual([2]);
    hear(SIMULATOR, result(2, 'token'));
    await expect(second).resolves.toBe('token');
  });

  it('tells the simulator of a call the SDK refused, by the phone\'s name for it', () => {
    const { host, hear, posts } = framed();
    hear(SIMULATOR, HELLO);
    host.refused('pay', 'bankroll.init() has not been called.');
    host.refused('somethingNew', 'no');
    expect(posts.slice(1)).toEqual([
      { message: { bankroll: SIMULATOR_CHANNEL, type: 'refused', feature: 'bankroll:pay', reason: 'bankroll.init() has not been called.', at: expect.any(Number) }, to: SIMULATOR },
      { message: { bankroll: SIMULATOR_CHANNEL, type: 'refused', feature: 'somethingNew', reason: 'no', at: expect.any(Number) }, to: SIMULATOR },
    ]);
  });

  it('sends only plain data, however a call was made', () => {
    const { host, hear, posts } = framed();
    hear(SIMULATOR, HELLO);
    void host.pay!({ amountCents: 1, when: new Date(0), nothing: undefined });
    expect(posts.at(-1)?.message.input).toEqual({ amountCents: 1, when: '1970-01-01T00:00:00.000Z' });
  });
});

describe('installBridge: the safe area of the simulated phone', () => {
  const PHONE = { top: 62, right: 0, bottom: 34, left: 0 };

  it("puts it where the page's CSS can read it, in a stylesheet of its own", () => {
    const { made, document, extra } = stylesheets();
    const { hear } = framed(APP, extra);
    expect(document.adoptedStyleSheets).toEqual([]);

    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    expect(document.adoptedStyleSheets).toEqual([made[0]]);
    expect(made[0]!.text).toBe(
      ':root{--bankroll-safe-area-inset-top:62px;--bankroll-safe-area-inset-right:0px;--bankroll-safe-area-inset-bottom:34px;--bankroll-safe-area-inset-left:0px}',
    );
  });

  it('takes another phone in place of the last, in the same stylesheet', () => {
    const { made, document, extra } = stylesheets();
    const { hear } = framed(APP, extra);
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    hear(SIMULATOR, { ...HELLO, safeArea: { ...PHONE, top: 47 } });
    expect(made).toHaveLength(1);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(made[0]!.text).toContain('--bankroll-safe-area-inset-top:47px');
    expect(made[0]!.text).not.toContain('62px');

    // A hello that says nothing of a phone leaves the last one standing.
    hear(SIMULATOR, HELLO);
    expect(made[0]!.text).toContain('--bankroll-safe-area-inset-top:47px');
  });

  it("keeps its stylesheet beside the page's own, and puts it back if the page drops it", () => {
    const { made, document, extra } = stylesheets();
    const theirs = { text: "the page's own", replaceSync() {} };
    document.adoptedStyleSheets = [theirs];
    const { hear } = framed(APP, extra);
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    expect(document.adoptedStyleSheets).toEqual([theirs, made[0]]);

    document.adoptedStyleSheets = [];
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    expect(document.adoptedStyleSheets).toEqual([made[0]]);
  });

  it('takes it only with a hello it takes, and only as lengths', () => {
    // Somebody else's page framing the app, and a local page that is not the parent.
    const refused = stylesheets();
    const stranger = framed(APP, refused.extra);
    stranger.hear('https://simulator.example', { ...HELLO, safeArea: PHONE });
    stranger.hear(SIMULATOR, { ...HELLO, safeArea: PHONE }, {});
    expect(refused.made).toEqual([]);
    resetBridge();

    // Anything that is not a length from an edge is left out: it would be CSS of the sender's choosing.
    const { made, extra } = stylesheets();
    const { hear } = framed(APP, extra);
    hear(SIMULATOR, { ...HELLO, safeArea: { top: '62px;color:red', right: -1, bottom: Infinity, left: 3.5 } });
    expect(made[0]!.text).toBe(':root{--bankroll-safe-area-inset-left:3.5px}');
    hear(SIMULATOR, { ...HELLO, safeArea: { top: Number.NaN } });
    expect(made[0]!.text).toBe(':root{}');
    hear(SIMULATOR, { ...HELLO, safeArea: 'tall' });
    expect(made[0]!.text).toBe(':root{}');
  });

  it('still answers calls where a page cannot adopt a stylesheet', async () => {
    const { host, hear } = framed();
    hear(SIMULATOR, { ...HELLO, safeArea: PHONE });
    const depositing = host.deposit!();
    hear(SIMULATOR, result(1));
    await expect(depositing).resolves.toBeUndefined();
  });
});
