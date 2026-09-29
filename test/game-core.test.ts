import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Fix, InputLog, InputLogFormatError, SeededRandom } from '../src/game-core';

// The test data the Unity kit's C# writes and checks (SharedVectorsTests.cs). The TypeScript copy must give
// exactly the same numbers, so a change on one side that forgets the other fails here or in Unity.
const VECTORS_URL = new URL('../unity/com.joinbankroll.gamekit/Tests/Vectors~/core.json', import.meta.url);
const VECTORS_FORMAT = 1;
// The same constants SharedVectorsTests.cs replays its generators with.
const SMALL_BOUND = 6;
const UINT32_MAX = 2 ** 32 - 1;
const RANGE_MIN = -5;
const RANGE_MAX = 17;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const RANGE_FIX_MIN = -2.5;
const RANGE_FIX_MAX = 7.25;

interface RandomCase {
  seed: string;
  stream: string;
  uints: number[];
  below: number[];
  belowWide: number[];
  range: number[];
  rangeWide: number[];
  fix: number[];
  rangeFix: number[];
}

interface Vectors {
  format: number;
  fix: {
    fromDouble: [string, number][];
    roundToInt: [number, number][];
    mul: [number, number, number][];
    mulInt: [number, number, number][];
    divInt: [number, number, number][];
    lerp: [number, number, number, number][];
  };
  random: RandomCase[];
  derive: [string, string, string][];
  inputLog: { valid: { codes: number[]; text: string }[]; invalid: string[] };
}

const vectors = JSON.parse(readFileSync(VECTORS_URL, 'utf8')) as Vectors;

function doubleFromBits(bits: string): number {
  const view = new DataView(new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT));
  view.setBigUint64(0, BigInt(bits));
  return view.getFloat64(0);
}

function repeat<T>(count: number, next: () => T): T[] {
  return Array.from({ length: count }, next);
}

describe('game-core against the Unity kit', () => {
  it('reads the format it knows', () => {
    expect(vectors.format).toBe(VECTORS_FORMAT);
  });

  it('Fix.fromDouble matches, halves away from zero', () => {
    for (const [bits, raw] of vectors.fix.fromDouble) {
      expect(Fix.fromDouble(doubleFromBits(bits)).raw).toBe(raw);
    }
  });

  it('Fix.roundToInt matches', () => {
    for (const [raw, rounded] of vectors.fix.roundToInt) expect(Fix.fromRaw(raw).roundToInt()).toBe(rounded);
  });

  it('Fix products round down, past 2^53 too', () => {
    for (const [a, b, raw] of vectors.fix.mul) expect(Fix.fromRaw(a).mul(Fix.fromRaw(b)).raw).toBe(raw);
    for (const [a, b, raw] of vectors.fix.mulInt) expect(Fix.fromRaw(a).mulInt(b).raw).toBe(raw);
  });

  it('Fix quotients truncate toward zero', () => {
    for (const [a, b, raw] of vectors.fix.divInt) expect(Fix.fromRaw(a).divInt(b).raw).toBe(raw);
  });

  it('Fix.lerp matches', () => {
    for (const [a, b, t, raw] of vectors.fix.lerp) {
      expect(Fix.lerp(Fix.fromRaw(a), Fix.fromRaw(b), Fix.fromRaw(t)).raw).toBe(raw);
    }
  });

  it('SeededRandom gives the same sequences, call for call', () => {
    for (const c of vectors.random) {
      const random = new SeededRandom(BigInt(c.seed), BigInt(c.stream));
      const min = Fix.fromDouble(RANGE_FIX_MIN);
      const max = Fix.fromDouble(RANGE_FIX_MAX);
      expect(repeat(c.uints.length, () => random.nextUInt())).toEqual(c.uints);
      expect(repeat(c.below.length, () => random.nextUIntBelow(SMALL_BOUND))).toEqual(c.below);
      expect(repeat(c.belowWide.length, () => random.nextUIntBelow(UINT32_MAX))).toEqual(c.belowWide);
      expect(repeat(c.range.length, () => random.range(RANGE_MIN, RANGE_MAX))).toEqual(c.range);
      expect(repeat(c.rangeWide.length, () => random.range(INT32_MIN, INT32_MAX))).toEqual(c.rangeWide);
      expect(repeat(c.fix.length, () => random.nextFix().raw)).toEqual(c.fix);
      expect(repeat(c.rangeFix.length, () => random.rangeFix(min, max).raw)).toEqual(c.rangeFix);
    }
  });

  it('SeededRandom.derive matches', () => {
    for (const [seed, salt, derived] of vectors.derive) {
      expect(SeededRandom.derive(BigInt(seed), BigInt(salt))).toBe(BigInt(derived));
    }
  });

  it('InputLog encodes to the same text and decodes back', () => {
    for (const { codes, text } of vectors.inputLog.valid) {
      const log = new InputLog();
      for (const code of codes) log.add(code);
      expect(log.encode()).toBe(text);
      expect(InputLog.decode(text).codes).toEqual(codes);
    }
  });

  it('InputLog refuses what the kit refuses', () => {
    for (const text of vectors.inputLog.invalid) {
      expect(() => InputLog.decode(text), text).toThrow(InputLogFormatError);
    }
  });
});

describe('game-core guards', () => {
  it('Fix refuses a step count JavaScript cannot hold exactly', () => {
    expect(() => Fix.fromRaw(2 ** 53)).toThrow(RangeError);
    expect(() => Fix.fromRaw(0.5)).toThrow(RangeError);
  });

  it('InputLog refuses an input outside 32 bits', () => {
    expect(() => new InputLog().add(INT32_MAX + 1)).toThrow(RangeError);
    expect(() => new InputLog().add(1.5)).toThrow(RangeError);
  });
});
