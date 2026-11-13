using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>The haptic types the Bankroll app can play, with the same names as the Bankroll SDK.</summary>
    public enum HapticType { Selection, Light, Medium, Heavy, Success, Warning, Error }

    /// <summary>
    /// Plays haptics through the Bankroll app (<c>bankroll.haptics</c>). Thinned so a storm of events stays a
    /// texture: within <see cref="MinimumGapSeconds"/> of the last buzz, only a heavier one gets through.
    /// Haptics are decoration: they never affect the simulation.
    /// </summary>
    public static class Haptics
    {
        /// <summary>The player's setting. Off means nothing is sent.</summary>
        public static bool Enabled = true;

        /// <summary>Set from the game's config (one settings file).</summary>
        public static float MinimumGapSeconds = 0.08f;

        static float _lastTime = float.NegativeInfinity;
        static int _lastWeight;

        public static void Play(HapticType type)
        {
            if (!Enabled) return;
            float now = Time.unscaledTime;
            int weight = Weight(type);
            if (now - _lastTime < MinimumGapSeconds && weight <= _lastWeight) return;

            _lastTime = now;
            _lastWeight = weight;
            HostBridge.Send("haptics", "{\"type\":\"" + Name(type) + "\"}");
        }

        static int Weight(HapticType type) => type switch
        {
            HapticType.Selection => 0,
            HapticType.Light => 1,
            HapticType.Medium => 2,
            HapticType.Success => 3,
            HapticType.Warning => 3,
            HapticType.Heavy => 4,
            HapticType.Error => 5,
            _ => 0,
        };

        static string Name(HapticType type) => type switch
        {
            HapticType.Selection => "selection",
            HapticType.Light => "light",
            HapticType.Medium => "medium",
            HapticType.Heavy => "heavy",
            HapticType.Success => "success",
            HapticType.Warning => "warning",
            HapticType.Error => "error",
            _ => "light",
        };
    }
}
