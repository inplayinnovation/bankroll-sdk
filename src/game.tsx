'use client';

// The web half of the Bankroll game kit: the frame a Unity game runs in, inside a Bankroll app. The game is
// the kit's web build (public/game/, written by BankrollWebBuild in unity/com.joinbankroll.gamekit), and its
// page template (WebGLTemplates~/Bankroll) is the other end of these messages.
//
// The 'use client' directive above MUST be the first line of this file, and this file must be listed in
// tsup's `entry` array: a directive on a bundled non-entry module is silently dropped (see react.tsx and
// scripts/verify-build.mjs).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

import { bankroll, type HapticType } from './index';

/** The source every message from the game carries. */
export const GAME_MESSAGE_SOURCE = 'bankroll-game';
/** The source every message to the game carries. */
export const APP_MESSAGE_SOURCE = 'bankroll-app';
/** Where the kit's web build lands in a Bankroll app. */
export const DEFAULT_GAME_PAGE = '/game/index.html';
/** The page's colour before the game draws, the same default as the kit's BANKROLL_BACKGROUND. */
export const DEFAULT_GAME_BACKGROUND = '#000000';

/**
 * How a round ends in the kit's own round flow (RoundController). pause_ran_out: a paid round used up its
 * pause allowance; the score so far counts. A game with its own flow sends its own reasons.
 */
export type RoundEndReason = 'time_up' | 'died' | 'pause_ran_out';

/** Practice pauses freely; a paid round gives its pauses an allowance. The game reads it from its address. */
export type RoundMode = 'practice' | 'paid';

/** What the game hands back when the player taps to continue. */
export interface RoundResult {
  score: number;
  /** How the round ended, in the game's words: the kit's RoundEndReason, or the game's own. */
  reason: string;
  seed: string;
  configVersion: string;
  secondsPlayed: number;
  /** Every tick's input, encoded (InputLog in @joinbankroll/sdk/game-core). With the seed, it replays the round. */
  inputs: string;
  /** The whole close message, for the game's own fields (kicks made, a replay flag, and so on). */
  payload: Record<string, unknown>;
}

/** One message from the game: loading, ready, haptics, close, error, or a game's own. */
export interface GameMessage {
  type: string;
  payload: Record<string, unknown> | null;
}

const ROUND_END_REASONS: ReadonlySet<string> = new Set<RoundEndReason>(['time_up', 'died', 'pause_ran_out']);
const HAPTIC_TYPES: ReadonlySet<string> = new Set<HapticType>([
  'selection',
  'light',
  'medium',
  'heavy',
  'success',
  'warning',
  'error',
]);
const MODE_PARAM = 'mode';
// The player's reduced-motion setting, sent to every game on ready and whenever it changes.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const DEFAULT_MODE: RoundMode = 'practice';
const FAILED_TO_START = 'The game could not start.';
const LOADING_TEXT = 'Loading';
const TRY_AGAIN_TEXT = 'Try again';
const PERCENT = 100;

export function isRoundEndReason(value: unknown): value is RoundEndReason {
  return typeof value === 'string' && ROUND_END_REASONS.has(value);
}

/** The round's result from a close message, or null when it has no score or no reason. */
export function parseRoundResult(payload: Record<string, unknown> | null): RoundResult | null {
  if (!payload) return null;
  const score = Number(payload.score);
  const { reason } = payload;
  if (!Number.isFinite(score) || typeof reason !== 'string' || reason === '') return null;
  return {
    score: Math.max(0, Math.floor(score)),
    reason,
    seed: String(payload.seed ?? ''),
    configVersion: String(payload.configVersion ?? ''),
    secondsPlayed: Number(payload.secondsPlayed) || 0,
    inputs: typeof payload.inputs === 'string' ? payload.inputs : '',
    payload,
  };
}

/** Sends one message to the game in a frame, on the page's own origin. For an app's own messages. */
export function postToGame(frame: HTMLIFrameElement | null | undefined, type: string, payload: unknown = null): void {
  frame?.contentWindow?.postMessage({ source: APP_MESSAGE_SOURCE, type, payload }, window.location.origin);
}

/**
 * The game's message in a window message event, or null when the event is anything else: another origin,
 * another window than the game's frame, or not the kit's shape.
 */
export function readGameMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  frame: MessageEventSource | null | undefined,
  origin: string,
): GameMessage | null {
  if (event.origin !== origin || !frame || event.source !== frame) return null;
  const data = event.data as { source?: unknown; type?: unknown; payload?: unknown } | null;
  if (!data || data.source !== GAME_MESSAGE_SOURCE || typeof data.type !== 'string') return null;
  const payload = typeof data.payload === 'object' && data.payload !== null ? (data.payload as Record<string, unknown>) : null;
  return { type: data.type, payload };
}

