using System;
using Bankroll.GameKit.Core;
using NUnit.Framework;

namespace Bankroll.GameKit.Tests
{
    public sealed class InputLogTests
    {
        static InputLog Of(params int[] codes)
        {
            var log = new InputLog();
            foreach (int code in codes) log.Add(code);
            return log;
        }

        static void AssertRoundTrips(InputLog log)
        {
            var decoded = InputLog.Decode(log.Encode());
            CollectionAssert.AreEqual(log.Codes, decoded.Codes);
        }

        [Test]
        public void RoundTripsRunsChangesAndExtremes()
        {
            AssertRoundTrips(Of());
            AssertRoundTrips(Of(0));
            AssertRoundTrips(Of(0, 0, 0, 5, 5, -3, -3, -3, 0, 1));
            AssertRoundTrips(Of(int.MaxValue, int.MinValue, int.MaxValue, 0));
        }

        [Test]
        public void RoundTripsARandomRound()
        {
            var random = new SeededRandom(99);
            var log = new InputLog();
            int value = 0;
            for (int tick = 0; tick < 10800; tick++)
            {
                if (random.NextUInt(4) == 0) value += random.Range(-40, 41);
                log.Add(value);
            }
            AssertRoundTrips(log);
        }

        [Test]
        public void HoldingStillCostsAlmostNothing()
        {
            var log = new InputLog();
            for (int tick = 0; tick < 10800; tick++) log.Add(0);
            Assert.Less(log.Encode().Length, 8, "Three minutes of one value should be a few characters.");
        }

        [Test]
        public void TheTextIsUrlSafe()
        {
            var log = new InputLog();
            for (int value = -300; value < 300; value += 7) log.Add(value * 1001);
            StringAssert.IsMatch("^[A-Za-z0-9_-]*$", log.Encode());
        }

        [Test]
        public void RejectsWhatItDidntWrite()
        {
            Assert.Throws<FormatException>(() => InputLog.Decode("not base64!"));
            Assert.Throws<FormatException>(() => InputLog.Decode(""));
            Assert.Throws<FormatException>(() => InputLog.Decode("Ag")); // version 2
            string truncated = Of(0, 1_000_000).Encode();
            Assert.Throws<FormatException>(() => InputLog.Decode(truncated.Substring(0, truncated.Length - 2)));
            // A run far longer than any round: version 1, value 0, then the largest run length.
            string huge = Convert.ToBase64String(new byte[] { 1, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01 });
            Assert.Throws<FormatException>(() => InputLog.Decode(huge.TrimEnd('=').Replace('+', '-').Replace('/', '_')));
        }
    }
}
