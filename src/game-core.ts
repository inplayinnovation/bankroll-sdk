// The rules half of the Bankroll game kit, in TypeScript: exact copies of the Unity kit's Fix,
// SeededRandom and InputLog (unity/com.joinbankroll.gamekit/Runtime/Core). A server replays a round
// with these and the game's own rules, from the seed and the input log the game sent, and computes the
// score itself. A copy that differs by one bit from the C# gives a different score, so every operation
// here follows the C# exactly, and both sides check the same test data
// (unity/com.joinbankroll.gamekit/Tests/Vectors~/core.json).
//
// No React and no Node APIs: this runs on a server and in a browser alike.

// ---------------------------------------------------------------------------
// Fix: fixed-point numbers
// ---------------------------------------------------------------------------

/** Fraction bits of a Fix: a value is a whole count of 2^-20 steps. */
export const FIX_FRACTION_BITS = 20;
const FRACTION_BITS_N = BigInt(FIX_FRACTION_BITS);
const ONE_RAW = 2 ** FIX_FRACTION_BITS;
const HALF_RAW_N = BigInt(ONE_RAW / 2);
// Digits Fix.toString shows, as the C# format "0.######" does.
const TO_STRING_DECIMALS = 6;

function checkedRaw(raw: number): number {
  if (!Number.isSafeInteger(raw)) {
    throw new RangeError(`A Fix must hold a whole number of steps within 2^53, not ${raw}.`);
  }
  // -0 and 0 are the same count of steps.
  return raw === 0 ? 0 : raw;
}

/**
 * A fixed-point number, the C# kit's Fix: a whole count of 2^-20 steps. Operations match the C# bit for
 * bit: a product rounds down (toward negative infinity), and a quotient by a whole number truncates toward
 * zero. Products and quotients go through BigInt, so they stay exact past 2^53.
 */
export class Fix {
  static readonly ZERO = new Fix(0);
  static readonly ONE = new Fix(ONE_RAW);

  /** The underlying count of 2^-20 steps. */
  readonly raw: number;

  private constructor(raw: number) {
    this.raw = checkedRaw(raw);
  }

  static fromRaw(raw: number): Fix {
    return new Fix(raw);
  }

  static fromInt(value: number): Fix {
    if (!Number.isInteger(value)) throw new RangeError(`Fix.fromInt takes a whole number, not ${value}.`);
    return new Fix(value * ONE_RAW);
  }

  /**
   * The nearest step to a settings value, halves away from zero, as the C# FromDouble. Use it when a
   * round starts, never inside a tick.
   */
  static fromDouble(value: number): Fix {
    const scaled = value * ONE_RAW;
    return new Fix(scaled < 0 ? -Math.round(-scaled) : Math.round(scaled));
  }

  toDouble(): number {
    return this.raw / ONE_RAW;
  }

  /** The nearest whole number, with halves rounded away from zero. */
  roundToInt(): number {
    const raw = BigInt(this.raw);
    // Negated as a bigint, not as a number: JavaScript's -0 is not C#'s 0.
    return raw >= 0n
      ? Number((raw + HALF_RAW_N) >> FRACTION_BITS_N)
      : Number(-((-raw + HALF_RAW_N) >> FRACTION_BITS_N));
  }

  add(other: Fix): Fix {
    return new Fix(this.raw + other.raw);
  }

  sub(other: Fix): Fix {
    return new Fix(this.raw - other.raw);
  }

  neg(): Fix {
    return new Fix(-this.raw);
  }

  /** The product, rounded down to a whole step (toward negative infinity). */
  mul(other: Fix): Fix {
    return new Fix(Number((BigInt(this.raw) * BigInt(other.raw)) >> FRACTION_BITS_N));
  }

  mulInt(value: number): Fix {
    return new Fix(Number(BigInt(this.raw) * BigInt(value)));
  }

  /** The quotient by a whole number, truncated toward zero. */
  divInt(value: number): Fix {
    return new Fix(Number(BigInt(this.raw) / BigInt(value)));
  }

  equals(other: Fix): boolean {
    return this.raw === other.raw;
  }

  compareTo(other: Fix): number {
    return this.raw < other.raw ? -1 : this.raw > other.raw ? 1 : 0;
  }

  lt(other: Fix): boolean {
    return this.raw < other.raw;
  }

  gt(other: Fix): boolean {
    return this.raw > other.raw;
  }

  le(other: Fix): boolean {
    return this.raw <= other.raw;
  }

  ge(other: Fix): boolean {
    return this.raw >= other.raw;
  }

  static abs(value: Fix): Fix {
    return value.raw < 0 ? new Fix(-value.raw) : value;
  }

