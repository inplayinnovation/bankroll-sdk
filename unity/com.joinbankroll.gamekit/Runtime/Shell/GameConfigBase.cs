using UnityEngine;

namespace Bankroll.GameKit.Shell
{
    /// <summary>
    /// Base class for a game's ONE settings asset. Rule for every Bankroll game: all tunable numbers live
    /// in a single config asset derived from this class, never as magic numbers in code. The kit reads
    /// the round-level fields below; each game adds its own fields in its subclass.
    /// </summary>
    public abstract class GameConfigBase : ScriptableObject
    {
        [Header("Round")]
        [Tooltip("Length of a round, in seconds.")]
        [Min(1f)] public float roundDurationSeconds = 180f;

        [Tooltip("Seconds after the round ends before 'Tap To Continue' accepts a tap, so a late tap can't skip the result.")]
        [Min(0f)] public float continueDelaySeconds = 1f;

        [Header("Simulation")]
        [Tooltip("Fixed simulation steps per second. Gameplay runs on this fixed clock so a round is repeatable from its seed and inputs.")]
        [Range(30, 120)] public int simulationStepsPerSecond = 60;

        [Header("Versioning")]
        [Tooltip("Recorded with every match, so we know both players played the same numbers. Bump it whenever you change values for a release.")]
        public string configVersion = "0.1.0";

        [Header("Development")]
        [Tooltip("Seed used when no host provides one (Editor and local builds). 0 means a new random seed every round.")]
        public int devSeed;
    }
}
