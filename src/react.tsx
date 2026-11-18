'use client';

// Client-side helpers for a Built-for-Bankroll app.
//
// The 'use client' directive above MUST be the first line of this file, and this
// file must be listed in tsup's `entry` array. A directive on a bundled
// non-entry module is silently dropped — esbuild emits no warning — and the
// result ships as a server component that throws on import.
//
// Everything here is either fiddly host glue that behaves identically in every
// app, or the development overlay, which is never seen by a real user. An app's
// own product surface stays in the app.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { BankrollError, bankroll, withBankrollToken, type BankrollStatus } from './index';

// ---------------------------------------------------------------------------
// Host glue
// ---------------------------------------------------------------------------

/**
 * `fetch` with the Bankroll session token attached to every request.
 *
 * Bound because fetch throws when called detached from the window, and resolved
 * to the bare global on the server so importing this module never crashes a
 * render that does not use it.
 */
export const bankrollFetch = withBankrollToken(
  typeof window === 'undefined' ? fetch : fetch.bind(window),
);

// The host is injected before the page loads and never changes afterwards, so
// there is nothing to subscribe to. On the server there is no host, which is
// the same answer a plain browser tab gets — so server and client agree and a
// gate always renders something rather than blanking.
const neverChanges = () => () => {};
const unavailableOnServer = (): BankrollStatus => 'unavailable';

/**
 * Host status: 'ready' inside a current Bankroll app, 'update_required' inside
 * one too old for this SDK, 'unavailable' anywhere else — including during the
 * server render.
 *
 * Server and client deliberately agree on 'unavailable' so a status-dependent
 * screen does not flash the wrong thing before hydration corrects it.
 */
export function useBankrollStatus(): BankrollStatus {
  return useSyncExternalStore(neverChanges, bankroll.status, unavailableOnServer);
}

/**
 * Whether the host has been asked yet. False during the server render and the
 * first client paint — render a loading state rather than deciding on it, or a
 * phone already inside Bankroll sees "open this in Bankroll" until hydration.
 */
export function useBankrollChecked(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
}

/**
 * Send the user through identity verification — real money moves only for a
 * verified person. Resolves true once verified, false if they declined or the
 * host refused. Anything that is not a host rejection propagates.
 */
