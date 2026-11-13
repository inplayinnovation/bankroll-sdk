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

        /// <summary>How much pausing this round allows: unlimited (practice) unless <see cref="UsePaidPauseRules"/>.</summary>
        public PauseAllowance PauseAllowance { get; private set; } = PauseAllowance.Unlimited;

        /// <summary>Play is frozen: on the pause screen, or counting down to resume.</summary>
        public bool IsPaused { get; private set; }

        /// <summary>True during the 3-2-1 back to play.</summary>
        public bool IsResuming => _resumeAt >= 0;

        /// <summary>Seconds left in the 3-2-1, or 0.</summary>
        public float ResumeCountdown => IsResuming ? (float)Math.Max(0, _resumeAt - Now) : 0f;

        /// <summary>
        /// Real time, for pausing: it keeps running while the page is in the background, when Unity doesn't
        /// update at all, so time spent away from the app counts.
        /// </summary>
        public static double Now => Time.realtimeSinceStartupAsDouble;

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

        /// <summary>Play froze: show the pause screen, which hides the board.</summary>
        public event Action Paused;
        /// <summary>The 3-2-1 back to play began.</summary>
        public event Action Resuming;
        /// <summary>Play continues.</summary>
        public event Action Resumed;

        bool _startRequested;
        bool _continued;
        float _endedAt;
        double _resumeAt = -1;

        /// <summary>Gives the controller the Round that the game's simulation steps.</summary>
        public void Attach(Round round) => Round = round;

        /// <summary>Makes this a paid round: its pauses draw on the allowance in the settings file.</summary>
        public void UsePaidPauseRules() => PauseAllowance = new PauseAllowance(config.pauseAllowanceSeconds);

        /// <summary>Freezes play, during a round only. Pausing again during the 3-2-1 goes back to the pause screen.</summary>
        public void Pause()
        {
            if (Phase != RoundPhase.Playing) return;
            _resumeAt = -1;
            if (!IsPaused)
            {
                IsPaused = true;
                PauseAllowance.Pause(Now);
            }
            Paused?.Invoke();
        }

        /// <summary>Starts the 3-2-1 back to play.</summary>
        public void Resume()
        {
            if (!IsPaused || IsResuming) return;
            _resumeAt = Now + config.resumeCountdownSeconds;
            Resuming?.Invoke();
        }

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
            if (IsPaused)
            {
                UpdatePause();
                return;
            }

            bool tapped = Pointer.current != null && Pointer.current.press.wasPressedThisFrame;
            if (Phase == RoundPhase.WaitingToStart && (tapped || AutoStart))
                _startRequested = true;
            else if (Phase == RoundPhase.Ended && tapped && !_continued && Time.time - _endedAt >= config.continueDelaySeconds)
            {
                _continued = true; // one continue per round, however many taps
                Continue();
            }
        }

        void UpdatePause()
        {
            double now = Now;
            if (PauseAllowance.RanOut(now))
            {
                // A paid round out of pause time ends where it stands; the score so far counts.
                IsPaused = false;
                _resumeAt = -1;
                Round.End(RoundEndReason.PauseRanOut);
                EnterEnded();
                return;
            }
            if (IsResuming && now >= _resumeAt)
            {
                _resumeAt = -1;
                IsPaused = false;
                PauseAllowance.Resume(now);
                Resumed?.Invoke();
            }
        }

        void FixedUpdate()
        {
            if (IsPaused) return; // the round is frozen: no ticks, so the rules and the input log stand still

            if (Phase == RoundPhase.WaitingToStart && _startRequested)
            {
                Phase = RoundPhase.Playing;
                Started?.Invoke();
            }

            if (Phase == RoundPhase.Playing)
            {
                Tick?.Invoke();
                if (Round.Ended) EnterEnded();
            }
            else if (Phase == RoundPhase.Ended)
            {
                PostRoundTick?.Invoke();
            }
        }

        void EnterEnded()
        {
            Phase = RoundPhase.Ended;
            _endedAt = Time.time;
            Ended?.Invoke(Round.EndReason.Value);
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
