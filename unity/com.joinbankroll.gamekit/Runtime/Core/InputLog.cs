using System;
using System.Collections.Generic;

namespace Bankroll.GameKit.Core
{
    /// <summary>
    /// The input that played a round: one whole number per tick of play, in order. With the seed and the rules
    /// it replays the round exactly, which is how a server checks a score. Each game decides what its numbers
    /// mean; Cannon packs "touching, and where".
    ///
    /// <see cref="Encode"/> turns it into compact text for the round's result. A finger mostly holds still or
    /// moves a little, so each run of equal values is written once: the change from the value before, then how
    /// many more ticks it lasted, both as variable-length numbers. The bytes go out as base64url.
    /// </summary>
    public sealed class InputLog
    {
        // Bumped if the encoding ever changes, so an old log can't be misread.
        const byte FormatVersion = 1;

        // Decoding reads untrusted text: refuse anything longer than a long round could be.
        const int MaxTicks = 1 << 20;

        readonly List<int> _codes = new List<int>();

        public int Count => _codes.Count;
        public int this[int tick] => _codes[tick];
        public IReadOnlyList<int> Codes => _codes;

        public void Add(int code) => _codes.Add(code);

        public string Encode()
        {
            var bytes = new List<byte> { FormatVersion };
            long previous = 0;
            for (int i = 0; i < _codes.Count;)
            {
                int value = _codes[i];
                int run = 1;
                while (i + run < _codes.Count && _codes[i + run] == value) run++;
                WriteVarint(bytes, ZigZag(value - previous));
                WriteVarint(bytes, (ulong)(run - 1));
                previous = value;
                i += run;
            }
            return Convert.ToBase64String(bytes.ToArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        /// <summary>Reads a log made by <see cref="Encode"/>. Throws <see cref="FormatException"/> on anything else.</summary>
        public static InputLog Decode(string text)
        {
            if (text == null) throw new FormatException("No input log.");
            string base64 = text.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '=');
            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(base64);
            }
            catch (FormatException)
            {
                throw new FormatException("The input log isn't base64url text.");
            }
            if (bytes.Length == 0 || bytes[0] != FormatVersion)
                throw new FormatException("The input log has an unknown format version.");

            var log = new InputLog();
            long previous = 0;
            int position = 1;
            while (position < bytes.Length)
            {
                long value = previous + UnZigZag(ReadVarint(bytes, ref position));
                ulong more = ReadVarint(bytes, ref position);
                if (value < int.MinValue || value > int.MaxValue) throw new FormatException("An input is out of range.");
                // Compare before adding, so a huge run length can't overflow past the check.
                if (more >= MaxTicks || (ulong)log.Count + more >= MaxTicks)
                    throw new FormatException("The input log is too long.");
                for (ulong i = 0; i <= more; i++) log._codes.Add((int)value);
                previous = value;
            }
            return log;
        }

        static ulong ZigZag(long value) => unchecked((ulong)((value << 1) ^ (value >> 63)));

        static long UnZigZag(ulong value) => unchecked((long)(value >> 1) ^ -(long)(value & 1));

        static void WriteVarint(List<byte> bytes, ulong value)
        {
            while (value >= 0x80)
            {
                bytes.Add((byte)(value | 0x80));
                value >>= 7;
            }
            bytes.Add((byte)value);
        }

        static ulong ReadVarint(byte[] bytes, ref int position)
        {
            ulong value = 0;
            for (int shift = 0; shift < 64; shift += 7)
            {
                if (position >= bytes.Length) throw new FormatException("The input log ends mid-number.");
                byte next = bytes[position++];
                value |= (ulong)(next & 0x7F) << shift;
                if ((next & 0x80) == 0) return value;
            }
            throw new FormatException("A number in the input log is too long.");
        }
    }
}
