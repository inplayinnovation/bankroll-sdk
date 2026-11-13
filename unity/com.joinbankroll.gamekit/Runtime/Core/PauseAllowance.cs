using System;

namespace Bankroll.GameKit.Core
{
    /// <summary>
    /// How much pausing a round allows in all, counted in real seconds, because the server's window for a paid
    /// round runs in real time. Practice rounds get <see cref="Unlimited"/>. The caller supplies the time (any
    /// clock that keeps running while the game is in the background), so this is plain C# and testable.
    /// </summary>
    public sealed class PauseAllowance
    {
        double _left;
        double _pausedAt;

        public PauseAllowance(double seconds) => _left = Math.Max(0, seconds);

        public static PauseAllowance Unlimited => new PauseAllowance(double.PositiveInfinity);

        public bool IsUnlimited => double.IsPositiveInfinity(_left);
        public bool IsPaused { get; private set; }

        /// <summary>Seconds of pausing left at <paramref name="now"/>.</summary>
        public double SecondsLeft(double now) =>
            IsPaused ? Math.Max(0, _left - Math.Max(0, now - _pausedAt)) : _left;

        public bool RanOut(double now) => SecondsLeft(now) <= 0;

        public void Pause(double now)
        {
            if (IsPaused) return;
            IsPaused = true;
            _pausedAt = now;
        }

        /// <summary>Stops counting, keeping what's left for the next pause.</summary>
        public void Resume(double now)
        {
            if (!IsPaused) return;
            _left = SecondsLeft(now);
            IsPaused = false;
        }
    }
}
