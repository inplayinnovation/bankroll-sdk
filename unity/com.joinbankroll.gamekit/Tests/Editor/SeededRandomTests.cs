using Bankroll.GameKit.Core;
using NUnit.Framework;

namespace Bankroll.GameKit.Tests
{
    public sealed class SeededRandomTests
    {
        // Computed by an independent Python copy of the generator. A server or a TypeScript copy of a game's
        // rules must produce exactly these numbers.
        [Test]
        public void MatchesTheReferenceSequence()
        {
            var random = new SeededRandom(12345);
            Assert.AreEqual(304133009u, random.NextUInt());
            Assert.AreEqual(2564000426u, random.NextUInt());
            Assert.AreEqual(1539170214u, random.NextUInt());
            Assert.AreEqual(2267019874u, random.NextUInt());

            var streamOne = new SeededRandom(12345, stream: 1);
            Assert.AreEqual(2280515124u, streamOne.NextUInt());
            Assert.AreEqual(875822104u, streamOne.NextUInt());
        }

        [Test]
        public void DeriveMatchesTheReference()
        {
            Assert.AreEqual(2454886589211414944UL, SeededRandom.Derive(12345, 0));
            Assert.AreEqual(3778200017661327597UL, SeededRandom.Derive(12345, 1));
        }

        [Test]
        public void FixedPointDrawsUseTheTopTwentyBits()
        {
            var random = new SeededRandom(12345);
            Assert.AreEqual(74251, random.NextFix().Raw);
            Assert.AreEqual(625976, random.NextFix().Raw);
            Assert.AreEqual(375773, random.NextFix().Raw);
        }

        [Test]
        public void FixedPointRangeStaysInBounds()
        {
            var random = new SeededRandom(7);
            var min = Fix.FromDouble(-0.2);
            var max = Fix.FromDouble(0.2);
            for (int i = 0; i < 10000; i++)
            {
                var value = random.Range(min, max);
                Assert.That(value >= min && value < max, $"{value} is outside [{min}, {max})");
            }
        }
    }
}
