using System;
using System.Globalization;

namespace Bankroll.GameKit.Core
{
    /// <summary>
    /// A fixed-point number: a whole count of 2^-20 steps (about a millionth). Game rules use it instead of
    /// float so that a round re-run anywhere gives the same bits: on every phone, in the Editor's tests, and on
    /// a server in any language. Whole-number math is exact on every machine, while float rounding can differ
    /// between compilers and languages, and a simulation magnifies the smallest difference tick after tick.
    ///
    /// Twenty fraction bits keep a game's numbers exact in JavaScript too. The product of two values under
    /// about 90 world units stays below 2^53, the largest whole number a JavaScript number holds exactly, so a
    /// TypeScript copy of the rules needs nothing special. Keep float for drawing and UI, converting with
    /// <see cref="ToFloat"/> only for display.
    /// </summary>
    public readonly struct Fix : IEquatable<Fix>, IComparable<Fix>
    {
        public const int FractionBits = 20;
        public const long OneRaw = 1L << FractionBits;

        public static readonly Fix Zero = default;
        public static readonly Fix One = new Fix(OneRaw);
        public static readonly Fix MaxValue = new Fix(long.MaxValue);

        /// <summary>The underlying count of 2^-20 steps.</summary>
        public readonly long Raw;

        Fix(long raw) => Raw = raw;

        public static Fix FromRaw(long raw) => new Fix(raw);

        public static Fix FromInt(int value) => new Fix((long)value << FractionBits);

        /// <summary>
        /// The nearest step to a settings value. Use it to turn config numbers into rules when a round starts,
        /// never inside a tick. A double holds any float exactly, and one division in double rounds the same
        /// way everywhere, so compute the value in double, e.g. <c>Fix.FromDouble((double)speed / ticks)</c>.
        /// </summary>
        public static Fix FromDouble(double value) =>
            new Fix((long)Math.Round(value * OneRaw, MidpointRounding.AwayFromZero));

        /// <summary>For drawing and UI only; never feed the result back into the rules.</summary>
        public float ToFloat() => (float)((double)Raw / OneRaw);

        public double ToDouble() => (double)Raw / OneRaw;

        /// <summary>The nearest whole number, with halves rounded away from zero.</summary>
        public int RoundToInt() =>
            Raw >= 0
                ? (int)((Raw + OneRaw / 2) >> FractionBits)
                : -(int)((-Raw + OneRaw / 2) >> FractionBits);

        public static Fix operator +(Fix a, Fix b) => new Fix(a.Raw + b.Raw);
        public static Fix operator -(Fix a, Fix b) => new Fix(a.Raw - b.Raw);
        public static Fix operator -(Fix a) => new Fix(-a.Raw);

        /// <summary>The product, rounded down to a whole step (toward negative infinity).</summary>
        public static Fix operator *(Fix a, Fix b) => new Fix((a.Raw * b.Raw) >> FractionBits);

        public static Fix operator *(Fix a, int b) => new Fix(a.Raw * b);
        public static Fix operator *(int a, Fix b) => new Fix(a * b.Raw);

        /// <summary>The quotient by a whole number, truncated toward zero.</summary>
        public static Fix operator /(Fix a, int b) => new Fix(a.Raw / b);

        public static bool operator ==(Fix a, Fix b) => a.Raw == b.Raw;
        public static bool operator !=(Fix a, Fix b) => a.Raw != b.Raw;
        public static bool operator <(Fix a, Fix b) => a.Raw < b.Raw;
        public static bool operator >(Fix a, Fix b) => a.Raw > b.Raw;
        public static bool operator <=(Fix a, Fix b) => a.Raw <= b.Raw;
        public static bool operator >=(Fix a, Fix b) => a.Raw >= b.Raw;

        public static Fix Abs(Fix value) => value.Raw < 0 ? new Fix(-value.Raw) : value;
        public static Fix Min(Fix a, Fix b) => a.Raw <= b.Raw ? a : b;
        public static Fix Max(Fix a, Fix b) => a.Raw >= b.Raw ? a : b;

        public static Fix Clamp(Fix value, Fix min, Fix max) =>
            value.Raw < min.Raw ? min : value.Raw > max.Raw ? max : value;

        public static Fix Clamp01(Fix value) => Clamp(value, Zero, One);

        /// <summary>From a to b as t goes from 0 to 1. t is not clamped.</summary>
        public static Fix Lerp(Fix a, Fix b, Fix t) => a + (b - a) * t;

        public bool Equals(Fix other) => Raw == other.Raw;
        public override bool Equals(object obj) => obj is Fix other && Raw == other.Raw;
        public override int GetHashCode() => Raw.GetHashCode();
        public int CompareTo(Fix other) => Raw.CompareTo(other.Raw);
        public override string ToString() => ToDouble().ToString("0.######", CultureInfo.InvariantCulture);
    }
}
