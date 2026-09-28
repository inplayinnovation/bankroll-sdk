using Bankroll.GameKit.Shell;
using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>
    /// Connects a round to the Bankroll app. It sends "ready" once the game can be played, and "close" with
    /// the round's result when the player taps to continue, so the app can show the result screen. In the
    /// Editor (no app), continuing simply restarts the round.
    /// </summary>
    public sealed class HostRoundLink : MonoBehaviour
    {
        [SerializeField] RoundController round;

        [System.Serializable]
        sealed class Result
        {
            public int score;
            public string reason;
            public string seed;
            public string configVersion;
            public float secondsPlayed;
        }

        void OnEnable() => round.ContinueRequested += OnContinue;

        void OnDisable() => round.ContinueRequested -= OnContinue;

        void Start() => HostBridge.Send("ready");

        void OnContinue()
        {
            if (!HostBridge.IsWebBuild)
            {
                round.Restart();
                return;
            }

            var result = new Result
            {
                score = round.Score,
                reason = round.EndReason == RoundEndReason.TimeUp ? "time_up" : "died",
                seed = round.Seed.ToString(), // as text: a 64-bit seed doesn't fit a JavaScript number
                configVersion = round.Config.configVersion,
                secondsPlayed = round.ElapsedSeconds,
            };
            HostBridge.Send("close", JsonUtility.ToJson(result));
        }
    }
}
