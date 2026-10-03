// The bridge: window.bankroll for a page in a simulator.
//
// On a phone the Bankroll app puts window.bankroll on the page before the
// page's own code runs. Every method of it is thin: it passes the call to the
// app, which does the work and passes the answer back. A page in a browser on
// a computer has no such host, and the simulator drawn around it cannot put one
// there, since a page may not reach into a frame from another origin. So the
// SDK does it from inside: when the page is on this computer and sits in a
// frame, it installs a window.bankroll of the same shape, whose methods send
// each call to the parent page as a window message and wait for the answer.
// The simulator answers as the phone would.
//
// What crosses the frame, on the `simulator` channel:
//
//   page      -> simulator ready    a bridge is on the page, and which SDK
//   simulator -> page      hello    I am here, as this Bankroll app, around this phone
//   page      -> simulator call     a call, by the phone's name for it, with its input
//   simulator -> page      result   the same call's answer, or the reason it was refused
//   page      -> simulator refused  a call the SDK refused before asking, for the record
//
// Trust. Both the page and the parent have to be local. A deployed app is never
// on a local origin, so it never installs this, whatever frames it. The parent
// is believed only once it has said hello from a local origin, and from then
// on every message is addressed to that origin alone and taken from it alone.
// What a simulator can do with that is answer the page's own questions: the
// page holds no keys, and the app's server checks every session and payment
// for itself.
//
// The safe area. A simulator draws a phone around the page: a status bar
// across the top, a home indicator across the bottom. On a phone the page
// learns how far those reach from env(safe-area-inset-*). A browser on a
// computer answers zero, and nothing outside the page can change that. So
// hello carries the phone's safe area, and the bridge puts it on the page as
// --bankroll-safe-area-inset-top, -right, -bottom and -left, for the page's
// CSS to prefer to the phone's own:
//
//   padding-top: var(--bankroll-safe-area-inset-top, env(safe-area-inset-top));
//
// Said again, it replaces what was said before: the simulator shows another
// phone. Everywhere else the variables are not set, and the phone's own value
// is the one used.
import type { Json } from './matchmaking';

declare const __SDK_VERSION__: string | undefined;
const SDK_VERSION = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : 'unknown';

/** What marks a window message as one of these. */
export const SIMULATOR_CHANNEL = 'simulator';
// The CSS variables a simulated phone's safe area is put in: this, then the side.
export const SAFE_AREA_VARIABLE = '--bankroll-safe-area-inset-';
// Calls made before a simulator says hello are kept for it, up to a point.
const UNSENT_LIMIT = 200;
// How long the first calls wait for a simulator to say hello before they are
// refused: a local page in a frame that nobody is simulating.
export const HELLO_PATIENCE_MS = 5_000;
export const NO_SIMULATOR = 'no simulator answered this page: is it open in `bankroll dev --simulator`?';
// The Bankroll app the bridge stands for until the simulator says which one it
// imitates: the phone's BANKROLL_CLIENT_VERSION at the time of writing.
const PRESUMED_HOST_VERSION = '5';

/** An origin on this computer: the only kind a bridge is installed on, or listens to. */
export const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/;

/**
 * The phone's name for each call, which is what crosses the frame, so the
 * simulator hears exactly what the Bankroll app hears.
 */
export const HOST_FEATURES = {
  init: 'bankroll:init',
  session: 'bankroll:session',
  identity: 'bankroll:identity',
  pay: 'bankroll:pay',
  balances: 'bankroll:balances',
  deposit: 'bankroll:deposit',
  haptics: 'bankroll:haptics',
  requestAmount: 'bankroll:requestAmount',
  quote: 'bankroll:quote',
  promptReview: 'bankroll:promptReview',
} as const;
export type HostMethod = keyof typeof HOST_FEATURES;

/** How far a phone's status bar, home indicator and corners reach into its screen from each edge, in CSS pixels. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The messages a bridge and a simulator exchange. */
export type SimulatorMessage = { bankroll: typeof SIMULATOR_CHANNEL } & (
  | { type: 'ready'; sdk: string }
  | { type: 'hello'; version?: string; safeArea?: SafeAreaInsets }
  | { type: 'call'; id: number; feature: string; input?: Json; at: number }
  | { type: 'result'; id: number; ok: true; value?: Json }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'refused'; feature: string; reason: string; at: number }
);

/** The window as the bridge sees it: enough to be stood in for by a test. */
export interface BridgePage {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  location: { origin: string; ancestorOrigins?: ArrayLike<string> };
  addEventListener(type: 'message', listener: (event: { source: unknown; origin: string; data: unknown }) => void): void;
  document?: { adoptedStyleSheets?: { replaceSync(text: string): void }[] };
  CSSStyleSheet?: new () => { replaceSync(text: string): void };
  bankroll?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

// A message crosses to another page as a copy, and only plain data copies.
const plain = (value: unknown): Json | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Whether this page is framed by a page on this computer: yes, no, or
 * unknown, when the browser does not say who the parent is.
 */
function framedLocally(page: BridgePage): boolean | undefined {
  if (!page.parent || page.parent === (page as unknown)) return false;
  const ancestors = page.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) return LOCAL_ORIGIN.test(ancestors[0] ?? '');
  return undefined;
}

