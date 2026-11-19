namespace Bankroll.GameKit.Core
{
    /// <summary>
    /// Deterministic random numbers (PCG32). The same seed and stream always give the same sequence on
    /// every device. Gameplay must use this instead of UnityEngine.Random, so both players in a match
    /// see identical randomness.
    /// </summary>
    public sealed class SeededRandom
    {
        const ulong Multiplier = 6364136223846793005UL;

        ulong _state;
        readonly ulong _increment;

        /// <param name="seed">The match seed, or a seed derived from it.</param>
        /// <param name="stream">Independent stream id, so separate systems never disturb each other's sequence.</param>
        public SeededRandom(ulong seed, ulong stream = 0)
        {
            _increment = (stream << 1) | 1UL;
            _state = 0;
            NextUInt();
            _state = unchecked(_state + seed);
            NextUInt();
        }

        public uint NextUInt()
        {
            ulong old = _state;
            _state = unchecked(old * Multiplier + _increment);
            uint xorShifted = (uint)(((old >> 18) ^ old) >> 27);
            int rotation = (int)(old >> 59);
            return (xorShifted >> rotation) | (xorShifted << (-rotation & 31));
        }

        /// <summary>Uniform integer in [0, bound), without modulo bias.</summary>
        public uint NextUInt(uint bound)
        {
            if (bound == 0) return 0;
            uint threshold = unchecked(0u - bound) % bound;
            while (true)
            {
                uint value = NextUInt();
                if (value >= threshold) return value % bound;
            }
        }

        /// <summary>Uniform float in [0, 1).</summary>
        public float NextFloat() => (NextUInt() >> 8) * (1f / 16777216f);

        /// <summary>Uniform integer in [minInclusive, maxExclusive).</summary>
        public int Range(int minInclusive, int maxExclusive) =>
            maxExclusive <= minInclusive
                ? minInclusive
                : minInclusive + (int)NextUInt((uint)(maxExclusive - minInclusive));

        /// <summary>Uniform float in [min, max).</summary>
        public float Range(float min, float max) => min + (max - min) * NextFloat();

        /// <summary>True with the given probability (0 to 1).</summary>
        public bool Chance(float probability) => NextFloat() < probability;

        /// <summary>Uniform fixed-point number in [0, 1). Game rules use this rather than the float versions.</summary>
        public Fix NextFix() => Fix.FromRaw(NextUInt() >> (32 - Fix.FractionBits));

        /// <summary>Uniform fixed-point number in [min, max).</summary>
        public Fix Range(Fix min, Fix max) => min + (max - min) * NextFix();

        /// <summary>
        /// Mixes a seed with a salt into a new, well-spread seed (SplitMix64). Use it to give every object
        /// its own seed, e.g. each ball in a spawn sequence and each of its children.
        /// </summary>
        public static ulong Derive(ulong seed, ulong salt)
        {
            ulong z = unchecked(seed + 0x9E3779B97F4A7C15UL * (salt + 1));
            z = unchecked((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL);
            z = unchecked((z ^ (z >> 27)) * 0x94D049BB133111EBUL);
            return z ^ (z >> 31);
        }
    }
}