  static min(a: Fix, b: Fix): Fix {
    return a.raw <= b.raw ? a : b;
  }

  static max(a: Fix, b: Fix): Fix {
    return a.raw >= b.raw ? a : b;
  }

  static clamp(value: Fix, min: Fix, max: Fix): Fix {
    return value.raw < min.raw ? min : value.raw > max.raw ? max : value;
  }

  static clamp01(value: Fix): Fix {
    return Fix.clamp(value, Fix.ZERO, Fix.ONE);
  }

  /** From a to b as t goes from 0 to 1. t is not clamped. */
  static lerp(a: Fix, b: Fix, t: Fix): Fix {
    return a.add(b.sub(a).mul(t));
  }

  /** Up to six decimals with trailing zeros dropped, as the C# ToString. For logs, never for rules. */
  toString(): string {
    return String(Number(this.toDouble().toFixed(TO_STRING_DECIMALS)));
  }
}

// ---------------------------------------------------------------------------
// SeededRandom: PCG32, and SplitMix64 for deriving seeds
// ---------------------------------------------------------------------------

const UINT64_MASK = (1n << 64n) - 1n;
const UINT32_MASK = 0xffffffffn;
const UINT32_RANGE = 2 ** 32;
const PCG_MULTIPLIER = 6364136223846793005n;
const PCG_XORSHIFT = 18n;
const PCG_OUTPUT_SHIFT = 27n;
const PCG_ROTATE_SHIFT = 59n;
const ROTATION_MASK = 31;
const FIX_FROM_UINT_SHIFT = 32 - FIX_FRACTION_BITS;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const SPLITMIX_MIX_1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MIX_2 = 0x94d049bb133111ebn;
const SPLITMIX_SHIFTS = [30n, 27n, 31n] as const;

/** A 64-bit seed as the C# ulong: a bigint, or a whole number that JavaScript holds exactly. */
export type Seed = bigint | number;

function toUint64(value: Seed): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`A seed given as a number must be a whole number within 2^53; pass a bigint.`);
  }
  return BigInt(value) & UINT64_MASK;
}

/**
 * Deterministic random numbers (PCG32), the C# kit's SeededRandom: the same seed and stream give the same
 * sequence as the game. Only the operations game rules use are here: whole numbers and Fix. The C# float
 * versions are for drawing, and float arithmetic in C# does not match JavaScript's.
 */
export class SeededRandom {
  private state = 0n;
  private readonly increment: bigint;

  constructor(seed: Seed, stream: Seed = 0) {
    this.increment = ((toUint64(stream) << 1n) | 1n) & UINT64_MASK;
    this.nextUInt();
    this.state = (this.state + toUint64(seed)) & UINT64_MASK;
    this.nextUInt();
  }

  /** The next 32-bit value, as a whole number from 0 to 2^32 - 1. */
  nextUInt(): number {
    const old = this.state;
    this.state = (old * PCG_MULTIPLIER + this.increment) & UINT64_MASK;
    const xorShifted = Number((((old >> PCG_XORSHIFT) ^ old) >> PCG_OUTPUT_SHIFT) & UINT32_MASK);
    const rotation = Number(old >> PCG_ROTATE_SHIFT);
    return ((xorShifted >>> rotation) | (xorShifted << (-rotation & ROTATION_MASK))) >>> 0;
  }

  /** Uniform whole number in [0, bound), without modulo bias. */
  nextUIntBelow(bound: number): number {
    if (bound === 0) return 0;
    const threshold = (UINT32_RANGE - bound) % bound;
    for (;;) {
      const value = this.nextUInt();
      if (value >= threshold) return value % bound;
    }
  }

  /** Uniform whole number in [minInclusive, maxExclusive). */
  range(minInclusive: number, maxExclusive: number): number {
    return maxExclusive <= minInclusive ? minInclusive : minInclusive + this.nextUIntBelow(maxExclusive - minInclusive);
  }

  /** Uniform Fix in [0, 1). */
  nextFix(): Fix {
    return Fix.fromRaw(this.nextUInt() >>> FIX_FROM_UINT_SHIFT);
  }

  /** Uniform Fix in [min, max). */
  rangeFix(min: Fix, max: Fix): Fix {
    return min.add(max.sub(min).mul(this.nextFix()));
  }