/**
 * Puts the simulated phone's safe area where the page's CSS can read it: in a
 * stylesheet of the bridge's own. Written on the root element they would be
 * attributes the page's framework never rendered, and React says so when it
 * hydrates. Each side is a length and nothing else, whatever was sent.
 */
function safeAreaWriter(page: BridgePage): (insets: unknown) => void {
  let sheet: { replaceSync(text: string): void } | null = null;
  return (insets) => {
    const document = page.document;
    if (!isRecord(insets) || !document?.adoptedStyleSheets || !page.CSSStyleSheet) return;
    const sides = (['top', 'right', 'bottom', 'left'] as const).filter((side) => {
      const value = insets[side];
      return typeof value === 'number' && value >= 0 && value < Infinity;
    });
    sheet ??= new page.CSSStyleSheet();
    sheet.replaceSync(`:root{${sides.map((side) => `${SAFE_AREA_VARIABLE}${side}:${insets[side] as number}px`).join(';')}}`);
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  };
}

let attempted: BridgePage | null = null;

/**
 * Installs the bridge on a page that has no host of its own, is on this
 * computer, and sits in a frame: once per page, and only then. True when a
 * bridge is on the page after this, whether or not this call put it there.
 */
export function installBridge(page: BridgePage | undefined = typeof window === 'undefined' ? undefined : (window as unknown as BridgePage)): boolean {
  if (!page) return false;
  if (page.bankroll) return true;
  if (attempted === page) return false;
  attempted = page;
  if (!LOCAL_ORIGIN.test(page.location.origin)) return false;
  // Unknown counts as yes: Firefox does not say, and the parent still has to
  // say hello from a local origin before anything is believed.
  if (framedLocally(page) === false) return false;
  const parent = page.parent!;

  const pending = new Map<number, Pending>();
  const unsent: SimulatorMessage[] = [];
  let simulator: string | null = null;
  let patience: ReturnType<typeof setTimeout> | null = null;
  let calls = 0;
  const showSafeArea = safeAreaWriter(page);

  const send = (message: SimulatorMessage) => {
    if (simulator) parent.postMessage(message, simulator);
    else if (unsent.length < UNSENT_LIMIT) unsent.push(message);
  };
  // Nobody has said hello: the calls waiting are refused, and the next ones
  // start the wait again, so a simulator that comes late is still heard.
  const giveUp = () => {
    patience = null;
    unsent.length = 0;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.reject(new Error(NO_SIMULATOR));
    }
  };
  const settle = (id: number, outcome: { ok: true; value: unknown } | { ok: false; error: string }) => {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (outcome.ok) waiting.resolve(outcome.value);
    else waiting.reject(new Error(outcome.error));
  };

  page.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !isRecord(data) || data.bankroll !== SIMULATOR_CHANNEL) return;
    if (data.type === 'hello') {
      if (!LOCAL_ORIGIN.test(event.origin)) return;
      if (simulator !== null && event.origin !== simulator) return;
      simulator = event.origin;
      if (patience !== null) clearTimeout(patience);
      patience = null;
      if (typeof data.version === 'string' && data.version !== '') bridge.version = data.version;
      showSafeArea(data.safeArea);
      while (unsent.length) parent.postMessage(unsent.shift(), simulator);
      return;
    }
    if (event.origin !== simulator) return;
    if (data.type === 'result' && typeof data.id === 'number') {
      settle(data.id, data.ok === true ? { ok: true, value: data.value } : { ok: false, error: typeof data.error === 'string' ? data.error : 'refused' });
    }
  });

  const call = (feature: string) => (input?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++calls;
      pending.set(id, { resolve, reject });
      const copy = plain(input);
      send({ bankroll: SIMULATOR_CHANNEL, type: 'call', id, feature, ...(copy === undefined ? {} : { input: copy }), at: Date.now() });
      if (simulator === null && patience === null) patience = setTimeout(giveUp, HELLO_PATIENCE_MS);
    });

  const bridge = {
    version: PRESUMED_HOST_VERSION,
    init: call(HOST_FEATURES.init),
    session: call(HOST_FEATURES.session),
    identity: call(HOST_FEATURES.identity),
    pay: call(HOST_FEATURES.pay),
    balances: call(HOST_FEATURES.balances),
    deposit: call(HOST_FEATURES.deposit),
    haptics: call(HOST_FEATURES.haptics),
    requestAmount: call(HOST_FEATURES.requestAmount),
    quote: call(HOST_FEATURES.quote),
    promptReview: call(HOST_FEATURES.promptReview),
    // A call the SDK refused before it asked, one made before init(): the
    // simulator hears of it as a call that failed, so it shows where the
    // call would have.
    refused: (method: string, reason: string) => {
      const feature = (HOST_FEATURES as Record<string, string>)[method] ?? method;
      send({ bankroll: SIMULATOR_CHANNEL, type: 'refused', feature, reason: String(reason), at: Date.now() });
    },
  };
  page.bankroll = bridge;
  // To any parent, because its origin is not known yet: this says a bridge is
  // here, and nothing else.
  parent.postMessage({ bankroll: SIMULATOR_CHANNEL, type: 'ready', sdk: SDK_VERSION } satisfies SimulatorMessage, '*');
  return true;
}

/** Forgets which page was tried, for tests that stand in a new one. */
export function resetBridge(): void {
  attempted = null;
}
