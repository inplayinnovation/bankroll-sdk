using System;

namespace Bankroll.GameKit.Core
{
    public enum RoundEndReason { TimeUp, PlayerDied }

    /// <summary>
    /// What every round shares, in plain C#: a clock that counts fixed ticks, the score, how the round ended,
    /// and the input that played it. A game's simulation owns one and steps it once per tick; RoundController
    /// only reads it. It never touches Unity or the wall clock, so a server re-running a round gets the same
    /// clock and score.
    /// </summary>
    public sealed class Round
    {
        public Round(int ticksPerSecond, int durationTicks)
        {
            if (ticksPerSecond <= 0) throw new ArgumentOutOfRangeException(nameof(ticksPerSecond));
            if (durationTicks <= 0) throw new ArgumentOutOfRangeException(nameof(durationTicks));
            TicksPerSecond = ticksPerSecond;
            DurationTicks = durationTicks;
        }

        public int TicksPerSecond { get; }
        public int DurationTicks { get; }

        /// <summary>Ticks of play so far. It stops when the round ends.</summary>
        public int TicksPlayed { get; private set; }

        public int TicksRemaining => DurationTicks - TicksPlayed;
        public int Score { get; private set; }
        public RoundEndReason? EndReason { get; private set; }
        public bool Ended => EndReason.HasValue;

        /// <summary>
        /// The input of every tick of play, the one that ends the round included, as the game's simulation
        /// consumed it. With the seed, it replays the round.
        /// </summary>
        public InputLog Inputs { get; } = new InputLog();

        /// <summary>Seconds of play so far, for display and reports.</summary>
        public float SecondsPlayed => (float)TicksPlayed / TicksPerSecond;

        /// <summary>Whole seconds left, rounded up, the way a countdown shows them.</summary>
        public int WholeSecondsRemaining => (TicksRemaining + TicksPerSecond - 1) / TicksPerSecond;

        /// <summary>Adds points during play. Ignored once the round has ended.</summary>
        public void AddPoints(int points)
        {
            if (!Ended) Score += points;
        }

        /// <summary>Adds points at the end, such as a survival bonus.</summary>
        public void AddBonus(int points) => Score += points;

        /// <summary>Ends the round now. Only the first call counts.</summary>
        public void End(RoundEndReason reason)
        {
            if (!Ended) EndReason = reason;
        }

        /// <summary>Counts one tick of play. After the last tick, the round ends with <see cref="RoundEndReason.TimeUp"/>.</summary>
        public void AdvanceTick()
        {
            if (Ended) return;
            TicksPlayed++;
            if (TicksPlayed >= DurationTicks) End(RoundEndReason.TimeUp);
        }

        /// <summary>How many ticks a round of this many seconds lasts, to the nearest tick.</summary>
        public static int TicksFor(float seconds, int ticksPerSecond) =>
            (int)Math.Round((double)seconds * ticksPerSecond, MidpointRounding.AwayFromZero);
    }
}
