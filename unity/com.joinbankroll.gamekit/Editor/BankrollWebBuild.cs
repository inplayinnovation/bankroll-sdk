using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Bankroll.GameKit.Editor
{
    /// <summary>
    /// The web build settings every Bankroll game uses, and a build straight into the Bankroll app's
    /// public/game/ folder (the Unity project lives in unity/ inside the app's repo).
    /// Menu: Bankroll > Build for Bankroll (Web).
    /// </summary>
    public static class BankrollWebBuild
    {
        /// <summary>Where the build goes, relative to the Unity project: the app's public/game/.</summary>
        public const string OutputPath = "../public/game";

        [MenuItem("Bankroll/Apply Web Build Settings")]
        public static void ApplySettings()
        {
            // The page template that bridges the game and the Bankroll app (Assets/WebGLTemplates/Bankroll).
            PlayerSettings.WebGL.template = "PROJECT:Bankroll";
            // Brotli files, served with Content-Encoding: br by the app (next.config.ts), so browsers
            // decompress natively and no JavaScript decompressor ships.
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
            PlayerSettings.WebGL.decompressionFallback = false;
            // Files named by their content's hash can be cached forever: a new build gets new names.
            PlayerSettings.WebGL.nameFilesAsHashes = true;
            PlayerSettings.WebGL.dataCaching = true;
            // WebGL 2 only. Mobile WebViews don't enable WebGPU, and leaving it out keeps the build smaller.
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.WebGL, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.WebGL, new[] { GraphicsDeviceType.OpenGLES3 });
        }

        /// <summary>Empties the output folder, after checking it really is inside the Bankroll app.</summary>
        public static string PrepareOutput()
        {
            string output = Path.GetFullPath(OutputPath);
            string appRoot = Path.GetFullPath(Path.Combine(OutputPath, "..", ".."));
            if (!File.Exists(Path.Combine(appRoot, "package.json")))
                throw new System.InvalidOperationException(
                    $"{appRoot} is not the Bankroll app's root (no package.json), so {output} will not be touched.");

            if (Directory.Exists(output)) Directory.Delete(output, recursive: true);
            Directory.CreateDirectory(output);
            return output;
        }

        [MenuItem("Bankroll/Build for Bankroll (Web)")]
        public static void Build()
        {
            ApplySettings();
            string output = PrepareOutput();
            string[] scenes = EditorBuildSettings.scenes.Where(scene => scene.enabled).Select(scene => scene.path).ToArray();
            var report = BuildPipeline.BuildPlayer(scenes, output, BuildTarget.WebGL, BuildOptions.None);
            Debug.Log($"[Bankroll] Web build {report.summary.result}: {report.summary.totalSize / (1024f * 1024f):F1} MB in {output}");
        }
    }
}