export async function verifyIdentity(): Promise<boolean> {
  try {
    await bankroll.session({ identity: true });
    return true;
  } catch (error) {
    if (error instanceof BankrollError) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Development overlay
// ---------------------------------------------------------------------------

export interface DevRow {
  label: string;
  /** The full value — what gets copied. */
  value: string;
  ok: boolean;
  /** Shown instead of `value` when the full thing is too long to read here. */
  display?: string;
  /** Offer a copy button; the full `value` is what lands on the clipboard. */
  copy?: boolean;
}

const COPIED_FEEDBACK_MS = 1200;

// Addresses are shown short because the panel is narrow on a phone, which is
// only safe because the copy button hands over the full value — a truncated
// address you cannot copy is useless.
const TRUNCATE_EDGE = 4;
const truncate = (value: string) =>
  value.length > TRUNCATE_EDGE * 2 + 1
    ? `${value.slice(0, TRUNCATE_EDGE)}…${value.slice(-TRUNCATE_EDGE)}`
    : value;

// Next's own indicator sits bottom-left by default, so this takes bottom-right.
// Two dev badges stacked in a phone-sized viewport is clutter, so Next's is
// hidden until asked for. It cannot be turned off in next.config without losing
// it for good, so it is hidden by CSS instead — which keeps it one tap away.
//
// This reaches into Next's overlay, which is internal and may be renamed. If the
// shape ever changes the failure is Next's badge staying visible, not anything
// breaking — and in an app that is not Next at all, every query below simply
// finds nothing.
const NEXT_PORTAL = 'nextjs-portal';
// The badge ROOT, not the button inside it: hiding only the button leaves its
// container drawing an empty sliver at the edge of the screen. Still narrower
// than the portal, so the error overlay is untouched.
const NEXT_INDICATOR = '[data-next-badge-root]';
const HIDE_STYLE_ID = 'bankroll-hides-next-indicator';

function useNextIndicatorHidden(hidden: boolean) {
  useEffect(() => {
    const apply = () => {
      const root = document.querySelector(NEXT_PORTAL)?.shadowRoot;
      if (!root) return false;
      const existing = root.getElementById(HIDE_STYLE_ID);
      if (!hidden) {
        existing?.remove();
        return true;
      }
      if (existing) return true;
      const style = document.createElement('style');
      style.id = HIDE_STYLE_ID;
      style.textContent = `${NEXT_INDICATOR}{display:none!important}`;
      root.append(style);
      return true;
    };

    // The overlay mounts on its own schedule, so watch for it rather than
    // assuming it is there on first render.
    if (apply()) return;
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [hidden]);
}

// Inline styles rather than utility classes: Tailwind and every scanner like it
// ignore node_modules, so a class-based overlay would ship with no styles at
// all. Inline keeps this correct in an app using any CSS framework or none.
const BANKROLL_GREEN = '#97F04A';
const BANKROLL_BLACK = '#131416';
const SURFACE = '#0a0a0a';
const BORDER = '#262626';
const BORDER_SUBTLE = '#171717';
const TEXT = '#d4d4d4';
const TEXT_DIM = '#737373';
const TEXT_WARN = '#fbbf24';
const BADGE_SIZE = 44;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const styles = {
  root: {
    alignItems: 'flex-end',
    bottom: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    position: 'fixed',
    right: 12,
    zIndex: 2147483000,
  },
  panel: {
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 16,
    boxShadow: '0 8px 24px rgba(0,0,0,.5)',
    margin: 0,
    overflow: 'hidden',
    width: 'min(21rem, calc(100vw - 1.5rem))',
  },
  row: {
    alignItems: 'center',
    borderBottom: `1px solid ${BORDER_SUBTLE}`,
    display: 'flex',
    gap: 12,
    paddingLeft: 12,
    paddingRight: 4,
  },
  label: {
    color: TEXT_DIM,
    flexShrink: 0,
    fontSize: 12,
    margin: 0,
    paddingBottom: 12,
    paddingTop: 12,
    width: 64,
  },
  value: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 12,
    margin: 0,
    minWidth: 0,
    overflow: 'hidden',
    paddingBottom: 12,
    paddingTop: 12,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  button: {
    alignItems: 'center',
    background: 'none',
    border: 0,
    color: TEXT_DIM,
    cursor: 'pointer',
    display: 'flex',
    flexShrink: 0,
    fontSize: 12,
    height: 44,
    justifyContent: 'center',
    padding: 0,
    width: 56,
  },
  footer: {
    alignItems: 'center',
    background: 'none',
    border: 0,
    borderTop: `1px solid ${BORDER}`,
    color: TEXT_DIM,
    cursor: 'pointer',
    display: 'flex',
    fontSize: 12,
    gap: 8,
    height: 44,
    padding: '0 12px',
    textAlign: 'left',
    width: '100%',
  },
  badge: {
    background: 'none',
    border: 0,
    borderRadius: '50%',
    boxShadow: '0 4px 12px rgba(0,0,0,.5)',
    cursor: 'pointer',
    height: BADGE_SIZE,
    overflow: 'hidden',
    padding: 0,
    width: BADGE_SIZE,
  },
} as const satisfies Record<string, React.CSSProperties>;

/**
 * A floating panel reporting how this app is configured, for development.
 *
 * Render it only when you mean to — it carries addresses and endpoints, so gate
 * it on your own development check rather than shipping it to users.
 */
export function DevTools({ rows }: { rows: DevRow[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showNext, setShowNext] = useState(false);

  useNextIndicatorHidden(!showNext);

  const copyValue = useCallback(async (row: DevRow) => {
    await navigator.clipboard.writeText(row.value);
    setCopied(row.label);
    setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
  }, []);

  return (
    <div style={styles.root}>
      {open && (
        <dl style={styles.panel}>
          {rows.map((row) => (
            <div key={row.label} style={styles.row}>
              <dt style={styles.label}>{row.label}</dt>
              <dd style={{ ...styles.value, color: row.ok ? TEXT : TEXT_WARN }}>
                {row.display ?? (row.copy ? truncate(row.value) : row.value)}
              </dd>
              {row.copy && (
                <button
                  aria-label={`Copy ${row.label}`}
                  onClick={() => copyValue(row)}
                  style={styles.button}
                  type="button"
                >
                  {copied === row.label ? 'copied' : 'copy'}
                </button>
              )}
            </div>
          ))}

          {/* A footer, not a row — it is a control rather than a fact. */}
          <button onClick={() => setShowNext((shown) => !shown)} style={styles.footer} type="button">
            <span style={{ flex: 1 }}>Next dev tools</span>
            <span>{showNext ? 'hide' : 'show'}</span>
          </button>
        </dl>
      )}

      <button
        aria-expanded={open}
        aria-label="Bankroll developer tools"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        style={styles.badge}
        type="button"
      >
        <BankrollMark />
      </button>
    </div>
  );
}

// The Bankroll icon. Inlined rather than served as a file so the badge costs no
// request and cannot 404 in an app that has replaced everything it serves.
function BankrollMark() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      style={{ display: 'block', height: '100%', width: '100%' }}
      viewBox="0 0 1024 1024"
    >
      <rect fill={BANKROLL_GREEN} height="1024" width="1024" />
      <path
        d="M206.844 382.294C201.407 382.294 197 377.887 197 372.45L197 206.843C197 201.407 201.407 197 206.844 197L738.213 197C787.249 197 827 238.479 827 289.647C827 340.815 787.249 382.294 738.213 382.294H206.844Z"
        fill={BANKROLL_BLACK}
      />
      <path
        clipRule="evenodd"
        d="M197 817.156C197 822.593 201.407 827 206.844 827H694.978C767.89 827 826.998 773.479 826.998 707.457L827 524.076C827.001 458.053 767.894 404.531 694.982 404.53H206.844C201.407 404.53 197 408.937 197 414.374L197 817.156ZM526.616 621.324C522.992 621.324 520.054 624.262 520.054 627.886V725.938C520.054 729.562 522.992 732.5 526.616 732.5H669.5C687.622 732.5 702.313 717.855 702.313 699.733C702.313 688.694 702.313 673.937 702.313 654.208C702.313 636.087 687.622 621.324 669.5 621.324H526.616Z"
        fill={BANKROLL_BLACK}
        fillRule="evenodd"
      />
    </svg>
  );
}
