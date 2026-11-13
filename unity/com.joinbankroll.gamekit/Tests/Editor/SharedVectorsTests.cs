using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Bankroll.GameKit.Core;
using NUnit.Framework;

namespace Bankroll.GameKit.Tests.Editor
{
    /// <summary>
    /// The test data both halves of the kit check: this C# and its TypeScript copy in the SDK
    /// (@joinbankroll/sdk/game-core, test/game-core.test.ts). The C# computes what Fix, SeededRandom and
    /// InputLog give for fixed inputs, and the committed file must equal it; the SDK's tests check the
    /// TypeScript against the same file. So a change on either side that forgets the other fails.
    ///
    /// After a deliberate change to these numbers, regenerate the file: run the tests with
    /// BANKROLL_WRITE_VECTORS=1, then commit it with the change and the TypeScript that matches.
    /// </summary>
    public class SharedVectorsTests
    {
        const string WriteVariable = "BANKROLL_WRITE_VECTORS";
        const string VectorsPath = "Tests/Vectors~/core.json";
        const int FormatVersion = 1;
        // How many values each sequence records.
        const int Samples = 8;
        const int WideSamples = 3;
        const int SmallBound = 6;
        const int RangeMin = -5;
        const int RangeMax = 17;
        const double RangeFixMin = -2.5;
        const double RangeFixMax = 7.25;
        const int RandomLogSeed = 99;
        const int RandomLogTicks = 200;
        const int RandomLogChangeOdds = 3;
        const int RandomLogMaxCode = 1000;
        const int LongRunTicks = 5000;
        const int LongRunCode = 7;
        // InputLog's own limits, from its C#: the format byte and the most ticks a log may hold.
        const byte LogFormatVersion = 1;
        const int LogMaxTicks = 1 << 20;
        const int TooLongVarintBytes = 10;

        static readonly double[] FromDoubleCases =
        {
            0, 0.5, -0.5, 1.5, -2.5, 0.1, 1.0 / 3.0, -1.0 / 3.0, 12.345678, -0.000001, 89.99,
            // Exactly half a step, both signs: halves round away from zero.
            1.0 / (1 << 21), -1.0 / (1 << 21),
        };

        static readonly long[] RoundToIntCases =
        {
            0, Fix.OneRaw / 2, -Fix.OneRaw / 2, Fix.OneRaw / 2 - 1, -(Fix.OneRaw / 2 - 1),
            3 * Fix.OneRaw / 2, -3 * Fix.OneRaw / 2, 10 * Fix.OneRaw + 1,
        };

        static readonly double[][] MulCases =
        {
            new[] { 1.5, 2.25 }, new[] { -1.5, 2.25 }, new[] { -1.5, -2.25 }, new[] { 0.1, 0.1 },
            new[] { 89.99, 89.99 }, new[] { 1000.5, 1000.25 },
        };

        static readonly (long aRaw, long bRaw)[] MulRawCases = { (-1, 1), (1, -1), (-1, -1) };

        static readonly (double a, int b)[] MulIntCases = { (1.5, 3), (-1.25, 7), (0.1, -4) };

        static readonly (double a, int b)[] DivIntCases = { (1.0, 3), (-1.0, 3), (7.5, -2), (-7.5, -2) };

        static readonly double[][] LerpCases =
        {
            new[] { 0.0, 10.0, 0.25 }, new[] { -3.0, 5.0, 0.5 }, new[] { 1.5, -1.5, 0.3 }, new[] { 0.0, 1.0, 1.25 },
        };

        static readonly (ulong seed, ulong stream)[] RandomCases =
        {
            (0, 0), (1, 0), (42, 7), (123456789, 1), (1UL << 63, 3), (ulong.MaxValue, ulong.MaxValue),
        };

        static readonly (ulong seed, ulong salt)[] DeriveCases =
        {
            (0, 0), (42, 0), (42, 1), (123456789, 987654321), (ulong.MaxValue, ulong.MaxValue),
        };