  /** Mixes a seed with a salt into a new, well-spread seed (SplitMix64), as the C# Derive. */
  static derive(seed: Seed, salt: Seed): bigint {
    const [first, second, third] = SPLITMIX_SHIFTS;
    let z = (toUint64(seed) + SPLITMIX_GAMMA * ((toUint64(salt) + 1n) & UINT64_MASK)) & UINT64_MASK;
    z = ((z ^ (z >> first)) * SPLITMIX_MIX_1) & UINT64_MASK;
    z = ((z ^ (z >> second)) * SPLITMIX_MIX_2) & UINT64_MASK;
    return z ^ (z >> third);
  }
}

// ---------------------------------------------------------------------------
// InputLog: one whole number per tick, as compact base64url text
// ---------------------------------------------------------------------------

// Bumped if the encoding ever changes, so an old log can't be misread.
const INPUT_LOG_FORMAT_VERSION = 1;
// Decoding reads untrusted text: refuse anything longer than a long round could be.
const INPUT_LOG_MAX_TICKS = 2 ** 20;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const VARINT_DATA_MASK = 0x7f;
const VARINT_MORE = 0x80;
const VARINT_STEP = 7n;
const VARINT_MAX_BITS = 64n;
const BASE64_BLOCK = 4;

/** An input log that is not what the kit's InputLog.Encode writes. */
export class InputLogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputLogFormatError';
  }
}

function zigZag(value: bigint): bigint {
  return value >= 0n ? value << 1n : ((-value) << 1n) - 1n;
}

function unZigZag(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n);
}

function writeVarint(bytes: number[], input: bigint): void {
  let value = input;
  while (value >= BigInt(VARINT_MORE)) {
    bytes.push(Number(value & BigInt(VARINT_DATA_MASK)) | VARINT_MORE);
    value >>= VARINT_STEP;
  }
  bytes.push(Number(value));
}

function toBase64Url(bytes: number[]): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((BASE64_BLOCK - (base64.length % BASE64_BLOCK)) % BASE64_BLOCK), '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new InputLogFormatError("The input log isn't base64url text.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * The input that played a round: one whole number per tick, in order, as the C# kit's InputLog. With the
 * seed and the rules it replays the round exactly. Each game decides what its numbers mean.
 */
export class InputLog {
  readonly codes: number[] = [];

  get count(): number {
    return this.codes.length;
  }

  add(code: number): void {
    if (!Number.isInteger(code) || code < INT32_MIN || code > INT32_MAX) {
      throw new RangeError(`An input must be a 32-bit whole number, not ${code}.`);
    }
    this.codes.push(code);
  }

  /** Runs of equal values as varints (the change from the value before, then the run length - 1), base64url. */
  encode(): string {
    const bytes = [INPUT_LOG_FORMAT_VERSION];
    let previous = 0n;
    for (let i = 0; i < this.codes.length; ) {
      const value = this.codes[i] as number;
      let run = 1;
      while (i + run < this.codes.length && this.codes[i + run] === value) run++;
      writeVarint(bytes, zigZag(BigInt(value) - previous));
      writeVarint(bytes, BigInt(run - 1));
      previous = BigInt(value);
      i += run;
    }
    return toBase64Url(bytes);
  }

  /** Reads a log made by encode (or the C# Encode). Throws InputLogFormatError on anything else. */
  static decode(text: string): InputLog {
    if (typeof text !== 'string') throw new InputLogFormatError('No input log.');
    const bytes = fromBase64Url(text);
    if (bytes.length === 0 || bytes[0] !== INPUT_LOG_FORMAT_VERSION) {
      throw new InputLogFormatError('The input log has an unknown format version.');
    }

    const log = new InputLog();
    let previous = 0n;
    let position = 1;
    const readVarint = (): bigint => {
      let value = 0n;
      for (let shift = 0n; shift < VARINT_MAX_BITS; shift += VARINT_STEP) {
        const next = bytes[position++];
        if (next === undefined) throw new InputLogFormatError('The input log ends mid-number.');
        value |= BigInt(next & VARINT_DATA_MASK) << shift;
        if ((next & VARINT_MORE) === 0) return value & UINT64_MASK;
      }
      throw new InputLogFormatError('A number in the input log is too long.');
    };
    while (position < bytes.length) {
      const value = previous + unZigZag(readVarint());
      const more = readVarint();
      if (value < BigInt(INT32_MIN) || value > BigInt(INT32_MAX)) {
        throw new InputLogFormatError('An input is out of range.');
      }
      if (more >= BigInt(INPUT_LOG_MAX_TICKS) || BigInt(log.count) + more >= BigInt(INPUT_LOG_MAX_TICKS)) {
        throw new InputLogFormatError('The input log is too long.');
      }
      for (let i = 0n; i <= more; i++) log.codes.push(Number(value));
      previous = value;
    }
    return log;
  }
}
