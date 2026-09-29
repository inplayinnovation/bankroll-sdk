using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
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

        /// <summary>The page template that bridges the game and the Bankroll app.</summary>
        public const string TemplateName = "Bankroll";

        // The kit ships the template in a folder whose name ends in "~", which Unity ignores, and Unity only
        // reads templates from the project's Assets/WebGLTemplates, so a build copies it there.
        const string PackageTemplateFolder = "WebGLTemplates~";
        const string ProjectTemplateFolder = "Assets/WebGLTemplates";

        /// <summary>
        /// The template setting for the page's background, shown until the game draws: each game sets its own
        /// colour in Player settings. A project that has none gets <see cref="DefaultBackground"/>.
        /// </summary>
        public const string BackgroundSetting = "BANKROLL_BACKGROUND";
        public const string DefaultBackground = "#000000";

        [MenuItem("Bankroll/Apply Web Build Settings")]
        public static void ApplySettings()
        {
            // The page template that bridges the game and the Bankroll app, copied in from the kit.
            InstallTemplate();
            PlayerSettings.WebGL.template = "PROJECT:" + TemplateName;
            if (string.IsNullOrEmpty(PlayerSettings.GetTemplateCustomValue(BackgroundSetting)))
                PlayerSettings.SetTemplateCustomValue(BackgroundSetting, DefaultBackground);
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

        /// <summary>
        /// Copies the kit's page template into Assets/WebGLTemplates/Bankroll when the project's copy differs,
        /// so every game builds with the kit's current page. The project's copy is committed with the game.
        /// </summary>
        public static void InstallTemplate()
        {
            var package = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(BankrollWebBuild).Assembly);
            if (package == null)
                throw new System.InvalidOperationException("The Bankroll game kit is not installed as a package.");

            string source = Path.Combine(package.resolvedPath, PackageTemplateFolder, TemplateName);
            string target = Path.Combine(ProjectTemplateFolder, TemplateName);
            bool changed = false;
            foreach (string file in Directory.GetFiles(source))
            {
                string destination = Path.Combine(target, Path.GetFileName(file));
                if (File.Exists(destination) && File.ReadAllBytes(destination).SequenceEqual(File.ReadAllBytes(file)))
                    continue;
                Directory.CreateDirectory(target);
                File.Copy(file, destination, overwrite: true);
                changed = true;
            }
            if (changed) AssetDatabase.Refresh();
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
            // A failed build must fail loudly. In batch mode the exception ends Unity with a non-zero exit
            // code, so a script or the builder's runner sees it.
            if (report.summary.result != BuildResult.Succeeded)
                throw new System.InvalidOperationException($"Unity web build failed: {report.summary.result}");
        }
    }
}
