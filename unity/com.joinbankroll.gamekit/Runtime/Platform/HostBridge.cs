using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>
    /// Messages between the game and the Bankroll app that hosts it. In a web build, <see cref="Send"/> goes
    /// through BankrollBridge.jslib to the page template's <c>window.bankrollBridge</c>, which posts it to the
    /// app; the app's replies arrive through <see cref="HostReceiver"/>. In the Editor there is no app, so
    /// messages go nowhere (optionally logged) and nothing arrives.
    /// </summary>
    public static class HostBridge
    {
        /// <summary>True in a web build, where the page template relays messages to the Bankroll app.</summary>
        public static bool IsWebBuild =>
#if UNITY_WEBGL && !UNITY_EDITOR
            true;
#else
            false;
#endif

        /// <summary>Log outgoing messages in the Editor. Off by default: haptics alone send several a second.</summary>
        public static bool LogInEditor;

        /// <summary>Raised for each message from the app, with its type and its payload as JSON (or null).</summary>
        public static event Action<string, string> MessageReceived;

        public static void Send(string type, string payloadJson = null)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            BankrollBridge_Send(type, payloadJson ?? "");
#else
            if (LogInEditor) Debug.Log($"[Bankroll app] {type} {payloadJson}");
#endif
        }

        internal static void Receive(string type, string payloadJson) => MessageReceived?.Invoke(type, payloadJson);

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")]
        static extern void BankrollBridge_Send(string type, string payloadJson);
#endif
    }
}