        [Test]
        public void CommittedVectorsMatchTheKit()
        {
            string path = Path.Combine(PackageRoot(), VectorsPath);
            string expected = Build();
            if (Environment.GetEnvironmentVariable(WriteVariable) == "1")
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, expected);
                Assert.Pass($"Wrote {path}.");
            }
            Assert.IsTrue(File.Exists(path), $"{path} is missing. Run the tests with {WriteVariable}=1 to write it.");
            Assert.AreEqual(File.ReadAllText(path), expected,
                $"{VectorsPath} no longer matches the kit. If the change is deliberate, run the tests with " +
                $"{WriteVariable}=1 and commit the file with the matching TypeScript.");
        }

        [Test]
        public void InvalidLogsAreRefused()
        {
            foreach (string text in InvalidLogs())
                Assert.Throws<FormatException>(() => InputLog.Decode(text), $"Decoded {text}");
        }

        static string PackageRoot() =>
            UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(Fix).Assembly).resolvedPath;

        static string Build()
        {
            var json = new StringBuilder();
            json.Append("{\n");
            json.Append($"  \"format\": {FormatVersion},\n");
            json.Append("  \"fix\": {\n");
            // A double goes by its exact 64 bits, so no decimal printing can shift it.
            json.Append("    \"fromDouble\": ").Append(Rows(FromDoubleCases.Select(v =>
                new[] { Str((ulong)BitConverter.DoubleToInt64Bits(v)), Num(Fix.FromDouble(v).Raw) }))).Append(",\n");
            json.Append("    \"roundToInt\": ").Append(Rows(RoundToIntCases.Select(raw =>
                new[] { Num(raw), Num(Fix.FromRaw(raw).RoundToInt()) }))).Append(",\n");
            json.Append("    \"mul\": ").Append(Rows(MulCases.Select(c => (Fix.FromDouble(c[0]), Fix.FromDouble(c[1])))
                .Concat(MulRawCases.Select(c => (Fix.FromRaw(c.aRaw), Fix.FromRaw(c.bRaw))))
                .Select(c => new[] { Num(c.Item1.Raw), Num(c.Item2.Raw), Num((c.Item1 * c.Item2).Raw) }))).Append(",\n");
            json.Append("    \"mulInt\": ").Append(Rows(MulIntCases.Select(c =>
                new[] { Num(Fix.FromDouble(c.a).Raw), Num(c.b), Num((Fix.FromDouble(c.a) * c.b).Raw) }))).Append(",\n");
            json.Append("    \"divInt\": ").Append(Rows(DivIntCases.Select(c =>
                new[] { Num(Fix.FromDouble(c.a).Raw), Num(c.b), Num((Fix.FromDouble(c.a) / c.b).Raw) }))).Append(",\n");
            json.Append("    \"lerp\": ").Append(Rows(LerpCases.Select(c =>
            {
                Fix a = Fix.FromDouble(c[0]), b = Fix.FromDouble(c[1]), t = Fix.FromDouble(c[2]);
                return new[] { Num(a.Raw), Num(b.Raw), Num(t.Raw), Num(Fix.Lerp(a, b, t).Raw) };
            }))).Append("\n");
            json.Append("  },\n");

            json.Append("  \"random\": [\n");
            json.Append(string.Join(",\n", RandomCases.Select(c => "    " + RandomCase(c.seed, c.stream))));
            json.Append("\n  ],\n");
            json.Append("  \"derive\": ").Append(Rows(DeriveCases.Select(c =>
                new[] { Str(c.seed), Str(c.salt), Str(SeededRandom.Derive(c.seed, c.salt)) }), "  ")).Append(",\n");

            json.Append("  \"inputLog\": {\n");
            json.Append("    \"valid\": [\n");
            json.Append(string.Join(",\n", ValidLogs().Select(codes =>
            {
                var log = new InputLog();
                foreach (int code in codes) log.Add(code);
                return $"      {{ \"codes\": [{string.Join(", ", codes.Select(code => Num(code)))}], \"text\": {Str(log.Encode())} }}";
            })));
            json.Append("\n    ],\n");
            json.Append("    \"invalid\": [").Append(string.Join(", ", InvalidLogs().Select(Str))).Append("]\n");
            json.Append("  }\n");
            json.Append("}\n");
            return json.ToString();
        }

        // One generator per case, called in this order; the TypeScript test replays the same calls.
        static string RandomCase(ulong seed, ulong stream)
        {
            var random = new SeededRandom(seed, stream);
            var uints = Repeat(Samples, () => Num(random.NextUInt()));
            var below = Repeat(Samples, () => Num(random.NextUInt(SmallBound)));
            var belowWide = Repeat(WideSamples, () => Num(random.NextUInt(uint.MaxValue)));
            var range = Repeat(Samples, () => Num(random.Range(RangeMin, RangeMax)));
            var rangeWide = Repeat(WideSamples, () => Num(random.Range(int.MinValue, int.MaxValue)));
            var fix = Repeat(Samples, () => Num(random.NextFix().Raw));
            Fix min = Fix.FromDouble(RangeFixMin), max = Fix.FromDouble(RangeFixMax);
            var rangeFix = Repeat(Samples, () => Num(random.Range(min, max).Raw));
            return "{ " +
                   $"\"seed\": {Str(seed)}, \"stream\": {Str(stream)}, " +
                   $"\"uints\": [{uints}], \"below\": [{below}], \"belowWide\": [{belowWide}], " +
                   $"\"range\": [{range}], \"rangeWide\": [{rangeWide}], \"fix\": [{fix}], " +
                   $"\"rangeFix\": [{rangeFix}] }}";
        }

        static IEnumerable<int[]> ValidLogs()
        {
            yield return new int[0];
            yield return new[] { 0 };
            yield return new[] { 5, 5, 5, -3, -3, 1000000, 0 };
            yield return new[] { int.MaxValue, int.MinValue, int.MaxValue };

            var random = new SeededRandom(RandomLogSeed);
            var sticky = new int[RandomLogTicks];
            int current = 0;
            for (int i = 0; i < RandomLogTicks; i++)
            {
                if (random.Range(0, RandomLogChangeOdds) == 0) current = random.Range(-RandomLogMaxCode, RandomLogMaxCode);
                sticky[i] = current;
            }
            yield return sticky;

            yield return Enumerable.Repeat(LongRunCode, LongRunTicks).ToArray();
        }

        static IEnumerable<string> InvalidLogs()
        {
            yield return "";
            yield return Base64Url(new byte[] { 2 });
            yield return "!!!!";
            yield return Base64Url(new byte[] { LogFormatVersion, 0x80 });
            // A change of 2^31 from 0: out of a 32-bit input's range.
            yield return Base64Url(Concat(new[] { LogFormatVersion }, Varint((ulong)int.MaxValue * 2 + 2), Varint(0)));
            // A run as long as the most ticks a log may hold.
            yield return Base64Url(Concat(new[] { LogFormatVersion }, Varint(0), Varint((ulong)LogMaxTicks)));
            // A number with more than 64 bits of continuation.
            yield return Base64Url(Concat(new[] { LogFormatVersion }, Enumerable.Repeat((byte)0x80, TooLongVarintBytes).ToArray()));
        }

        static byte[] Varint(ulong value)
        {
            var bytes = new List<byte>();
            while (value >= 0x80)
            {
                bytes.Add((byte)(value | 0x80));
                value >>= 7;
            }
            bytes.Add((byte)value);
            return bytes.ToArray();
        }

        static byte[] Concat(params byte[][] parts) => parts.SelectMany(part => part).ToArray();

        static string Base64Url(byte[] bytes) =>
            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        static string Repeat(int count, Func<string> next) =>
            string.Join(", ", Enumerable.Range(0, count).Select(_ => next()));

        static string Rows(IEnumerable<string[]> rows, string indent = "    ") =>
            "[\n" + string.Join(",\n", rows.Select(row => $"{indent}  [{string.Join(", ", row)}]")) + $"\n{indent}]";

        static string Num(long value) => value.ToString(CultureInfo.InvariantCulture);

        static string Str(ulong value) => "\"" + value.ToString(CultureInfo.InvariantCulture) + "\"";

        static string Str(string value) => "\"" + value + "\"";
    }
}
