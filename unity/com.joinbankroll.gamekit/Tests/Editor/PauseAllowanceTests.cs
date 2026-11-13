using Bankroll.GameKit.Core;
using NUnit.Framework;

namespace Bankroll.GameKit.Tests
{
    public sealed class PauseAllowanceTests
    {
        [Test]
        public void PausesDrawOnOneAllowance()
        {
            var allowance = new PauseAllowance(20);
            allowance.Pause(now: 100);
            Assert.AreEqual(14, allowance.SecondsLeft(106), 1e-9);
            allowance.Resume(106);
            Assert.AreEqual(14, allowance.SecondsLeft(500), 1e-9, "Nothing counts between pauses.");

            allowance.Pause(500);
            Assert.IsFalse(allowance.RanOut(513));
            Assert.IsTrue(allowance.RanOut(514));
            Assert.AreEqual(0, allowance.SecondsLeft(600));
        }

        [Test]
        public void PauseAndResumeTwiceCountOnce()
        {
            var allowance = new PauseAllowance(10);
            allowance.Pause(0);
            allowance.Pause(5); // already paused: the first pause's start stands
            allowance.Resume(6);
            allowance.Resume(9);
            Assert.AreEqual(4, allowance.SecondsLeft(9), 1e-9);
        }

        [Test]
        public void AClockThatJumpsBackCostsNothing()
        {
            var allowance = new PauseAllowance(10);
            allowance.Pause(50);
            Assert.AreEqual(10, allowance.SecondsLeft(40), 1e-9);
        }

        [Test]
        public void PracticeNeverRunsOut()
        {
            var allowance = PauseAllowance.Unlimited;
            allowance.Pause(0);
            Assert.IsTrue(allowance.IsUnlimited);
            Assert.IsFalse(allowance.RanOut(1e9));
        }
    }
}
