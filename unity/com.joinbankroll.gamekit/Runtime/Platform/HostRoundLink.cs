using System;
using Bankroll.GameKit.Core;
using Bankroll.GameKit.Shell;
using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>
    /// Connects a round to the Bankroll app. It sends "ready" once the game can be played, and "close" with
    /// the round's result when the player taps to continue, so the app can show the result screen. The app says
    /// whether the round is paid in the game page's address (<c>/game/index.html?mode=paid</c>), and a
    /// "pause" message (sent when the page is hidden, or by the app) freezes play. In the Editor (no app),
    /// continuing simply restarts the round.
    /// </summary>
    public sealed class HostRoundLink : MonoBehaviour
    {
        [SerializeField] RoundController round;

        [Serializable]
        sealed class Result
        {
            public int score;
            public string reason;
            public string seed;
            public string configVersion;
            public float secondsPlayed;
            public string inputs; // the round's InputLog, encoded: with the seed, a server replays the round
        }

        void OnEnable()
        {
            round.ContinueRequested += OnContinue;
            HostBridge.MessageReceived += OnMessage;
        }

        void OnDisable()
        {
            round.ContinueRequested -= OnContinue;
            HostBridge.MessageReceived -= OnMessage;
        }

        void Start()
        {
            if (QueryValue(Application.absoluteURL, "mode") == "paid") round.UsePaidPauseRules();
            HostBridge.Send("ready");
        }

        void OnMessage(string type, string payloadJson)
        {
            if (type == "pause") round.Pause();
        }

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
                reason = round.EndReason switch
                {
                    RoundEndReason.TimeUp => "time_up",
                    RoundEndReason.PauseRanOut => "pause_ran_out",
                    _ => "died",
                },
                seed = round.Seed.ToString(), // as text: a 64-bit seed doesn't fit a JavaScript number
                configVersion = round.Config.configVersion,
                secondsPlayed = round.Round.SecondsPlayed,
                inputs = round.Round.Inputs.Encode(),
            };
            HostBridge.Send("close", JsonUtility.ToJson(result));
        }

        /// <summary>A query parameter's value in a URL, or null.</summary>
        static string QueryValue(string url, string key)
        {
            int start = url?.IndexOf('?') ?? -1;
            if (start < 0) return null;
            int end = url.IndexOf('#', start);
            string query = end < 0 ? url.Substring(start + 1) : url.Substring(start + 1, end - start - 1);
            foreach (string pair in query.Split('&'))
            {
                int equals = pair.IndexOf('=');
                string name = equals < 0 ? pair : pair.Substring(0, equals);
                if (Uri.UnescapeDataString(name) == key)
                    return equals < 0 ? "" : Uri.UnescapeDataString(pair.Substring(equals + 1));
            }
            return null;
        }
    }
}
