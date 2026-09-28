using System;
using Bankroll.GameKit.Core;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace Bankroll.GameKit.Shell
{
    public enum RoundPhase { WaitingToStart, Playing, Ended }

    /// <summary>
    /// Runs one round on screen: Tap To Start, play on a fixed simulation clock, the end, then Tap To
    /// Continue. The rules themselves (the clock, the score, how the round ends) live in the game's plain C#
    /// simulation and its <see cref="Core.Round"/>, which the game attaches when <see cref="Prepared"/> fires.
    /// This class only turns taps and Unity's fixed updates into ticks, so the rules can also run without
    /// Unity: in tests, and on a server re-running a round.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public sealed class RoundController : MonoBehaviour
    {
        [SerializeField] GameConfigBase config;

        public RoundPhase Phase { get; private set; } = RoundPhase.WaitingToStart;

        /// <summary>The round's clock, score and ending, owned by the game's simulation.</summary>
        public Round Round { get; private set; }

        public RoundEndReason? EndReason => Round?.EndReason;
        public int Score => Round?.Score ?? 0;
        public ulong Seed { get; private set; }
        public GameConfigBase Config => config;

        /// <summary>Start the round without a tap (autoplay and automated tests).</summary>
        public bool AutoStart { get; set; }

        /// <summary>
        /// Raised once when the scene is ready, with the match seed. The game builds its simulation here,
        /// pre-generating everything from the seed, and calls <see cref="Attach"/> with its Round.
        /// </summary>
        public event Action<ulong> Prepared;
        public event Action Started;
        /// <summary>One fixed tick while playing. The game steps its simulation here.</summary>
        public event Action Tick;
        /// <summary>One fixed tick after the round has ended, for things that keep moving (e.g. bouncing balls).</summary>
        public event Action PostRoundTick;
        public event Action<RoundEndReason> Ended;
        /// <summary>
        /// The player tapped to continue after the round. A host link handles this (e.g. hands the result to the
        /// Bankroll app); with no listener, the round simply restarts.
        /// </summary>
        public event Action ContinueRequested;

        bool _startRequested;
        bool _continued;
        float _endedAt;

        /// <summary>Gives the controller the Round that the game's simulation steps.</summary>
        public void Attach(Round round) => Round = round;

        void Awake()
        {
            Time.fixedDeltaTime = 1f / config.simulationStepsPerSecond;
            Seed = config.devSeed != 0 ? (ulong)config.devSeed : (ulong)DateTime.UtcNow.Ticks;
#if UNITY_EDITOR
            // With the Editor in the background, nothing holds Play mode to the screen's refresh rate and it
            // spins at over 1,000 frames a second. Web builds follow the browser's frame rate instead.
            if (Application.targetFrameRate <= 0) Application.targetFrameRate = 60;
#endif
        }

        void Start()
        {
            Prepared?.Invoke(Seed);
            if (Round == null) Debug.LogError("RoundController: the game didn't attach a Round when Prepared fired.");
        }

        void Update()
        {
            bool tapped = Pointer.current != null && Pointer.current.press.wasPressedThisFrame;
            if (Phase == RoundPhase.WaitingToStart && (tapped || AutoStart))
                _startRequested = true;
            else if (Phase == RoundPhase.Ended && tapped && !_continued && Time.time - _endedAt >= config.continueDelaySeconds)
            {
                _continued = true; // one continue per round, however many taps
                Continue();
            }
        }

        void FixedUpdate()
        {
            if (Phase == RoundPhase.WaitingToStart && _startRequested)
            {
                Phase = RoundPhase.Playing;
                Started?.Invoke();
            }

            if (Phase == RoundPhase.Playing)
            {
                Tick?.Invoke();
                if (Round.Ended)
                {
                    Phase = RoundPhase.Ended;
                    _endedAt = Time.time;
                    Ended?.Invoke(Round.EndReason.Value);
                }
            }
            else if (Phase == RoundPhase.Ended)
            {
                PostRoundTick?.Invoke();
            }
        }

        void Continue()
        {
            if (ContinueRequested != null) ContinueRequested.Invoke();
            else Restart();
        }

        /// <summary>Starts a fresh round by reloading the scene.</summary>
        public void Restart() => SceneManager.LoadScene(SceneManager.GetActiveScene().name);
    }
}
