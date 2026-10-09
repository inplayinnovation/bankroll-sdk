using Bankroll.GameKit.Core;
using NUnit.Framework;

namespace Bankroll.GameKit.Tests
{
    public sealed class RoundTests
    {
        [Test]
        public void EndsWithTimeUpAfterTheLastTick()
        {
            var round = new Round(ticksPerSecond: 60, durationTicks: 120);
            for (int i = 0; i < 119; i++) round.AdvanceTick();
            Assert.IsFalse(round.Ended);
            Assert.AreEqual(1, round.WholeSecondsRemaining);

            round.AdvanceTick();
            Assert.AreEqual(RoundEndReason.TimeUp, round.EndReason);
            Assert.AreEqual(120, round.TicksPlayed);
            Assert.AreEqual(0, round.WholeSecondsRemaining);
        }

        [Test]
        public void TheClockStopsWhenThePlayerDies()
        {
            var round = new Round(60, 600);
            round.AdvanceTick();
            round.End(RoundEndReason.PlayerDied);
            round.AdvanceTick();
            round.End(RoundEndReason.TimeUp); // only the first ending counts

            Assert.AreEqual(RoundEndReason.PlayerDied, round.EndReason);
            Assert.AreEqual(1, round.TicksPlayed);
        }

        [Test]
        public void PointsCountOnlyDuringPlayButABonusCountsAfter()
        {
            var round = new Round(60, 600);
            round.AddPoints(5);
            round.End(RoundEndReason.TimeUp);
            round.AddPoints(100);
            round.AddBonus(250);
            Assert.AreEqual(255, round.Score);
        }

        [Test]
        public void CountdownRoundsUpToWholeSeconds()
        {
            var round = new Round(60, Round.TicksFor(180f, 60));
            Assert.AreEqual(10800, round.DurationTicks);
            Assert.AreEqual(180, round.WholeSecondsRemaining);
            round.AdvanceTick();
            Assert.AreEqual(180, round.WholeSecondsRemaining);
        }
    }
}
