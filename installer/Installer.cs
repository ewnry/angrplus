using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace AntigravityPlus.Installer
{
    class Program
    {
        internal static string resourcesPath;
        internal static string asarPath;
        internal static string backupPath;
        internal static string exePath;

        [STAThread]
        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.Title = "Antigravity+";

            LocateAntigravity();
            for (int i = 0; args != null && i + 1 < args.Length; i++)
                if (args[i] == "--resources") SetPaths(Path.GetFullPath(args[i + 1]));

            if (args != null && args.Length > 0)
            {
                string cmd = args[0].ToLowerInvariant();
                if (cmd == "--check")
                {
                    try { RunRuntimePatch("--check"); }
                    catch (Exception ex) { Console.Error.WriteLine(ex.Message); Environment.ExitCode = 1; }
                    return;
                }
                if (cmd == "--updating" || cmd == "--gui")
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new UpdateProgressForm());
                    return;
                }
                if (cmd == "--install" || cmd == "-i" || cmd == "/i" || cmd == "--silent")
                {
                    PerformInstall(silent: true, relaunch: false);
                    return;
                }
                if (cmd == "--status" || cmd == "-s")
                {
                    DrawBanner();
                    DrawStatus();
                    Console.WriteLine();
                    return;
                }
                if (cmd == "--restore" || cmd == "-r" || cmd == "/r")
                {
                    PerformRestore(silent: true);
                    return;
                }
            }

            RunMenuLoop();
        }

        internal static void LocateAntigravity()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string p1 = Path.Combine(localAppData, "Programs", "antigravity", "resources");
            if (Directory.Exists(p1) && File.Exists(Path.Combine(p1, "app.asar")))
            {
                SetPaths(p1);
                return;
            }

            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string p2 = Path.Combine(progFiles, "antigravity", "resources");
            if (Directory.Exists(p2) && File.Exists(Path.Combine(p2, "app.asar")))
            {
                SetPaths(p2);
                return;
            }

            string currentDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "resources");
            if (Directory.Exists(currentDir) && File.Exists(Path.Combine(currentDir, "app.asar")))
            {
                SetPaths(currentDir);
                return;
            }
        }

        private static void SetPaths(string resPath)
        {
            resourcesPath = resPath;
            asarPath = Path.Combine(resourcesPath, "app.asar");
            backupPath = Path.Combine(resourcesPath, "app.asar.vanilla_backup");
            exePath = Path.Combine(Path.GetDirectoryName(resourcesPath), "Antigravity.exe");
        }

        internal static bool CheckIsPatched(string filePath)
        {
            if (!File.Exists(filePath)) return false;
            try
            {
                using (FileStream fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    int readLen = (int)Math.Min(fs.Length, 400000);
                    byte[] buf = new byte[readLen];
                    int read = fs.Read(buf, 0, readLen);
                    string header = Encoding.UTF8.GetString(buf, 0, read);
                    return header.IndexOf("modelPatch", StringComparison.OrdinalIgnoreCase) >= 0 ||
                           header.IndexOf("customPreload", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private static Process[] InstallationProcesses()
        {
            var matches = new List<Process>();
            foreach (Process process in Process.GetProcessesByName("Antigravity"))
            {
                try { if (String.Equals(process.MainModule.FileName, exePath, StringComparison.OrdinalIgnoreCase)) matches.Add(process); }
                catch { }
            }
            return matches.ToArray();
        }

        private static bool IsAntigravityRunning()
        {
            try
            {
                return InstallationProcesses().Length > 0;
            }
            catch
            {
                return false;
            }
        }

        private static void RunMenuLoop()
        {
            while (true)
            {
                Console.Clear();
                DrawBanner();
                DrawStatus();
                DrawMenu();

                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.Write("\n  > ");
                Console.ForegroundColor = ConsoleColor.White;

                string input = Console.ReadLine();
                Console.ResetColor();

                if (input == null) break;
                input = input.Trim();

                if (input == "0" || input.Equals("exit", StringComparison.OrdinalIgnoreCase) || input.Equals("q", StringComparison.OrdinalIgnoreCase))
                {
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                    Console.WriteLine("\n  Exiting.");
                    Console.ResetColor();
                    Thread.Sleep(300);
                    break;
                }
                else if (input == "1")
                {
                    PerformInstall(silent: false);
                    Pause();
                }
                else if (input == "2")
                {
                    PerformRestore(silent: false);
                    Pause();
                }
                else if (input == "3")
                {
                    RestartAntigravity();
                    Pause();
                }
                else if (input == "4")
                {
                    OpenUrl("https://t.me/unixmk");
                }
            }
        }

        private static void DrawBanner()
        {
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("                ████         █    ");
            Console.WriteLine("              ████████      ███   ");
            Console.WriteLine("            ████████████ ████████ ");
            Console.WriteLine("           ██████████████   ███   ");
            Console.WriteLine("           ██████████████    █    ");
            Console.WriteLine("          ████████████████        ");
            Console.WriteLine("         ██████████████████       ");
            Console.WriteLine("         ██████████████████       ");
            Console.WriteLine("        ████████    ████████      ");
            Console.WriteLine("        ██████         █████      ");
            Console.WriteLine("       █████            █████     ");
            Console.WriteLine("      █████              █████    ");
            Console.WriteLine("     █████                █████   ");
            Console.WriteLine("   █████                    █████ ");
            Console.WriteLine("   ███                        ███ ");
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  Antigravity+");
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine("  Antigravity, but better. • by @unixmk");
            Console.ResetColor();
        }

        private static void DrawStatus()
        {
            Console.WriteLine();

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Status     ");
            if (string.IsNullOrEmpty(asarPath) || !File.Exists(asarPath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Not found");
            }
            else
            {
                bool isPatched = CheckIsPatched(asarPath);
                if (isPatched)
                {
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.Write("Patched");
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                    Console.WriteLine(" (Antigravity+ active)");
                }
                else
                {
                    Console.ForegroundColor = ConsoleColor.DarkYellow;
                    Console.Write("Vanilla");
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                    Console.WriteLine(" (original build)");
                }
            }

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Target     ");
            if (string.IsNullOrEmpty(resourcesPath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Not installed");
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.Gray;
                Console.WriteLine(Path.GetDirectoryName(resourcesPath));
            }

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Backup     ");
            if (File.Exists(backupPath))
            {
                Console.ForegroundColor = ConsoleColor.Gray;
                Console.Write("Available");
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine(" (app.asar.vanilla_backup)");
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine("None (created on first patch)");
            }

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Geo-Bypass ");
            string lsPath = !string.IsNullOrEmpty(resourcesPath) ? Path.Combine(resourcesPath, "bin", "language_server.exe") : null;
            if (CheckIsGeoPatched(lsPath))
            {
                Console.ForegroundColor = ConsoleColor.Green;
                Console.Write("Active");
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine(" (unsupported regions unblocked)");
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.DarkYellow;
                Console.Write("Vanilla");
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine(" (will patch on install)");
            }

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Process    ");
            bool running = IsAntigravityRunning();
            if (running)
            {
                Console.ForegroundColor = ConsoleColor.DarkYellow;
                Console.WriteLine("Running");
            }
            else
            {
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine("Stopped");
            }

            Console.ResetColor();
        }

        private static void DrawMenu()
        {
            bool isPatched = CheckIsPatched(asarPath);
            bool hasBackup = File.Exists(backupPath);

            Console.WriteLine();

            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.Write("  1  ");
            Console.ForegroundColor = ConsoleColor.White;
            if (isPatched)
            {
                Console.WriteLine("Reinstall / Update patch");
            }
            else
            {
                Console.WriteLine("Install Antigravity+");
            }

            Console.ForegroundColor = hasBackup ? ConsoleColor.Cyan : ConsoleColor.DarkGray;
            Console.Write("  2  ");
            Console.ForegroundColor = hasBackup ? ConsoleColor.Gray : ConsoleColor.DarkGray;
            Console.WriteLine(hasBackup ? "Restore vanilla backup" : "Restore vanilla backup (none found)");

            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.Write("  3  ");
            Console.ForegroundColor = ConsoleColor.Gray;
            Console.WriteLine("Restart Antigravity");

            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.Write("  4  ");
            Console.ForegroundColor = ConsoleColor.Gray;
            Console.WriteLine("Telegram (@unixmk)");

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  0  ");
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine("Exit");

            Console.ResetColor();
        }

        internal static bool EnsureClosed(bool silent = false)
        {
            Process[] procs = InstallationProcesses();
            if (procs.Length == 0) return true;

            if (!silent)
            {
                Console.ForegroundColor = ConsoleColor.DarkYellow;
                Console.Write("\n  Antigravity is currently running. Close it to proceed? [Y/n]: ");
                Console.ResetColor();

                string resp = Console.ReadLine();
                if (resp != null && resp.Trim().Equals("n", StringComparison.OrdinalIgnoreCase))
                {
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                    Console.WriteLine("  Operation canceled.");
                    Console.ResetColor();
                    return false;
                }
            }

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Closing Antigravity... ");

            foreach (Process p in procs)
            {
                try { p.CloseMainWindow(); } catch { }
            }

            for (int i = 0; i < 30; i++)
            {
                Thread.Sleep(100);
                if (InstallationProcesses().Length == 0) break;
            }

            foreach (Process p in InstallationProcesses())
            {
                try { p.Kill(); p.WaitForExit(3000); } catch { }
            }

            Thread.Sleep(500);
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("done");
            Console.ResetColor();
            return true;
        }

        private static void PerformInstall(bool silent, bool relaunch = false)
        {
            if (string.IsNullOrEmpty(resourcesPath) || !File.Exists(asarPath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n  Error: Antigravity installation not found.");
                Console.ResetColor();
                return;
            }

            try { RunRuntimePatch("--check"); }
            catch (Exception ex) { Console.Error.WriteLine(ex.Message); Environment.ExitCode = 1; return; }
            if (!EnsureClosed(silent)) { Environment.ExitCode = 1; return; }

            Console.WriteLine();

            try
            {
                if (File.Exists(asarPath) && (!File.Exists(backupPath) || ReadAsarVersion(backupPath) != ReadAsarVersion(asarPath)))
                {
                    if (CheckIsPatched(asarPath)) throw new InvalidOperationException("Clean backup for this Antigravity version is missing. Restore a clean vendor installation first.");
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                    Console.Write("  Creating backup... ");
                    File.Copy(asarPath, backupPath, true);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("done");
                }

                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.Write("  Applying patch... ");

                ApplyPatchWithRetry();

                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine("done");

                Console.WriteLine();
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine("  Antigravity+ installed successfully.");
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.ResetColor();

                if (relaunch && File.Exists(exePath))
                {
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("  Relaunching Antigravity...");
                    Console.ResetColor();
                    Process.Start(exePath);
                }
                else if (!silent && File.Exists(exePath))
                {
                    Console.ForegroundColor = ConsoleColor.Gray;
                    Console.Write("\n  Launch Antigravity now? [Y/n]: ");
                    Console.ResetColor();
                    string resp = Console.ReadLine();
                    if (resp == null || !resp.Trim().Equals("n", StringComparison.OrdinalIgnoreCase))
                    {
                        Process.Start(exePath);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("  Starting Antigravity...");
                        Console.ResetColor();
                    }
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n  Installation failed: " + ex.Message);
                Environment.ExitCode = 1;
                Console.ResetColor();
            }
        }

        private static void PerformRestore(bool silent)
        {
            if (!File.Exists(backupPath) && !Directory.Exists(Path.Combine(resourcesPath, ".antigravity-model-patch")))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n  Error: Vanilla backup file (app.asar.vanilla_backup) not found.");
                Console.ResetColor();
                return;
            }

            if (!silent)
            {
                Console.ForegroundColor = ConsoleColor.DarkYellow;
                Console.Write("\n  Restore original vanilla Antigravity? [y/N]: ");
                Console.ResetColor();
                string resp = Console.ReadLine();
                if (resp == null || !resp.Trim().Equals("y", StringComparison.OrdinalIgnoreCase))
                {
                    Console.ForegroundColor = ConsoleColor.DarkGray;
                    Console.WriteLine("  Restore canceled.");
                    Console.ResetColor();
                    return;
                }

                if (!EnsureClosed()) return;
            }

            if (silent && !EnsureClosed(true)) { Environment.ExitCode = 1; return; }
            try
            {
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.Write("\n  Restoring vanilla app.asar... ");
                if (Directory.Exists(Path.Combine(resourcesPath, ".antigravity-model-patch"))) RunRuntimePatch("--restore");
                else File.Copy(backupPath, asarPath, true);
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine("done");

                if (!Directory.Exists(Path.Combine(resourcesPath, ".antigravity-model-patch"))) RestoreLanguageServerGeoUnblock();

                Console.WriteLine();
                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine("  Antigravity restored to original vanilla state.");
                Console.ResetColor();

                if (!silent && File.Exists(exePath))
                {
                    Console.ForegroundColor = ConsoleColor.Gray;
                    Console.Write("\n  Launch Antigravity now? [Y/n]: ");
                    Console.ResetColor();
                    string resp = Console.ReadLine();
                    if (resp == null || !resp.Trim().Equals("n", StringComparison.OrdinalIgnoreCase))
                    {
                        Process.Start(exePath);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("  Starting Antigravity...");
                        Console.ResetColor();
                    }
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n  Restore failed: " + ex.Message);
                Console.ResetColor();
            }
        }

        private static void RestartAntigravity()
        {
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n  Error: Antigravity.exe not found.");
                Console.ResetColor();
                return;
            }

            EnsureClosed();

            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.Write("  Starting Antigravity... ");
            Process.Start(exePath);
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("done");
            Console.ResetColor();
        }

        private static void OpenUrl(string url)
        {
            try
            {
                Process.Start(url);
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine("\n  Opened " + url);
                Console.ResetColor();
                Thread.Sleep(500);
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n  Could not open URL: " + ex.Message);
                Console.ResetColor();
            }
        }

        private static void Pause()
        {
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine("\n  Press any key to continue...");
            Console.ResetColor();
            Console.ReadKey(true);
        }

        internal static void RunRuntimePatch(string action)
        {
            if (String.IsNullOrEmpty(resourcesPath) || !File.Exists(asarPath) || !File.Exists(exePath))
                throw new FileNotFoundException("Antigravity installation not found.");
            string temp = Path.Combine(Path.GetTempPath(), "antigravity-runtime-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("RuntimePatchZip"))
                {
                    if (resource == null) throw new InvalidDataException("Embedded compatibility tester is missing.");
                    using (var zip = new ZipArchive(resource, ZipArchiveMode.Read))
                    {
                        foreach (ZipArchiveEntry entry in zip.Entries)
                        {
                            string destination = Path.GetFullPath(Path.Combine(temp, entry.FullName));
                            if (!destination.StartsWith(temp + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidDataException("Invalid payload path.");
                            if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(destination); continue; }
                            Directory.CreateDirectory(Path.GetDirectoryName(destination));
                            using (Stream input = entry.Open())
                            using (Stream output = File.Create(destination)) input.CopyTo(output);
                        }
                    }
                }
                string script = Path.Combine(temp, "scripts", "deploy.mjs");
                var start = new ProcessStartInfo(exePath, "--no-warnings " + QuoteArgument(script) + " --resources " + QuoteArgument(resourcesPath) + (String.IsNullOrEmpty(action) ? "" : " " + action));
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
                start.EnvironmentVariables["ELECTRON_NO_ASAR"] = "1";
                start.EnvironmentVariables.Remove("NODE_OPTIONS");
                start.EnvironmentVariables.Remove("NODE_PATH");
                using (Process process = Process.Start(start))
                {
                    var output = new StringBuilder();
                    var errors = new StringBuilder();
                    process.OutputDataReceived += (sender, e) => { if (e.Data != null) output.AppendLine(e.Data); };
                    process.ErrorDataReceived += (sender, e) => { if (e.Data != null) errors.AppendLine(e.Data); };
                    process.BeginOutputReadLine(); process.BeginErrorReadLine();
                    if (!process.WaitForExit(120000))
                    {
                        if (action == "--check") { process.Kill(); throw new InvalidOperationException("Compatibility check timed out. No application files changed."); }

                        Console.WriteLine("Waiting for the patch transaction to finish...");
                        process.WaitForExit();
                    }
                    process.WaitForExit();
                    if (process.ExitCode != 0)
                    {
                        string detail = errors.ToString() + output.ToString();
                        if (detail.Contains("UNSUPPORTED_RUNTIME") || detail.Contains("UNSUPPORTED_LAYOUT") || detail.Contains("BINARY_NOT_SUPPORTED"))
                            throw new InvalidOperationException("This Antigravity version is too new or incompatible. Please wait for a patch update. No application files changed.\n" + detail);
                        throw new InvalidOperationException(detail);
                    }
                    if (action == "--check") Console.WriteLine("  Compatibility check passed.");
                }
            }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        private static string QuoteArgument(string value)
        {

            var text = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '\"') { text.Append('\\', slashes * 2 + 1); text.Append(c); }
                else { text.Append('\\', slashes); text.Append(c); }
                slashes = 0;
            }
            text.Append('\\', slashes * 2); text.Append('\"'); return text.ToString();
        }

        internal static void ApplyPatchWithRetry() { RunRuntimePatch(""); }

        internal static string ReadAsarVersion(string file)
        {
            using (var stream = File.OpenRead(file))
            using (var reader = new BinaryReader(stream))
            {
                if (reader.ReadUInt32() != 4) throw new InvalidDataException("Invalid ASAR: " + file);
                uint headerSize = reader.ReadUInt32();
                reader.ReadUInt32();
                uint jsonSize = reader.ReadUInt32();
                if (jsonSize > 64 * 1024 * 1024 || jsonSize + 8 > headerSize) throw new InvalidDataException("Invalid ASAR header");
                var parser = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
                var header = parser.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(reader.ReadBytes((int)jsonSize)));
                var files = (Dictionary<string, object>)header["files"];
                var entry = (Dictionary<string, object>)files["package.json"];
                long offset = Convert.ToInt64(entry["offset"]);
                int size = Convert.ToInt32(entry["size"]);
                if (size < 1 || size > 1024 * 1024 || 8L + headerSize + offset + size > stream.Length) throw new InvalidDataException("Invalid ASAR package.json");
                stream.Position = 8L + headerSize + offset;
                var package = parser.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(reader.ReadBytes(size)));
                string version = Convert.ToString(package["version"]);
                if (String.IsNullOrEmpty(version)) throw new InvalidDataException("Missing Antigravity version");
                return version;
            }
        }

        internal static bool CheckIsGeoPatched(string lsPath)
        {
            if (string.IsNullOrEmpty(lsPath) || !File.Exists(lsPath)) return false;
            try
            {
                using (FileStream fs = new FileStream(lsPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    byte[] buf = new byte[1048576];
                    int overlap = 0;
                    int read;
                    while ((read = fs.Read(buf, overlap, buf.Length - overlap)) > 0)
                    {
                        int total = overlap + read;
                        for (int i = 0; i <= total - 15; i++)
                        {
                            if (buf[i] == 0xC6 && buf[i + 1] == 0x40 && buf[i + 2] == 0x08 && buf[i + 3] == 0x01 &&
                                buf[i + 4] == 0x90 && buf[i + 5] == 0x90 &&
                                buf[i + 6] == 0x48 && buf[i + 7] == 0x8B &&
                                buf[i + 9] == 0x24 &&
                                buf[i + 11] == 0x48 && buf[i + 12] == 0x89 &&
                                buf[i + 14] == 0x60)
                            {
                                return true;
                            }
                        }
                        if (total >= 32)
                        {
                            Buffer.BlockCopy(buf, total - 32, buf, 0, 32);
                            overlap = 32;
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        internal static bool PatchLanguageServerGeoUnblock(out string message)
        {
            message = "";
            if (string.IsNullOrEmpty(resourcesPath))
            {
                message = "resources not set";
                return false;
            }

            string lsPath = Path.Combine(resourcesPath, "bin", "language_server.exe");
            if (!File.Exists(lsPath))
            {
                message = "language_server.exe not found";
                return false;
            }

            try
            {
                long foundOffset = -1;
                bool alreadyPatched = false;
                var gateOffsets = new HashSet<long>();

                using (FileStream fs = new FileStream(lsPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    byte[] buf = new byte[1048576];
                    int overlap = 0;
                    int read;
                    long streamPos = 0;

                    while ((read = fs.Read(buf, overlap, buf.Length - overlap)) > 0)
                    {
                        int total = overlap + read;
                        for (int i = 0; i <= total - 15; i++)
                        {
                            if (buf[i] == 0xC6 && buf[i + 1] == 0x40 && buf[i + 2] == 0x08 && buf[i + 3] == 0x01 &&
                                buf[i + 4] == 0x90 && buf[i + 5] == 0x90 &&
                                buf[i + 6] == 0x48 && buf[i + 7] == 0x8B &&
                                buf[i + 9] == 0x24 &&
                                buf[i + 11] == 0x48 && buf[i + 12] == 0x89 &&
                                buf[i + 14] == 0x60)
                            {
                                alreadyPatched = true;
                                gateOffsets.Add(streamPos + (i - overlap));
                            }

                            if (buf[i] == 0x80 && buf[i + 1] == 0x78 && buf[i + 2] == 0x08 && buf[i + 3] == 0x00 &&
                                buf[i + 4] == 0x74 &&
                                buf[i + 6] == 0x48 && buf[i + 7] == 0x8B &&
                                buf[i + 9] == 0x24 &&
                                buf[i + 11] == 0x48 && buf[i + 12] == 0x89 &&
                                buf[i + 14] == 0x60)
                            {
                                foundOffset = streamPos + (i - overlap);
                                gateOffsets.Add(foundOffset);
                            }
                        }

                        if (total >= 32)
                        {
                            Buffer.BlockCopy(buf, total - 32, buf, 0, 32);
                            overlap = 32;
                        }
                        streamPos = fs.Position;
                    }
                }

                if (gateOffsets.Count > 1)
                {
                    message = "Multiple gate signatures found; refusing an ambiguous binary patch.";
                    return false;
                }
                if (alreadyPatched)
                {
                    message = "already active";
                    return true;
                }

                if (foundOffset == -1)
                {
                    message = "pattern not found";
                    return false;
                }

                string bakPath = lsPath + ".agybak";

                File.Copy(lsPath, bakPath, true);

                byte[] patchBytes = new byte[] { 0xC6, 0x40, 0x08, 0x01, 0x90, 0x90 };
                for (int r = 0; r < 20; r++)
                {
                    try
                    {
                        using (FileStream fs = new FileStream(lsPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                        {
                            fs.Seek(foundOffset, SeekOrigin.Begin);
                            fs.Write(patchBytes, 0, patchBytes.Length);
                            fs.Flush();
                        }
                        message = "patched successfully";
                        return true;
                    }
                    catch
                    {
                        Thread.Sleep(250);
                    }
                }

                message = "write locked";
                return false;
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return false;
            }
        }

        internal static void RestoreLanguageServerGeoUnblock()
        {
            if (string.IsNullOrEmpty(resourcesPath)) return;
            string lsPath = Path.Combine(resourcesPath, "bin", "language_server.exe");
            string bakPath = lsPath + ".agybak";
            if (File.Exists(bakPath))
            {
                try
                {
                    File.Copy(bakPath, lsPath, true);
                }
                catch { }
            }
        }
    }

    public class UpdateProgressForm : Form
    {
        private Label lblTitle;
        private Label lblStatus;
        private ProgressBar progressBar;

        public UpdateProgressForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "Antigravity+ Updater";
            this.ClientSize = new Size(460, 160);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.TopMost = true;
            this.BackColor = Color.FromArgb(18, 18, 22);
            this.ForeColor = Color.FromArgb(244, 244, 245);
            this.ShowInTaskbar = true;

            lblTitle = new Label();
            lblTitle.Text = "Обновление Antigravity+";
            lblTitle.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(129, 140, 248);
            lblTitle.Location = new Point(24, 20);
            lblTitle.AutoSize = true;

            lblStatus = new Label();
            lblStatus.Text = "Подготовка к обновлению...";
            lblStatus.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblStatus.ForeColor = Color.FromArgb(212, 212, 216);
            lblStatus.Location = new Point(24, 52);
            lblStatus.Size = new Size(412, 22);

            progressBar = new ProgressBar();
            progressBar.Style = ProgressBarStyle.Marquee;
            progressBar.MarqueeAnimationSpeed = 25;
            progressBar.Location = new Point(24, 86);
            progressBar.Size = new Size(412, 14);

            this.Controls.Add(lblTitle);
            this.Controls.Add(lblStatus);
            this.Controls.Add(progressBar);

            this.Shown += (s, e) => StartUpdateThread();
        }

        private void SetStatus(string text)
        {
            if (this.InvokeRequired)
            {
                this.BeginInvoke(new Action<string>(SetStatus), text);
                return;
            }
            lblStatus.Text = text;
        }

        private void StartUpdateThread()
        {
            Thread t = new Thread(() =>
            {
                try
                {
                    SetStatus("Проверка совместимости Antigravity...");
                    Program.RunRuntimePatch("--check");
                    SetStatus("Ожидание закрытия процессов Antigravity...");
                    if (!Program.EnsureClosed(silent: true)) throw new IOException("Antigravity did not close.");

                    SetStatus("Поиск установки Antigravity...");
                    Program.LocateAntigravity();
                    if (string.IsNullOrEmpty(Program.resourcesPath) || !File.Exists(Program.asarPath))
                    {
                        throw new FileNotFoundException("Не найден файл установки Antigravity (app.asar).");
                    }

                    if (File.Exists(Program.asarPath) && (!File.Exists(Program.backupPath) || Program.ReadAsarVersion(Program.backupPath) != Program.ReadAsarVersion(Program.asarPath)))
                    {
                        if (Program.CheckIsPatched(Program.asarPath)) throw new InvalidOperationException("Clean backup for this Antigravity version is missing.");
                        SetStatus("Создание резервной копии оригинального app.asar...");
                        File.Copy(Program.asarPath, Program.backupPath, true);
                    }

                    SetStatus("Распаковка и установка патча Antigravity+...");
                    Program.ApplyPatchWithRetry();

                    SetStatus("Обновление успешно установлено! Запуск Antigravity...");
                    if (this.InvokeRequired)
                    {
                        this.Invoke(new Action(() =>
                        {
                            progressBar.Style = ProgressBarStyle.Blocks;
                            progressBar.Value = 100;
                        }));
                    }

                    Thread.Sleep(800);

                    if (File.Exists(Program.exePath))
                    {
                        Process.Start(Program.exePath);
                    }

                    if (this.InvokeRequired)
                    {
                        this.Invoke(new Action(() => this.Close()));
                    }
                    else
                    {
                        this.Close();
                    }
                }
                catch (Exception ex)
                {
                    if (this.InvokeRequired)
                    {
                        this.Invoke(new Action(() =>
                        {
                            MessageBox.Show(this,
                                "Не удалось завершить обновление Antigravity+:\n\n" + ex.Message,
                                "Antigravity+ Ошибка",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Error);
                            this.Close();
                        }));
                    }
                    else
                    {
                        MessageBox.Show(this,
                            "Не удалось завершить обновление Antigravity+:\n\n" + ex.Message,
                            "Antigravity+ Ошибка",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error);
                        this.Close();
                    }
                }
            });
            t.IsBackground = true;
            t.Start();
        }
    }
}
