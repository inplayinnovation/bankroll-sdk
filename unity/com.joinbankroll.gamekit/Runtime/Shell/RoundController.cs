using System;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace Bankroll.GameKit.Shell
{
    public enum RoundPhase { WaitingToStart, Playing, Ended }

    public enum RoundEndReason { TimeUp, PlayerDied }

    /// <summary>
    /// Runs one round: Tap To Start, timed play on a fixed simulation clock, the end, then Tap To Continue.
    /// It owns the timer and the score. Games subscribe to its events and do all their gameplay in
    /// <see cref="Tick"/>, so everything happens in one ordered, repeatable loop.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public sealed class RoundController : MonoBehaviour
    {
        [SerializeField] GameConfigBase config;

        public RoundPhase Phase { get; private set; } = RoundPhase.WaitingToStart;
        public RoundEndReason? EndReason { get; private set; }
        public ulong Seed { get; private set; }
        public float TimeRemaining { get; private set; }
        public int Score { get; private set; }
        public GameConfigBase Config => config;
        public float ElapsedSeconds => config.roundDurationSeconds - TimeRemaining;

        /// <summary>Start the round without a tap (autoplay and automated tests).</summary>
        public bool AutoStart { get; set; }

        /// <summary>Raised once when the scene is ready, with the match seed. Pre-generate everything here.</summary>
        public event Action<ulong> Prepared;
        public event Action Started;
        /// <summary>One fixed simulation step while playing. Do all gameplay here.</summary>
        public event Action<float> Tick;
        /// <summary>One fixed step after the round has ended, for things that keep moving (e.g. bouncing balls).</summary>
        public event Action<float> PostRoundTick;
        public event Action<RoundEndReason> Ended;
        public event Action<int> ScoreChanged;

        bool _startRequested;
        float _endedAt;

        void Awake()
        {
            Time.fixedDeltaTime = 1f / config.simulationStepsPerSecond;
            TimeRemaining = config.roundDurationSeconds;
            Seed = config.devSeed != 0 ? (ulong)config.devSeed : (ulong)DateTime.UtcNow.Ticks;
        }

        void Start() => Prepared?.Invoke(Seed);

        void Update()
        {
            bool tapped = Pointer.current != null && Pointer.current.press.wasPressedThisFrame;
            if (Phase == RoundPhase.WaitingToStart && (tapped || AutoStart))
                _startRequested = true;
            else if (Phase == RoundPhase.Ended && tapped && Time.time - _endedAt >= config.continueDelaySeconds)
                Continue();
        }

        void FixedUpdate()
        {
            float dt = Time.fixedDeltaTime;
            if (Phase == RoundPhase.WaitingToStart && _startRequested)
            {
                Phase = RoundPhase.Playing;
                Started?.Invoke();
            }

            if (Phase == RoundPhase.Playing)
            {
                Tick?.Invoke(dt);
                if (Phase != RoundPhase.Playing) return; // the game ended the round during this step

                TimeRemaining = Mathf.Max(0f, TimeRemaining - dt);
                if (TimeRemaining <= 0f) EndRound(RoundEndReason.TimeUp);
            }
            else if (Phase == RoundPhase.Ended)
            {
                PostRoundTick?.Invoke(dt);
            }
        }

        /// <summary>Adds points during play.</summary>
        public void AddPoints(int points)
        {
            if (Phase != RoundPhase.Playing || points == 0) return;
            Score += points;
            ScoreChanged?.Invoke(Score);
        }

        /// <summary>Adds points once the round is over, e.g. a survival bonus.</summary>
        public void AddBonus(int points)
        {
            if (points == 0) return;
            Score += points;
            ScoreChanged?.Invoke(Score);
        }

        public void EndRound(RoundEndReason reason)
        {
            if (Phase != RoundPhase.Playing) return;
            Phase = RoundPhase.Ended;
            EndReason = reason;
            _endedAt = Time.time;
            Ended?.Invoke(reason);
        }

        void Continue()
        {
            // TODO(platform): report the final score to the host app instead of restarting.
            SceneManager.LoadScene(SceneManager.GetActiveScene().name);
        }
    }
}
