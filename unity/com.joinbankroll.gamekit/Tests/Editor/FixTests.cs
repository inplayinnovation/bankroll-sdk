using Bankroll.GameKit.Core;
using NUnit.Framework;

namespace Bankroll.GameKit.Tests
{
    public sealed class FixTests
    {
        [Test]
        public void WholeNumbersAndSettingsValuesConvertExactly()
        {
            Assert.AreEqual(Fix.OneRaw * 3, Fix.FromInt(3).Raw);
            Assert.AreEqual(Fix.OneRaw / 2, Fix.FromDouble(0.5).Raw);
            // 24 shots a second at 60 ticks a second is exactly 2.5 ticks between shots.
            Assert.AreEqual(Fix.OneRaw * 5 / 2, Fix.FromDouble(60.0 / 24f).Raw);
        }

        [Test]
        public void SettingsValuesRoundToTheNearestStep()
        {
            // Gravity of 7.6 units/s² at 60 ticks/s is 0.00211… units per tick per tick: 2213.6 steps.
            Assert.AreEqual(2214, Fix.FromDouble(7.6f / (60.0 * 60.0)).Raw);
            Assert.AreEqual(-2214, Fix.FromDouble(-7.6f / (60.0 * 60.0)).Raw);
        }

        [Test]
        public void ArithmeticIsExact()
        {
            var a = Fix.FromDouble(1.25);
            var b = Fix.FromDouble(0.5);
            Assert.AreEqual(Fix.FromDouble(1.75), a + b);
            Assert.AreEqual(Fix.FromDouble(0.75), a - b);
            Assert.AreEqual(Fix.FromDouble(0.625), a * b);
            Assert.AreEqual(Fix.FromDouble(3.75), a * 3);
            Assert.AreEqual(Fix.FromDouble(0.625), a / 2);
        }

        [Test]
        public void MultiplicationRoundsDownAndDivisionTruncates()
        {
            // These rules are what a copy of the game in another language must reproduce.
            var tiny = Fix.FromRaw(1);
            var half = Fix.FromDouble(0.5);
            Assert.AreEqual(0, (tiny * half).Raw);
            Assert.AreEqual(-1, (-tiny * half).Raw);
            Assert.AreEqual(-3, (Fix.FromRaw(-7) / 2).Raw);
        }

        [Test]
        public void RoundsHalvesAwayFromZero()
        {
            Assert.AreEqual(3, Fix.FromDouble(2.5).RoundToInt());
            Assert.AreEqual(-3, Fix.FromDouble(-2.5).RoundToInt());
            Assert.AreEqual(2, Fix.FromDouble(2.4999).RoundToInt());
        }

        [Test]
        public void ClampAndLerp()
        {
            var two = Fix.FromInt(2);
            Assert.AreEqual(Fix.One, Fix.Clamp(Fix.FromInt(5), Fix.Zero, Fix.One));
            Assert.AreEqual(Fix.Zero, Fix.Clamp01(-two));
            Assert.AreEqual(Fix.FromDouble(1.5), Fix.Lerp(Fix.One, two, Fix.FromDouble(0.5)));
        }
    }
}
