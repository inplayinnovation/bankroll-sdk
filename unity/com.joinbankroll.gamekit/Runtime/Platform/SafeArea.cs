using System;
using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>
    /// Where the HUD must stay clear of the notch, status bar, home indicator and the Bankroll app's bottom bar.
    /// In a web build the Bankroll app measures its safe-area insets and sends them in a "safe_area" message,
    /// because an iframe can't read CSS env() insets itself. Elsewhere Unity's own Screen.safeArea is used.
    /// </summary>
    public static class SafeArea
    {
        /// <summary>The latest insets from the app, in screen pixels: x left, y top, z right, w bottom.</summary>
        public static Vector4 Insets { get; private set; }

        public static event Action Changed;

        [Serializable]
        sealed class Payload
        {
            public float top;
            public float right;
            public float bottom;
            public float left;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void Listen()
        {
            Insets = Vector4.zero;
            HostBridge.MessageReceived -= OnMessage;
            HostBridge.MessageReceived += OnMessage;
        }

        static void OnMessage(string type, string json)
        {
            if (type != "safe_area" || string.IsNullOrEmpty(json)) return;
            var payload = JsonUtility.FromJson<Payload>(json);
            Insets = new Vector4(payload.left, payload.top, payload.right, payload.bottom);
            Changed?.Invoke();
        }

        /// <summary>The safe rectangle in screen pixels (origin at the bottom left, like Screen.safeArea).</summary>
        public static Rect Rect
        {
            get
            {
                if (!HostBridge.IsWebBuild) return Screen.safeArea;
                return new Rect(
                    Insets.x,
                    Insets.w,
                    Mathf.Max(0f, Screen.width - Insets.x - Insets.z),
                    Mathf.Max(0f, Screen.height - Insets.y - Insets.w));
            }
        }
    }
}
