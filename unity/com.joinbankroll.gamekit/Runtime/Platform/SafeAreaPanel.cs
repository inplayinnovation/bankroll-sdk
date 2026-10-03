using UnityEngine;

namespace Bankroll.GameKit.Platform
{
    /// <summary>
    /// Shrinks a UI panel to the safe area. Put the HUD inside it; the game world stays full screen behind.
    /// </summary>
    [ExecuteAlways, RequireComponent(typeof(RectTransform))]
    public sealed class SafeAreaPanel : MonoBehaviour
    {
        RectTransform _rect;
        Rect _applied;
        Vector2Int _screen;

        void OnEnable()
        {
            SafeArea.Changed += Apply;
            Apply();
        }

        void OnDisable() => SafeArea.Changed -= Apply;

        void Update()
        {
            if (_screen.x != Screen.width || _screen.y != Screen.height || _applied != SafeArea.Rect) Apply();
        }

        void Apply()
        {
            if (Screen.width <= 0 || Screen.height <= 0) return;
            if (_rect == null) _rect = (RectTransform)transform;

            var safe = SafeArea.Rect;
            _applied = safe;
            _screen = new Vector2Int(Screen.width, Screen.height);
            _rect.anchorMin = new Vector2(safe.xMin / Screen.width, safe.yMin / Screen.height);
            _rect.anchorMax = new Vector2(safe.xMax / Screen.width, safe.yMax / Screen.height);
            _rect.offsetMin = Vector2.zero;
            _rect.offsetMax = Vector2.zero;
        }
    }
}