/** The game page's address with the round's mode, keeping any query the page already has. */
export function gamePageUrl(src: string, mode: RoundMode): string {
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}${MODE_PARAM}=${mode}`;
}

export interface GameFrameProps {
  /** Called once per round, when the player taps to continue. A game that replays in place sends ready again. */
  onResult: (result: RoundResult) => void;
  /** The frame's accessible name: the game's name. */
  title: string;
  mode?: RoundMode;
  /** The game page. Default: public/game/index.html, where the kit's web build lands. */
  src?: string;
  /** The colour behind the game while it loads. Match the game's BANKROLL_BACKGROUND. */
  background?: string;
  /** Every message from the game, before the frame handles it. For development tools such as a relay. */
  onMessage?: (message: GameMessage) => void;
  /** The iframe, for development tools that read the page (its bankrollBridge.diagnostics()). */
  frameRef?: RefObject<HTMLIFrameElement | null>;
  /** Replaces the loading bar. progress runs from 0 to 1. */
  renderLoading?: (progress: number) => ReactNode;
  /** Replaces the error screen. */
  renderError?: (message: string) => ReactNode;
}

const layer: CSSProperties = { position: 'absolute', inset: 0 };
const frameStyle: CSSProperties = { ...layer, width: '100%', height: '100%', border: 0 };
const centered: CSSProperties = {
  ...layer,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  padding: '0 32px',
  fontFamily: 'system-ui, sans-serif',
};
const track: CSSProperties = {
  width: 192,
  height: 6,
  overflow: 'hidden',
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.15)',
};
const caption: CSSProperties = { margin: 0, fontSize: 12, color: 'rgba(255, 255, 255, 0.6)', textAlign: 'center' };
const button: CSSProperties = {
  padding: '10px 20px',
  border: 0,
  borderRadius: 999,
  background: '#ffffff',
  color: '#000000',
  fontSize: 14,
  fontWeight: 600,
};
// Measures the device's safe-area insets in CSS pixels, which an iframe cannot read itself.
const probeStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
  padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
};

/**
 * The frame a Unity game built with the Bankroll game kit runs in. It shows loading progress, plays the
 * game's haptics through Bankroll, sends the safe-area insets and the reduced-motion setting, and hands back
 * the round's result once per round. The game's page pauses the round itself when the app is hidden. It
 * fills its positioned parent.
 */
export function GameFrame({
  onResult,
  title,
  mode = DEFAULT_MODE,
  src = DEFAULT_GAME_PAGE,
  background = DEFAULT_GAME_BACKGROUND,
  onMessage,
  frameRef,
  renderLoading,
  renderError,
}: GameFrameProps) {
  const ownFrame = useRef<HTMLIFrameElement | null>(null);
  const frame = frameRef ?? ownFrame;
  const probe = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One result per round: a duplicate close is ignored until the game says ready again.
  const resulted = useRef(false);

  const sendSafeArea = useCallback(() => {
    const element = probe.current;
    if (!element) return;
    const style = getComputedStyle(element);
    postToGame(frame.current, 'safe_area', {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    });
  }, [frame]);

  const sendPreferences = useCallback(() => {
    postToGame(frame.current, 'preferences', { reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches });
  }, [frame]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const message = readGameMessage(event, frame.current?.contentWindow, window.location.origin);
      if (!message) return;
      onMessage?.(message);
      const { payload } = message;
      switch (message.type) {
        case 'loading': {
          const value = Number(payload?.progress);
          if (Number.isFinite(value)) setProgress(Math.min(1, Math.max(0, value)));
          break;
        }
        case 'ready':
          resulted.current = false;
          setReady(true);
          sendSafeArea();
          sendPreferences();
          break;
        case 'haptics': {
          const type = payload?.type;
          // Decoration only: the SDK call never rejects, and does nothing outside Bankroll.
          if (typeof type === 'string' && HAPTIC_TYPES.has(type)) void bankroll.haptics({ type: type as HapticType });
          break;
        }
        case 'close': {
          const result = parseRoundResult(payload);
          if (result && !resulted.current) {
            resulted.current = true;
            onResult(result);
          }
          break;
        }
        case 'error':
          setFailure(typeof payload?.message === 'string' ? payload.message : FAILED_TO_START);
          break;
      }
    };
    const motion = window.matchMedia(REDUCED_MOTION_QUERY);
    window.addEventListener('message', receive);
    window.addEventListener('resize', sendSafeArea);
    motion.addEventListener('change', sendPreferences);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('resize', sendSafeArea);
      motion.removeEventListener('change', sendPreferences);
    };
  }, [frame, onMessage, onResult, sendPreferences, sendSafeArea]);

  return (
    <div style={{ ...layer, background }}>
      <iframe ref={frame} src={gamePageUrl(src, mode)} title={title} allow="autoplay" style={frameStyle} />
      {!ready && (
        <div style={{ ...centered, background }}>
          {failure
            ? (renderError?.(failure) ?? (
                <>
                  <p style={{ ...caption, fontSize: 14, color: 'rgba(255, 255, 255, 0.8)' }}>{failure}</p>
                  <button type="button" style={button} onClick={() => window.location.reload()}>
                    {TRY_AGAIN_TEXT}
                  </button>
                </>
              ))
            : (renderLoading?.(progress) ?? (
                <>
                  <div style={track}>
                    <div
                      style={{
                        width: `${Math.round(progress * PERCENT)}%`,
                        height: '100%',
                        borderRadius: 999,
                        background: '#ffffff',
                        transition: 'width 200ms',
                      }}
                    />
                  </div>
                  <p style={caption}>{LOADING_TEXT}</p>
                </>
              ))}
        </div>
      )}
      <div ref={probe} aria-hidden style={probeStyle} />
    </div>
  );
}
