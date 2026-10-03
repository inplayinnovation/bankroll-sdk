using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>
    /// The object the page template addresses with <c>SendMessage("BankrollHost", "OnHostMessage", json)</c>.
    /// It is created before the first scene loads and lives for the whole session.
    /// </summary>
    [AddComponentMenu("")]
    public sealed class HostReceiver : MonoBehaviour
    {
        public const string ObjectName = "BankrollHost";

        [System.Serializable]
        sealed class Envelope
        {
            public string type;
            public string payload;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Create()
        {
            var host = new GameObject(ObjectName);
            DontDestroyOnLoad(host);
            host.AddComponent<HostReceiver>();
        }

        /// <summary>Called by the page template with {"type": ..., "payload": "&lt;json&gt;"}.</summary>
        public void OnHostMessage(string json)
        {
            var envelope = JsonUtility.FromJson<Envelope>(json);
            if (envelope == null || string.IsNullOrEmpty(envelope.type)) return;
            HostBridge.Receive(envelope.type, envelope.payload);
        }
    }
}
