// @vitest-environment node
//
// The NODE environment on purpose, as in react.test.tsx: GameFrame must render on a server, where there is
// no window and no host.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  APP_MESSAGE_SOURCE,
  GAME_MESSAGE_SOURCE,
  GameFrame,
  gamePageUrl,
  parseRoundResult,
  readGameMessage,
} from '../src/game';

const ORIGIN = 'https://app.example';
const OTHER_ORIGIN = 'https://evil.example';
const noop = () => {};

describe('GameFrame', () => {
  it('renders on the server, framing the kit build in practice mode', () => {
    const html = renderToString(<GameFrame title="Cannon" onResult={noop} />);
    expect(html).toContain('src="/game/index.html?mode=practice"');
    expect(html).toContain('title="Cannon"');
    expect(html).toContain('Loading');
  });

  it('loads a paid round with mode=paid', () => {
    expect(renderToString(<GameFrame title="Cannon" mode="paid" onResult={noop} />)).toContain('?mode=paid');
  });

  it('takes a custom loading screen', () => {
    const html = renderToString(<GameFrame title="Cannon" onResult={noop} renderLoading={() => <b>Warming up</b>} />);
    expect(html).toContain('Warming up');
    expect(html).not.toContain('Loading');
  });
});

describe('gamePageUrl', () => {
  it('keeps a query the page already has', () => {
    expect(gamePageUrl('/game/index.html?v=2', 'paid')).toBe('/game/index.html?v=2&mode=paid');
  });
});

describe('readGameMessage', () => {
  const frame = { postMessage: noop } as unknown as MessageEventSource;
  const message = (data: unknown, origin = ORIGIN, source: unknown = frame) =>
    ({ origin, source, data }) as Pick<MessageEvent, 'origin' | 'source' | 'data'>;

  it('reads a message from the game frame on the app origin', () => {
    const event = message({ source: GAME_MESSAGE_SOURCE, type: 'ready', payload: null });
    expect(readGameMessage(event, frame, ORIGIN)).toEqual({ type: 'ready', payload: null });
  });

  it('ignores another origin, another window, and other shapes', () => {
    const data = { source: GAME_MESSAGE_SOURCE, type: 'ready' };
    expect(readGameMessage(message(data, OTHER_ORIGIN), frame, ORIGIN)).toBeNull();
    expect(readGameMessage(message(data, ORIGIN, {}), frame, ORIGIN)).toBeNull();
    expect(readGameMessage(message({ source: APP_MESSAGE_SOURCE, type: 'pause' }), frame, ORIGIN)).toBeNull();
    expect(readGameMessage(message('ready'), frame, ORIGIN)).toBeNull();
  });
});

describe('parseRoundResult', () => {
  it('reads a close payload', () => {
    const payload = { score: 86.7, reason: 'died', seed: 42, configVersion: '0.5.0', secondsPlayed: 17, inputs: 'AQ' };
    expect(parseRoundResult(payload)).toEqual({
      score: 86,
      reason: 'died',
      seed: '42',
      configVersion: '0.5.0',
      secondsPlayed: 17,
      inputs: 'AQ',
      payload,
    });
  });

  // Windy Kicker ends rounds with its own reasons and sends its own fields.
  it("keeps a game's own reason and fields", () => {
    const result = parseRoundResult({ score: 150, reason: 'misses', kicks: 6, replay: true });
    expect(result?.reason).toBe('misses');
    expect(result?.payload.kicks).toBe(6);
  });

  it('refuses a payload without a score or a reason', () => {
    expect(parseRoundResult({ score: 'x', reason: 'died' })).toBeNull();
    expect(parseRoundResult({ score: 3, reason: '' })).toBeNull();
    expect(parseRoundResult({ score: 3 })).toBeNull();
    expect(parseRoundResult(null)).toBeNull();
  });

  it('never reports a negative score', () => {
    expect(parseRoundResult({ score: -5, reason: 'time_up' })?.score).toBe(0);
  });
});
