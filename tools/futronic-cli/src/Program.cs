using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FutronicCli;

internal static class Native
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool SetDllDirectoryA(string? lpPathName);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadLibraryW(string lpFileName);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandleW(string lpModuleName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTRInitialize();

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void FTRTerminate();

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTRSetParam(int id, int value);

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTRGetParam(int id, out int value);

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTRCaptureFrame(IntPtr hWnd, int arg2);

    [StructLayout(LayoutKind.Sequential)]
    public struct FTR_DATA
    {
        public uint dwSize;
        public IntPtr pData;
    }

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTREnroll(IntPtr hWnd, int purpose, ref FTR_DATA outTemplate);

    // 4to arg: muchos SDKs lo usan como out quality/int*
    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTREnrollX(IntPtr hWnd, int purpose, ref FTR_DATA outTemplate, out int quality);
}

internal static class Args
{
    public static Dictionary<string, string> Parse(string[] argv)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < argv.Length; i++)
        {
            var a = argv[i];
            if (!a.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = a.Substring(2);
            var val = (i + 1 < argv.Length && !argv[i + 1].StartsWith("--", StringComparison.Ordinal))
                ? argv[++i]
                : "true";
            map[key] = val;
        }
        return map;
    }

    public static int GetInt(Dictionary<string, string> map, string key, int def)
        => map.TryGetValue(key, out var v) && int.TryParse(v, out var n) ? n : def;

    public static string? GetStr(Dictionary<string, string> map, string key)
        => map.TryGetValue(key, out var v) ? v : null;
}

internal static class JsonOut
{
    public static void Print(object obj)
    {
        var json = JsonSerializer.Serialize(obj, new JsonSerializerOptions { WriteIndented = false });
        Console.WriteLine(json);
    }
}

internal sealed record CliResult(int ExitCode, object Payload);

internal static class WinFormsLoop
{
    public static CliResult RunOnUiThread(Func<IntPtr, CliResult> work, bool visible)
    {
        var tcs = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        var thread = new Thread(() =>
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using var form = new Form();
                if (visible)
                {
                    // Modo visible (similar a WorkedEx): por si el SDK requiere una ventana visible.
                    form.Text = "Futronic CLI";
                    form.ShowInTaskbar = true;
                    form.Opacity = 1;
                    form.Width = 520;
                    form.Height = 360;
                    form.StartPosition = FormStartPosition.CenterScreen;
                }
                else
                {
                    // Modo oculto (default).
                    form.ShowInTaskbar = false;
                    form.Opacity = 0;
                    form.Width = 1;
                    form.Height = 1;
                    form.StartPosition = FormStartPosition.Manual;
                    form.Left = -32000;
                    form.Top = -32000;
                }

                form.Load += (_, _) =>
                {
                    // Ejecutar en el hilo UI después de que exista el HWND.
                    form.BeginInvoke(new Action(() =>
                    {
                        try
                        {
                            var result = work(form.Handle);
                            tcs.TrySetResult(result);
                        }
                        catch (Exception ex)
                        {
                            tcs.TrySetResult(new CliResult(13, new { ok = false, stage = "exception", error = ex.Message, type = ex.GetType().FullName }));
                        }
                        finally
                        {
                            try { form.Close(); } catch { }
                        }
                    }));
                };

                Application.Run(form);
            }
            catch (Exception ex)
            {
                tcs.TrySetResult(new CliResult(13, new { ok = false, stage = "exception", error = ex.Message, type = ex.GetType().FullName }));
            }
        });

        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        return tcs.Task.GetAwaiter().GetResult();
    }
}

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        return Run(args);
    }

    private static int Run(string[] args)
    {
        if (args.Length == 0)
        {
            JsonOut.Print(new { ok = false, error = "Uso: futronic-cli enroll --dll C:\\FutronicSDK\\FTRAPI.dll --purpose 3" });
            return 2;
        }

        var cmd = args[0].Trim().ToLowerInvariant();
        var opt = Args.Parse(args.Skip(1).ToArray());

        var visible = Args.GetInt(opt, "visible", 0) != 0;
        var scanDiagnostics = Args.GetInt(opt, "scanDiagnostics", 0) != 0;

        // Modo aislado: ejecuta el comando real en un subproceso.
        // Esto evita que access violations (0xC0000005) tumben el proceso padre.
        var isolate = Args.GetInt(opt, "isolate", 0) != 0;
        var isolatedChild = Args.GetInt(opt, "isolatedChild", 0) != 0;
        if (isolate && !isolatedChild)
        {
            var selfExe = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(selfExe) && File.Exists(selfExe))
            {
                try
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = selfExe,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true,
                    };

                    // Re-enviar args, pero quitando --isolate y --isolatedChild, y agregando --isolatedChild 1.
                    for (int i = 0; i < args.Length; i++)
                    {
                        var a = args[i];
                        if (string.Equals(a, "--isolate", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(a, "--isolatedChild", StringComparison.OrdinalIgnoreCase))
                        {
                            // saltar también el valor si existe
                            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)) i++;
                            continue;
                        }
                        psi.ArgumentList.Add(a);
                    }
                    psi.ArgumentList.Add("--isolatedChild");
                    psi.ArgumentList.Add("1");

                    using var p = Process.Start(psi);
                    if (p == null)
                    {
                        JsonOut.Print(new { ok = false, stage = "isolate", error = "No se pudo iniciar el subproceso" });
                        return 127;
                    }

                    var stdout = p.StandardOutput.ReadToEnd();
                    var stderr = p.StandardError.ReadToEnd();
                    p.WaitForExit();

                    var crashed = p.ExitCode == unchecked((int)0xC0000005);
                    if (crashed)
                    {
                        JsonOut.Print(new
                        {
                            ok = false,
                            stage = "crash",
                            crashed = true,
                            exitCode = p.ExitCode,
                            hint = "El SDK causó 0xC0000005 (access violation) en el proceso hijo. Usa la salida stderr/stdout para diagnóstico.",
                            stdout = string.IsNullOrWhiteSpace(stdout) ? null : stdout.Trim(),
                            stderr = string.IsNullOrWhiteSpace(stderr) ? null : stderr.Trim(),
                        });
                        return 125;
                    }

                    // Si el hijo ya imprimió JSON, reenviarlo tal cual.
                    if (!string.IsNullOrWhiteSpace(stdout))
                    {
                        Console.WriteLine(stdout.TrimEnd());
                        return p.ExitCode;
                    }

                    JsonOut.Print(new
                    {
                        ok = false,
                        stage = "isolate",
                        error = "El subproceso no devolvió salida",
                        exitCode = p.ExitCode,
                        stderr = string.IsNullOrWhiteSpace(stderr) ? null : stderr.Trim(),
                    });
                    return p.ExitCode != 0 ? p.ExitCode : 124;
                }
                catch (Exception ex)
                {
                    JsonOut.Print(new { ok = false, stage = "isolate", error = ex.Message, type = ex.GetType().FullName });
                    return 127;
                }
            }
        }

        // Comandos que NO requieren --dll (solo utilidades de CLI)
        if (cmd == "help" || cmd == "--help" || cmd == "-h" || cmd == "/?")
        {
            JsonOut.Print(new
            {
                ok = true,
                stage = "help",
                commands = new[] { "about", "help", "peexports", "scanimage", "scanframe", "capture", "enroll", "mtinit", "mtinit-probe" },
                notes = new[]
                {
                    "Los comandos enroll/capture/mt* requieren --dll (FTRAPI.dll).",
                    "peexports/about/help NO requieren --dll.",
                    "scanimage NO requiere --dll (solo --scanDll).",
                    "Si ves 'Falta --dll' al correr peexports, estás ejecutando un .exe viejo: vuelve a publicar win-x86."
                }
            });
            return 0;
        }

        if (cmd == "about")
        {
            var asm = typeof(Program).Assembly;
            var ver = asm.GetName().Version?.ToString();
            var loc = asm.Location;
            JsonOut.Print(new
            {
                ok = true,
                stage = "about",
                name = asm.GetName().Name,
                version = ver,
                location = string.IsNullOrWhiteSpace(loc) ? null : loc,
                is64Process = Environment.Is64BitProcess,
                framework = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
                os = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
                commands = new[] { "about", "help", "peexports", "scanimage", "scanframe", "capture", "enroll", "mtinit", "mtinit-probe" }
            });
            return 0;
        }

        // Comando scanimage: usa SOLO ftrScanAPI.dll para capturar imagen (sin FTRAPI.dll).
        // Requiere: --scanDll C:\\FutronicSDK\\ftrScanAPI.dll
        // Opcionales:
        //   --tries 10 --waitMs 200 --buf 153600 --copy 1
        if (cmd == "scanimage")
        {
            var scanDllPathOnly = Args.GetStr(opt, "scanDll");
            if (string.IsNullOrWhiteSpace(scanDllPathOnly) || !File.Exists(scanDllPathOnly))
            {
                JsonOut.Print(new { ok = false, stage = "scanImage", error = "Falta --scanDll o no existe", scanDll = scanDllPathOnly });
                return 2;
            }

            var scanDir = Path.GetDirectoryName(scanDllPathOnly);
            if (!string.IsNullOrWhiteSpace(scanDir))
            {
                Native.SetDllDirectoryA(scanDir);
                try { Environment.CurrentDirectory = scanDir; } catch { }
            }

            IntPtr scanModule = Native.LoadLibraryW(scanDllPathOnly);
            if (scanModule == IntPtr.Zero)
            {
                var err = Marshal.GetLastWin32Error();
                JsonOut.Print(new { ok = false, stage = "loadLibrary", error = "No se pudo cargar ftrScanAPI.dll", scanDll = scanDllPathOnly, win32 = err, is64Process = Environment.Is64BitProcess });
                return 9;
            }

            var open = TryGetProc<ftrScanOpenDeviceDelegate>(scanModule, "ftrScanOpenDevice")
                       ?? TryGetProc<ftrScanOpenDeviceDelegate>(scanModule, "FTRScanOpenDevice");
            var close = TryGetProc<ftrScanCloseDeviceDelegate>(scanModule, "ftrScanCloseDevice")
                        ?? TryGetProc<ftrScanCloseDeviceDelegate>(scanModule, "FTRScanCloseDevice");

            var getImageSize = TryGetProc<ftrScanGetImageSizeDelegate>(scanModule, "ftrScanGetImageSize");
            var getImage2 = TryGetProc<ftrScanGetImage2Delegate>(scanModule, "ftrScanGetImage2");
            var getLastErrCdecl = TryGetProc<ftrScanGetLastErrorCdeclDelegate>(scanModule, "ftrScanGetLastError");

            if (open == null || close == null)
            {
                JsonOut.Print(new { ok = false, stage = "scanImage", error = "No se encontró ftrScanOpenDevice/ftrScanCloseDevice", scanDll = scanDllPathOnly });
                return 14;
            }
            if (getImageSize == null || getImage2 == null)
            {
                JsonOut.Print(new
                {
                    ok = false,
                    stage = "scanImage",
                    error = "No se encontró ftrScanGetImageSize o ftrScanGetImage2 (revisa exports)",
                    hasGetImageSize = getImageSize != null,
                    hasGetImage2 = getImage2 != null,
                    scanDll = scanDllPathOnly
                });
                return 14;
            }

            var tries = Args.GetInt(opt, "tries", 10);
            var waitMs = Args.GetInt(opt, "waitMs", 200);
            var bufSizeOverride = Args.GetInt(opt, "buf", 0);
            var copy = Args.GetInt(opt, "copy", 0) != 0;

            IntPtr dev = IntPtr.Zero;
            try
            {
                dev = open();
                if (dev == IntPtr.Zero)
                {
                    int? le = null;
                    try { if (getLastErrCdecl != null) le = getLastErrCdecl(); } catch { }
                    JsonOut.Print(new { ok = false, stage = "scanOpen", error = "ftrScanOpenDevice devolvió NULL", scanDll = scanDllPathOnly, lastError = le });
                    return 14;
                }

                var attempts = new List<object>();
                for (int i = 0; i < Math.Max(1, tries); i++)
                {
                    var p = new FTRSCAN_FRAME_PARAMETERS { nWidth = 0, nHeight = 0, nImageSize = 0, nResolution = 0 };
                    int rSize;
                    int? leSize = null;
                    try { rSize = getImageSize(dev, ref p); } catch { rSize = -9999; }
                    try { if (getLastErrCdecl != null) leSize = getLastErrCdecl(); } catch { }

                    int bufferSize;
                    if (bufSizeOverride > 0) bufferSize = bufSizeOverride;
                    else if (p.nImageSize > 0) bufferSize = p.nImageSize;
                    else if (p.nWidth > 0 && p.nHeight > 0) bufferSize = checked(p.nWidth * p.nHeight);
                    else bufferSize = 153600;

                    IntPtr unmanaged = IntPtr.Zero;
                    int rImg;
                    int? leImg = null;
                    int copied = 0;
                    string? imageB64 = null;
                    string? copyWarning = null;
                    string? copyError = null;

                    try
                    {
                        unmanaged = Marshal.AllocHGlobal(bufferSize);
                        rImg = getImage2(dev, unmanaged, ref p);
                        try { if (getLastErrCdecl != null) leImg = getLastErrCdecl(); } catch { }

                        if (copy && rImg != 0)
                        {
                            long desired = p.nImageSize > 0 ? p.nImageSize : (p.nWidth > 0 && p.nHeight > 0 ? (long)p.nWidth * (long)p.nHeight : 0);
                            if (desired <= 0) copyWarning = "No se pudo inferir tamaño de imagen";
                            else if (desired > bufferSize) copyWarning = $"Tamaño reportado ({desired}) excede buffer ({bufferSize}); no se copia.";
                            else
                            {
                                copied = (int)desired;
                                try
                                {
                                    var managed = new byte[copied];
                                    Marshal.Copy(unmanaged, managed, 0, copied);
                                    imageB64 = Convert.ToBase64String(managed);
                                }
                                catch (Exception ex)
                                {
                                    copyError = ex.Message;
                                    imageB64 = null;
                                    copied = 0;
                                }
                            }
                        }
                    }
                    finally
                    {
                        if (unmanaged != IntPtr.Zero) Marshal.FreeHGlobal(unmanaged);
                    }

                    attempts.Add(new
                    {
                        i,
                        rSize,
                        lastErrorSize = leSize,
                        rImg,
                        lastErrorImg = leImg,
                        width = p.nWidth,
                        height = p.nHeight,
                        imageSize = p.nImageSize,
                        resolution = p.nResolution,
                        bufferSize,
                        copy,
                        copied,
                        copyWarning,
                        copyError,
                        imageB64
                    });

                    if (rImg != 0 && p.nWidth > 0 && p.nHeight > 0)
                        break;

                    Thread.Sleep(Math.Max(0, waitMs));
                }

                JsonOut.Print(new { ok = true, stage = "scanImage", scanDll = scanDllPathOnly, attempts });
                return 0;
            }
            finally
            {
                if (dev != IntPtr.Zero)
                {
                    try { close(dev); } catch { }
                }
            }
        }

        // Comando peexports: no requiere --dll ni cargar DLLs.
        if (cmd == "peexports")
        {
            var pePath = Args.GetStr(opt, "pe");
            var filter = Args.GetStr(opt, "filter");
            var max = Args.GetInt(opt, "max", 2000);

            if (string.IsNullOrWhiteSpace(pePath) || !File.Exists(pePath))
            {
                JsonOut.Print(new { ok = false, stage = "peexports", error = "Falta --pe o no existe", pe = pePath });
                return 2;
            }

            try
            {
                var info = PeExports.Read(pePath, filter, max);
                JsonOut.Print(new { ok = true, stage = "peexports", pe = pePath, arch = info.Arch, exports = info.Exports });
                return 0;
            }
            catch (Exception ex)
            {
                JsonOut.Print(new { ok = false, stage = "peexports", pe = pePath, error = ex.Message, type = ex.GetType().FullName });
                return 13;
            }
        }

        var dllPath = Args.GetStr(opt, "dll");
        if (string.IsNullOrWhiteSpace(dllPath))
        {
            JsonOut.Print(new { ok = false, error = "Falta --dll (ruta a FTRAPI.dll)" });
            return 2;
        }

        if (!File.Exists(dllPath))
        {
            JsonOut.Print(new { ok = false, stage = "args", error = "No existe el archivo --dll", dll = dllPath });
            return 2;
        }

        var dllDir = Path.GetDirectoryName(dllPath);
        if (string.IsNullOrWhiteSpace(dllDir))
        {
            JsonOut.Print(new { ok = false, stage = "args", error = "No se pudo obtener el directorio de --dll", dll = dllPath });
            return 2;
        }

        // IMPORTANTÍSIMO: muchos SDKs cargan dependencias relativas al CurrentDirectory.
        // WorkedEx normalmente corre desde el folder del SDK.
        var oldCwd = Environment.CurrentDirectory;
        Environment.CurrentDirectory = dllDir;

        var noLoadLibrary = Args.GetInt(opt, "noLoadLibrary", 0) != 0;
        var handleMode = (Args.GetStr(opt, "handle") ?? "hwnd").Trim().ToLowerInvariant();

        // Preferimos cargar por ruta completa para evitar que el proceso termine usando otra copia en PATH,
        // pero permitimos desactivar esto para diagnosticar.
        Native.SetDllDirectoryA(dllDir);
        IntPtr ftrModule = IntPtr.Zero;
        if (!noLoadLibrary)
        {
            ftrModule = Native.LoadLibraryW(dllPath);
            if (ftrModule == IntPtr.Zero)
            {
                var err = Marshal.GetLastWin32Error();
                JsonOut.Print(new
                {
                    ok = false,
                    stage = "loadLibrary",
                    error = "No se pudo cargar FTRAPI.dll",
                    dll = dllPath,
                    dllDir,
                    win32 = err,
                    is64Process = Environment.Is64BitProcess,
                    is64OS = Environment.Is64BitOperatingSystem,
                    hint = err == 193
                        ? "win32=193 suele ser mismatch x86/x64. Publica win-x86 o usa un FTRAPI.dll x64. Puedes probar --noLoadLibrary 1 para fallback."
                        : null
                });
                Environment.CurrentDirectory = oldCwd;
                return 9;
            }
        }
        else
        {
            // Intentar obtener el módulo ya cargado (si el loader lo resolvió por PATH).
            ftrModule = Native.GetModuleHandleW("FTRAPI.dll");
        }

        // Opcionalmente cargar ftrScanAPI.dll para obtener un handle de dispositivo.
        // Esto puede ser necesario en algunos SDK/builds para que Enroll funcione.
        var scanDllPath = Args.GetStr(opt, "scanDll");
        IntPtr scanModule = IntPtr.Zero;
        if (!string.IsNullOrWhiteSpace(scanDllPath))
        {
            if (!File.Exists(scanDllPath))
            {
                JsonOut.Print(new { ok = false, stage = "args", error = "No existe --scanDll", scanDll = scanDllPath });
                Environment.CurrentDirectory = oldCwd;
                return 2;
            }

            var scanDir = Path.GetDirectoryName(scanDllPath);
            if (!string.IsNullOrWhiteSpace(scanDir))
            {
                // Asegurar dependencias del scan DLL
                Native.SetDllDirectoryA(scanDir);
            }

            scanModule = Native.LoadLibraryW(scanDllPath);
            if (scanModule == IntPtr.Zero)
            {
                var err = Marshal.GetLastWin32Error();
                JsonOut.Print(new { ok = false, stage = "loadLibrary", error = "No se pudo cargar ftrScanAPI.dll", scanDll = scanDllPath, win32 = err });
                Environment.CurrentDirectory = oldCwd;
                return 9;
            }
        }

        // Opcionalmente usar API MT* si el SDK lo requiere.
        // Nota: MT* es experimental porque la firma puede variar entre SDKs.
        // Para evitar crashes por mismatch, NO hacemos fallback automático.
        var apiRequested = (Args.GetStr(opt, "api") ?? "ftr").Trim().ToLowerInvariant();

        // MT* (según dump-exports):
        // - MTInitialize stdcallArgBytes=4  => 1 arg (int)
        // - MTTerminate  stdcallArgBytes=4  => 1 arg (int)
        // - MTCaptureFrame stdcallArgBytes=12 => 3 args
        // - MTEnrollX stdcallArgBytes=20 => 5 args
        var mtInit = TryGetProc<MTInitDelegate>(ftrModule, "MTInitialize");
        var mtTerm = TryGetProc<MTTerminateDelegate>(ftrModule, "MTTerminate");
        var mtEnrollX = TryGetProc<MTEnrollXDelegate>(ftrModule, "MTEnrollX");
        var mtCapture = TryGetProc<MTCaptureDelegate>(ftrModule, "MTCaptureFrame");

        var hasMt = mtInit != null && mtTerm != null && mtEnrollX != null;

        bool mtInitialized = false;

        // Para mt-scan: MTInitialize se hace después de abrir el scan device.
        bool mtInitDeferred = apiRequested == "mt-scan";
        int mtInitDeferredCode = 0;

        int init;
        string apiInitUsed;
        var mtInitArg = Args.GetInt(opt, "mtInitArg", 0);
        var mtTermArg = Args.GetInt(opt, "mtTermArg", 0);
        var mtCaptureArg3 = Args.GetInt(opt, "mtCaptureArg3", 0);
        var mtEnrollArg5 = Args.GetInt(opt, "mtEnrollArg5", 0);
        var mtUseInitArgForCtx = Args.GetInt(opt, "mtUseInitArgForCtx", 1) != 0;

        bool mtInitArgExplicit = opt.ContainsKey("mtInitArg");
        bool mtTermArgExplicit = opt.ContainsKey("mtTermArg");
        bool mtCaptureArg3Explicit = opt.ContainsKey("mtCaptureArg3");
        bool mtEnrollArg5Explicit = opt.ContainsKey("mtEnrollArg5");

        if (apiRequested == "mt")
        {
            if (!hasMt)
            {
                JsonOut.Print(new { ok = false, stage = "init", error = "Se pidió --api mt pero no hay exports MT*", hasMt, apiRequested });
                Environment.CurrentDirectory = oldCwd;
                return 10;
            }
            init = mtInit!(mtInitArg);
            apiInitUsed = "mt";
            mtInitialized = true;
        }
        else if (apiRequested == "mt-scan")
        {
            // Diferimos MTInitialize hasta tener scanHandle.
            // Inicializamos la API base (FTRInitialize) para que el módulo esté listo.
            init = Native.FTRInitialize();
            apiInitUsed = "ftr";
        }
        else
        {
            init = Native.FTRInitialize();
            apiInitUsed = "ftr";
        }
        if (init != 0)
        {
            JsonOut.Print(new { ok = false, stage = "init", code = init, api = apiInitUsed, apiRequested, hasMt, is64Process = Environment.Is64BitProcess, is64OS = Environment.Is64BitOperatingSystem });
            Environment.CurrentDirectory = oldCwd;
            return 10;
        }

        try
        {
            if (cmd != "enroll" && cmd != "capture" && cmd != "mtinit" && cmd != "mtinit-probe" && cmd != "scanframe")
            {
                JsonOut.Print(new { ok = false, error = $"Comando no soportado: {cmd}" });
                return 2;
            }

            var purpose = Args.GetInt(opt, "purpose", 3);
            var captureArg2 = Args.GetInt(opt, "captureArg2", 0);
            var doPreCapture = Args.GetInt(opt, "preCapture", 0) != 0;
            var useNullHwnd = Args.GetInt(opt, "nullHwnd", 0) != 0;
            var method = (Args.GetStr(opt, "method") ?? "enrollx").Trim().ToLowerInvariant();

            // Debug/diagnóstico (para comparar con WorkedEx)
            var dumpParams = Args.GetInt(opt, "dumpParams", 0) != 0;
            var captureLoop = Args.GetInt(opt, "captureLoop", 0) != 0;
            var captureLoopMax = Args.GetInt(opt, "captureLoopMax", 40);
            var captureLoopDelayMs = Args.GetInt(opt, "captureLoopDelayMs", 150);
            var captureArg2Mode = (Args.GetStr(opt, "captureArg2Mode") ?? "purpose").Trim().ToLowerInvariant();
            var captureRequireOk = Args.GetInt(opt, "captureRequireOk", 0) != 0;

            // scanframe: captura de imagen cruda usando ftrScanGetFrame
            // Defaults típicos: 320x480x1 = 153600 bytes
            var frameBufSize = Args.GetInt(opt, "frameBuf", 153600);
            var frameTries = Args.GetInt(opt, "frameTries", 10);
            var frameWaitMs = Args.GetInt(opt, "frameWaitMs", 150);
            var frameCopy = Args.GetInt(opt, "frameCopy", 0) != 0;
            var scanCallConv = (Args.GetStr(opt, "scanCallConv") ?? "stdcall").Trim().ToLowerInvariant();

            var probeCapture = Args.GetInt(opt, "probeCapture", 0) != 0;
            var probeKeep = Args.GetInt(opt, "probeKeep", 0) != 0;
            var probeOncePerValue = Args.GetInt(opt, "probeOncePerValue", 1);

            var bufSize = Args.GetInt(opt, "buf", 6144);
            var buf = new byte[bufSize];
            var pinned = GCHandle.Alloc(buf, GCHandleType.Pinned);

            try
            {
                var data = new Native.FTR_DATA
                {
                    dwSize = (uint)buf.Length,
                    pData = pinned.AddrOfPinnedObject()
                };

                // Permitir setear params desde CLI: --param 4=1 --param 5=0
                var rawParams = CollectMultiArgs(args, "--param", "--setparam");
                var parsedParams = ParseParams(rawParams);

                // Para mt-scan: lista de intentos para MTInitialize.
                // Ej: --mtInitTry 0,1,2,3 o repetir: --mtInitTry 0 --mtInitTry 1
                var mtInitTryRaw = CollectMultiArgs(args, "--mtInitTry");
                var mtInitTry = new List<int>();
                foreach (var token in mtInitTryRaw)
                {
                    foreach (var part in token.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        if (int.TryParse(part, out var n)) mtInitTry.Add(n);
                    }
                }

                // Permitir especificar qué ids dumpear: --dumpParamId 4 --dumpParamId 5
                var dumpParamIdRaw = CollectMultiArgs(args, "--dumpParamId");
                var dumpParamIds = dumpParamIdRaw
                    .Select((s) => int.TryParse(s, out var n) ? (int?)n : null)
                    .Where((n) => n.HasValue)
                    .Select((n) => n!.Value)
                    .ToList();
                if (!dumpParamIds.Any()) dumpParamIds = Enumerable.Range(0, 21).ToList();

                var result = WinFormsLoop.RunOnUiThread(hwndFromUi =>
                {
                    var hwnd = useNullHwnd ? IntPtr.Zero : hwndFromUi;

                    // Determinar handle a usar en la API: hwnd (default) o handle de dispositivo.
                    IntPtr apiHandle = hwnd;
                    IntPtr scanHandle = IntPtr.Zero;
                    object? scanInfo = null;
                    ftrScanCloseDeviceDelegate? scanClose = null;

                    // Modos soportados:
                    // - hwnd: pasar HWND a FTR*.
                    // - scan: pasar handle de dispositivo a FTR*.
                    // - hwnd+scan: abrir dispositivo (scan) pero pasar HWND a FTR*.
                    var wantsScanOpen = handleMode == "scan" || handleMode == "hwnd+scan" || handleMode == "hwndscan";

                    if (wantsScanOpen)
                    {
                        // Resolver ftrScanOpenDevice/ftrScanCloseDevice desde scanDll (si está) o desde FTRAPI.
                        var open = TryGetProc<ftrScanOpenDeviceDelegate>(scanModule, "ftrScanOpenDevice")
                                   ?? TryGetProc<ftrScanOpenDeviceDelegate>(scanModule, "FTRScanOpenDevice")
                                   ?? TryGetProc<ftrScanOpenDeviceDelegate>(IntPtr.Zero, "ftrScanOpenDevice")
                                   ?? TryGetProc<ftrScanOpenDeviceDelegate>(IntPtr.Zero, "FTRScanOpenDevice");

                        var close = TryGetProc<ftrScanCloseDeviceDelegate>(scanModule, "ftrScanCloseDevice")
                                    ?? TryGetProc<ftrScanCloseDeviceDelegate>(scanModule, "FTRScanCloseDevice")
                                    ?? TryGetProc<ftrScanCloseDeviceDelegate>(IntPtr.Zero, "ftrScanCloseDevice")
                                    ?? TryGetProc<ftrScanCloseDeviceDelegate>(IntPtr.Zero, "FTRScanCloseDevice");

                        if (open == null)
                        {
                            return new CliResult(14, new { ok = false, stage = "scanOpen", error = "No se encontró ftrScanOpenDevice (usa --scanDll o revisa el SDK)", handleMode });
                        }

                        scanHandle = open();
                        // Nota: algunas combinaciones de SDK/driver pueden devolver handles que no son seguros
                        // para usar con otras funciones ftrScan* (provocando 0xC0000005). Por eso, el diagnóstico
                        // de scan API está desactivado por defecto y solo se activa con --scanDiagnostics 1.
                        if (scanDiagnostics)
                        {
                            var scanIsFingerPresent = TryGetProc<ftrScanIsFingerPresentDelegate>(scanModule, "ftrScanIsFingerPresent");
                            var scanGetLastError = TryGetProc<ftrScanGetLastErrorDelegate>(scanModule, "ftrScanGetLastError");

                            int? fingerPresent = null;
                            int? scanLastError = null;
                            if (scanHandle != IntPtr.Zero && scanIsFingerPresent != null)
                            {
                                try
                                {
                                    _ = scanIsFingerPresent(scanHandle, out var present);
                                    fingerPresent = present;
                                }
                                catch { }
                            }
                            if (scanGetLastError != null)
                            {
                                try { scanLastError = scanGetLastError(); } catch { }
                            }

                            scanInfo = new { handleMode, scanHandle = scanHandle.ToInt64(), scanDll = scanDllPath, fingerPresent, scanLastError };
                        }
                        else
                        {
                            scanInfo = new { handleMode, scanHandle = scanHandle.ToInt64(), scanDll = scanDllPath };
                        }

                        if (scanHandle == IntPtr.Zero)
                        {
                            return new CliResult(14, new { ok = false, stage = "scanOpen", error = "ftrScanOpenDevice devolvió NULL", handleMode, scanDll = scanDllPath });
                        }

                        // Comando scanframe: prueba determinista de que el scan API entrega imágenes.
                        // Esto NO depende de FTRCaptureFrame ni de MT*.
                        if (cmd == "scanframe")
                        {
                            var getFrameStd = TryGetProc<ftrScanGetFrameStdCallDelegate>(scanModule, "ftrScanGetFrame")
                                              ?? TryGetProc<ftrScanGetFrameStdCallDelegate>(scanModule, "FTRScanGetFrame")
                                              ?? TryGetProc<ftrScanGetFrameStdCallDelegate>(IntPtr.Zero, "ftrScanGetFrame")
                                              ?? TryGetProc<ftrScanGetFrameStdCallDelegate>(IntPtr.Zero, "FTRScanGetFrame");

                            var getFrameCdecl = TryGetProc<ftrScanGetFrameCdeclDelegate>(scanModule, "ftrScanGetFrame")
                                                ?? TryGetProc<ftrScanGetFrameCdeclDelegate>(scanModule, "FTRScanGetFrame")
                                                ?? TryGetProc<ftrScanGetFrameCdeclDelegate>(IntPtr.Zero, "ftrScanGetFrame")
                                                ?? TryGetProc<ftrScanGetFrameCdeclDelegate>(IntPtr.Zero, "FTRScanGetFrame");

                            if (getFrameStd == null && getFrameCdecl == null)
                            {
                                return new CliResult(14, new { ok = false, stage = "scanFrame", error = "No se encontró ftrScanGetFrame (revisa tu SDK/driver)", scan = scanInfo });
                            }

                            int InvokeGetFrame(IntPtr dev, IntPtr buf, ref FTRSCAN_FRAME_PARAMETERS p)
                            {
                                // Nota: si la convención es incorrecta, puede haber corrupción de stack.
                                // Por eso existe --scanCallConv y siempre se recomienda usar --isolate 1.
                                return scanCallConv == "cdecl"
                                    ? (getFrameCdecl != null ? getFrameCdecl(dev, buf, ref p) : 0)
                                    : (getFrameStd != null ? getFrameStd(dev, buf, ref p) : 0);
                            }

                            var bufferSize = frameBufSize;
                            if (bufferSize < 1024) bufferSize = 153600;
                            if (frameTries < 1) frameTries = 1;

                            IntPtr unmanaged = IntPtr.Zero;
                            try
                            {
                                unmanaged = Marshal.AllocHGlobal(bufferSize);
                                // Best-effort: limpiar buffer
                                for (int i = 0; i < Math.Min(bufferSize, 4096); i++) Marshal.WriteByte(unmanaged, i, 0);

                                var frames = new List<object>();
                                for (int i = 0; i < frameTries; i++)
                                {
                                    var p = new FTRSCAN_FRAME_PARAMETERS
                                    {
                                        nWidth = 0,
                                        nHeight = 0,
                                        nImageSize = 0,
                                        nResolution = 0
                                    };

                                    int r;
                                    try
                                    {
                                        r = InvokeGetFrame(scanHandle, unmanaged, ref p);
                                    }
                                    catch (Exception ex)
                                    {
                                        frames.Add(new { i, ok = false, stage = "scanFrame", error = ex.Message, type = ex.GetType().FullName });
                                        PumpDelay(frameWaitMs);
                                        continue;
                                    }

                                    // Interpretación: r != 0 suele ser TRUE
                                    var okFrame = r != 0;

                                    string? imageB64 = null;
                                    int copySize = 0;
                                    string? copyWarning = null;
                                    string? copyError = null;
                                    if (okFrame && frameCopy)
                                    {
                                        // Validación dura de tamaños antes de copiar: evita AV si el callconv es incorrecto.
                                        // Preferimos derivar tamaño por width*height cuando sea posible.
                                        long inferred = (p.nWidth > 0 && p.nHeight > 0) ? (long)p.nWidth * (long)p.nHeight : 0;
                                        long desired = p.nImageSize > 0 ? p.nImageSize : (inferred > 0 ? inferred : 0);

                                        if (desired <= 0)
                                        {
                                            copyWarning = "No se pudo inferir tamaño de imagen (nImageSize y width/height inválidos).";
                                        }
                                        else if (desired > bufferSize)
                                        {
                                            copyWarning = $"Tamaño reportado ({desired}) excede buffer ({bufferSize}); no se copia.";
                                        }
                                        else
                                        {
                                            copySize = (int)desired;
                                            try
                                            {
                                                var managed = new byte[copySize];
                                                Marshal.Copy(unmanaged, managed, 0, copySize);
                                                imageB64 = Convert.ToBase64String(managed);
                                            }
                                            catch (Exception ex)
                                            {
                                                copyError = ex.Message;
                                                imageB64 = null;
                                                copySize = 0;
                                            }
                                        }
                                    }

                                    frames.Add(new
                                    {
                                        i,
                                        ok = okFrame,
                                        code = r,
                                        width = p.nWidth,
                                        height = p.nHeight,
                                        imageSize = p.nImageSize,
                                        resolution = p.nResolution,
                                        scanCallConv,
                                        frameCopy,
                                        copied = copySize,
                                        copyWarning,
                                        copyError,
                                        imageB64
                                    });

                                    // Si ya obtuvimos un frame con datos, salir.
                                    if (okFrame && (!frameCopy || imageB64 != null))
                                        break;

                                    PumpDelay(frameWaitMs);
                                }

                                return new CliResult(0, new { ok = true, stage = "scanFrame", scan = scanInfo, frames });
                            }
                            finally
                            {
                                if (unmanaged != IntPtr.Zero) Marshal.FreeHGlobal(unmanaged);
                            }
                        }

                        // Comando mtinit: solo intenta MTInitialize con un arg específico.
                        if (cmd == "mtinit")
                        {
                            if (!hasMt)
                            {
                                return new CliResult(10, new { ok = false, stage = "mtInit", error = "No hay exports MT*", hasMt });
                            }

                            if (!mtInitArgExplicit)
                            {
                                return new CliResult(2, new { ok = false, stage = "mtInit", error = "Falta --mtInitArg (mtinit solo prueba un valor)" });
                            }

                            int r;
                            r = mtInit!(mtInitArg);
                            if (r != 0)
                            {
                                return new CliResult(10, new { ok = false, stage = "mtInit", code = r, mtInitArg });
                            }

                            mtInitialized = true;
                            if (!mtTermArgExplicit) mtTermArg = mtInitArg;
                            if (mtUseInitArgForCtx)
                            {
                                if (!mtCaptureArg3Explicit) mtCaptureArg3 = mtInitArg;
                                if (!mtEnrollArg5Explicit) mtEnrollArg5 = mtInitArg;
                            }

                            return new CliResult(0, new
                            {
                                ok = true,
                                stage = "mtInit",
                                code = 0,
                                mtInitArg,
                                mtTermArg,
                                mtCaptureArg3,
                                mtEnrollArg5,
                                scan = scanInfo
                            });
                        }

                        // Comando mtinit-probe: prueba múltiples mtInitArg en subprocesos y reporta cuál no crashea
                        // y devuelve code=0.
                        if (cmd == "mtinit-probe")
                        {
                            var selfExe = Environment.ProcessPath;
                            if (string.IsNullOrWhiteSpace(selfExe) || !File.Exists(selfExe))
                            {
                                return new CliResult(127, new { ok = false, stage = "mtInitProbe", error = "No se pudo resolver Environment.ProcessPath" });
                            }

                            var candidates = new List<int>();
                            if (mtInitTry.Count > 0) candidates.AddRange(mtInitTry);
                            else candidates.AddRange(new[] { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 });

                            var attempts = new List<object>();
                            int? bestArg = null;

                            foreach (var candidate in candidates.Distinct())
                            {
                                var childArgs = new List<string>
                                {
                                    "mtinit",
                                    "--dll", dllPath,
                                    "--scanDll", scanDllPath ?? "",
                                    "--handle", handleMode,
                                    "--mtInitArg", candidate.ToString(),
                                    "--mtUseInitArgForCtx", mtUseInitArgForCtx ? "1" : "0",
                                    "--isolatedChild", "1"
                                };
                                if (useNullHwnd)
                                {
                                    childArgs.Add("--nullHwnd");
                                    childArgs.Add("1");
                                }

                                // Ejecutar el subproceso mtinit
                                var child = RunChildJson(selfExe, childArgs);
                                attempts.Add(new
                                {
                                    mtInitArg = candidate,
                                    exitCode = child.ExitCode,
                                    crashed = child.Crashed,
                                    ok = child.Ok,
                                    stage = child.Stage,
                                    code = child.Code,
                                    error = child.Error
                                });

                                if (!child.Crashed && child.Ok && child.Stage == "mtInit" && child.Code == 0)
                                {
                                    bestArg = candidate;
                                    break;
                                }
                            }

                            return new CliResult(bestArg.HasValue ? 0 : 10, new
                            {
                                ok = bestArg.HasValue,
                                stage = "mtInitProbe",
                                bestMtInitArg = bestArg,
                                attempts,
                                scan = scanInfo
                            });
                        }

                        // Si se pidió mt-scan, inicializar MT* ahora que tenemos scanHandle.
                        if (mtInitDeferred)
                        {
                            if (!hasMt)
                            {
                                return new CliResult(10, new { ok = false, stage = "mtInit", error = "Se pidió --api mt-scan pero no hay exports MT*", hasMt, apiRequested });
                            }

                            // Para evitar crashes, mt-scan requiere un único --mtInitArg.
                            if (!mtInitArgExplicit)
                            {
                                return new CliResult(2, new
                                {
                                    ok = false,
                                    stage = "mtInit",
                                    error = "mt-scan requiere --mtInitArg explícito. Primero corre: mtinit-probe --mtInitTry 0,1,2,...",
                                    apiRequested
                                });
                            }

                            int r = mtInit!(mtInitArg);
                            mtInitDeferredCode = r;
                            if (r != 0)
                            {
                                return new CliResult(10, new { ok = false, stage = "mtInit", code = r, mtInitArg, apiRequested });
                            }
                            mtInitialized = true;
                            if (!mtTermArgExplicit) mtTermArg = mtInitArg;

                            if (mtUseInitArgForCtx)
                            {
                                if (!mtCaptureArg3Explicit) mtCaptureArg3 = mtInitArg;
                                if (!mtEnrollArg5Explicit) mtEnrollArg5 = mtInitArg;
                            }
                        }

                        if (handleMode == "scan")
                        {
                            apiHandle = scanHandle;
                        }
                        else
                        {
                            apiHandle = hwnd; // hwnd+scan
                        }

                        // Cerrar al terminar el trabajo.
                        scanClose = close;
                    }
                    else if (handleMode == "null")
                    {
                        apiHandle = IntPtr.Zero;
                    }

                    try
                    {

                        var setParamResults = new List<object>();
                        foreach (var (id, value) in parsedParams)
                        {
                            var sp = Native.FTRSetParam(id, value);
                            setParamResults.Add(new { id, value, code = sp });
                        }

                        List<object>? paramsDump = null;
                        if (dumpParams)
                        {
                            paramsDump = new List<object>();
                            foreach (var id in dumpParamIds)
                            {
                                try
                                {
                                    var r = Native.FTRGetParam(id, out var v);
                                    paramsDump.Add(new { id, code = r, value = v });
                                }
                                catch (Exception ex)
                                {
                                    paramsDump.Add(new { id, code = -1, error = ex.Message });
                                }
                            }
                        }

                        int capCode = 0;
                        if (doPreCapture)
                        {
                            if ((apiRequested == "mt" || apiRequested == "mt-scan") && mtCapture != null)
                            {
                                capCode = mtCapture(apiHandle, captureArg2, mtCaptureArg3);
                            }
                            else
                            {
                                capCode = Native.FTRCaptureFrame(apiHandle, captureArg2);
                            }
                        }

                        int? capCodeMt = null;

                        // Modo probe: probar ids/valores y medir CaptureFrame
                        if (probeCapture)
                        {
                            var probeIsolated = Args.GetInt(opt, "probeIsolated", 1) != 0;
                            var probeIdRaw = CollectMultiArgs(args, "--probeId");
                            var probeValRaw = CollectMultiArgs(args, "--probeVal");

                            var probeIds = probeIdRaw
                                .Select((s) => int.TryParse(s, out var n) ? (int?)n : null)
                                .Where((n) => n.HasValue)
                                .Select((n) => n!.Value)
                                .ToList();
                            if (!probeIds.Any()) probeIds = new List<int> { 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16 };

                            var probeVals = probeValRaw
                                .Select((s) => int.TryParse(s, out var n) ? (int?)n : null)
                                .Where((n) => n.HasValue)
                                .Select((n) => n!.Value)
                                .ToList();
                            if (!probeVals.Any()) probeVals = new List<int> { 0, 1, 2, 3, 5, 10 };

                            int arg2 = captureArg2Mode switch
                            {
                                "purpose" => purpose,
                                "timeout" => captureArg2,
                                _ => captureArg2,
                            };

                            var originals = new Dictionary<int, int>();
                            foreach (var id in probeIds)
                            {
                                try
                                {
                                    var gr = Native.FTRGetParam(id, out var gv);
                                    if (gr == 0) originals[id] = gv;
                                }
                                catch { }
                            }

                            var probeResults = new List<object>();
                            object? best = null;

                            // Para evitar crashes del DLL (0xC0000005), el probe por defecto corre cada intento
                            // en un subproceso aislado usando el comando "capture".
                            string? selfExe = Environment.ProcessPath;

                            foreach (var id in probeIds)
                            {
                                foreach (var v in probeVals)
                                {
                                    if (probeIsolated)
                                    {
                                        if (string.IsNullOrWhiteSpace(selfExe) || !File.Exists(selfExe))
                                        {
                                            probeResults.Add(new { id, value = v, error = "No se pudo resolver la ruta del ejecutable actual (Environment.ProcessPath)", probeIsolated });
                                            continue;
                                        }

                                        // Construir lista final de params: params del usuario + (id=v) sobreescribiendo.
                                        var finalParams = new Dictionary<int, int>();
                                        foreach (var (pid, pval) in parsedParams) finalParams[pid] = pval;
                                        finalParams[id] = v;

                                        var childArgs = new List<string>
                                    {
                                        "capture",
                                        "--dll", dllPath,
                                        "--purpose", purpose.ToString(),
                                        "--handle", handleMode,
                                        "--captureArg2Mode", captureArg2Mode,
                                        "--captureArg2", captureArg2.ToString(),
                                        "--captureRepeat", Math.Max(1, probeOncePerValue).ToString(),
                                    };
                                        if (!string.IsNullOrWhiteSpace(scanDllPath))
                                        {
                                            childArgs.Add("--scanDll");
                                            childArgs.Add(scanDllPath!);
                                        }
                                        if (useNullHwnd)
                                        {
                                            childArgs.Add("--nullHwnd");
                                            childArgs.Add("1");
                                        }

                                        foreach (var kv in finalParams.OrderBy(k => k.Key))
                                        {
                                            childArgs.Add("--param");
                                            childArgs.Add($"{kv.Key}={kv.Value}");
                                        }

                                        var child = RunChildCapture(selfExe, childArgs);
                                        var captures = child.Captures;
                                        var item = new
                                        {
                                            id,
                                            value = v,
                                            probeIsolated,
                                            setCode = child.SetCodes.TryGetValue(id, out var sc) ? sc : (int?)null,
                                            capture = captures,
                                            exitCode = child.ExitCode,
                                            crashed = child.Crashed,
                                            childStage = child.Stage,
                                            childError = child.Error
                                        };
                                        probeResults.Add(item);

                                        if (best == null && captures.Any((x) => x != 201))
                                        {
                                            best = item;
                                            if (!probeKeep)
                                                goto PROBE_DONE;
                                        }
                                    }
                                    else
                                    {
                                        // Modo antiguo (NO recomendado): corre en el mismo proceso. Puede crash-ear.
                                        int setR;
                                        try { setR = Native.FTRSetParam(id, v); }
                                        catch (Exception ex)
                                        {
                                            probeResults.Add(new { id, value = v, setCode = -1, setError = ex.Message, probeIsolated });
                                            continue;
                                        }

                                        var captures = new List<int>();
                                        for (int i = 0; i < Math.Max(1, probeOncePerValue); i++)
                                        {
                                            int cr;
                                            try { cr = Native.FTRCaptureFrame(apiHandle, arg2); }
                                            catch { cr = -1; }
                                            captures.Add(cr);
                                        }

                                        var item = new { id, value = v, setCode = setR, capture = captures, probeIsolated };
                                        probeResults.Add(item);

                                        if (best == null && captures.Any((x) => x != 201))
                                        {
                                            best = item;
                                            if (!probeKeep)
                                                goto PROBE_DONE;
                                        }
                                    }

                                    // señal: cualquier cosa != 201
                                }
                            }

                        PROBE_DONE:
                            if (!probeKeep)
                            {
                                // restaurar valores originales best-effort
                                foreach (var kv in originals)
                                {
                                    try { _ = Native.FTRSetParam(kv.Key, kv.Value); } catch { }
                                }
                            }

                            return new CliResult(0, new
                            {
                                ok = true,
                                stage = "probeCapture",
                                purpose,
                                hwndMode = useNullHwnd ? "null" : "winforms",
                                handleMode,
                                captureArg2Mode,
                                captureArg2,
                                arg2Used = arg2,
                                probeOncePerValue,
                                probeKeep,
                                probeIds,
                                probeVals,
                                best,
                                results = probeResults,
                                setParams = setParamResults,
                                paramsDump,
                                scan = scanInfo
                            });
                        }

                        // Comando capture: solo captura y devuelve códigos (útil para probe aislado)
                        if (cmd == "capture")
                        {
                            int arg2 = captureArg2Mode switch
                            {
                                "purpose" => purpose,
                                "timeout" => captureArg2,
                                _ => captureArg2,
                            };

                            var captureRepeat = Args.GetInt(opt, "captureRepeat", 1);
                            if (captureRepeat < 1) captureRepeat = 1;

                            var codes = new List<int>();
                            List<int?>? fingerHistory = null;
                            ftrScanIsFingerPresentDelegate? scanIsFingerPresent = null;
                            if (scanDiagnostics && scanHandle != IntPtr.Zero)
                            {
                                fingerHistory = new List<int?>();
                                scanIsFingerPresent = TryGetProc<ftrScanIsFingerPresentDelegate>(scanModule, "ftrScanIsFingerPresent");
                            }
                            if (captureLoop)
                            {
                                for (int i = 0; i < captureLoopMax; i++)
                                {
                                    if (fingerHistory != null)
                                    {
                                        if (scanHandle != IntPtr.Zero && scanIsFingerPresent != null)
                                        {
                                            try
                                            {
                                                _ = scanIsFingerPresent(scanHandle, out var present);
                                                fingerHistory.Add(present);
                                            }
                                            catch
                                            {
                                                fingerHistory.Add(null);
                                            }
                                        }
                                        else
                                        {
                                            fingerHistory.Add(null);
                                        }
                                    }

                                    int r;
                                    if ((apiRequested == "mt" || apiRequested == "mt-scan") && mtCapture != null)
                                        r = mtCapture(apiHandle, arg2, mtCaptureArg3);
                                    else
                                        r = Native.FTRCaptureFrame(apiHandle, arg2);

                                    codes.Add(r);
                                    if (r == 0) break;
                                    var delayMs = Math.Max(0, captureLoopDelayMs);
                                    if (captureArg2Mode == "timeout" && captureArg2 > 0 && r == 203)
                                    {
                                        // Evitar re-iniciar la captura constantemente: respeta el timeout.
                                        delayMs = Math.Max(delayMs, captureArg2);
                                    }
                                    PumpDelay(delayMs);
                                }
                            }
                            else
                            {
                                for (int i = 0; i < captureRepeat; i++)
                                {
                                    int r;
                                    if ((apiRequested == "mt" || apiRequested == "mt-scan") && mtCapture != null)
                                        r = mtCapture(apiHandle, arg2, mtCaptureArg3);
                                    else
                                        r = Native.FTRCaptureFrame(apiHandle, arg2);
                                    codes.Add(r);
                                }
                            }

                            return new CliResult(0, new
                            {
                                ok = true,
                                stage = "capture",
                                purpose,
                                hwndMode = useNullHwnd ? "null" : "winforms",
                                handleMode,
                                api = apiRequested,
                                apiRequested,
                                captureArg2Mode,
                                captureArg2,
                                arg2Used = arg2,
                                codes,
                                fingerHistory,
                                setParams = setParamResults,
                                paramsDump,
                                scan = scanInfo
                            });
                        }

                        // Loop de captura estilo WorkedEx (muchos SDKs requieren capturar antes de Enroll)
                        var captureHistory = new List<int>();
                        if (captureLoop)
                        {
                            int arg2 = captureArg2Mode switch
                            {
                                "purpose" => purpose,
                                "timeout" => captureArg2,
                                _ => captureArg2,
                            };

                            for (int i = 0; i < captureLoopMax; i++)
                            {
                                int r;
                                if ((apiRequested == "mt" || apiRequested == "mt-scan") && mtCapture != null)
                                    r = mtCapture(apiHandle, arg2, mtCaptureArg3);
                                else
                                    r = Native.FTRCaptureFrame(apiHandle, arg2);

                                captureHistory.Add(r);
                                capCode = r;
                                if (r == 0) break;
                                var delayMs = Math.Max(0, captureLoopDelayMs);
                                if (captureArg2Mode == "timeout" && captureArg2 > 0 && r == 203)
                                {
                                    // Evitar re-iniciar la captura constantemente: respeta el timeout.
                                    delayMs = Math.Max(delayMs, captureArg2);
                                }
                                PumpDelay(delayMs);
                            }

                            if (captureRequireOk && (captureHistory.Count == 0 || captureHistory[^1] != 0))
                            {
                                return new CliResult(15, new
                                {
                                    ok = false,
                                    stage = "captureLoop",
                                    code = captureHistory.LastOrDefault(),
                                    purpose,
                                    hwndMode = useNullHwnd ? "null" : "winforms",
                                    handleMode,
                                    api = apiRequested,
                                    apiRequested,
                                    captureArg2Mode,
                                    captureArg2,
                                    captureHistory,
                                    setParams = setParamResults,
                                    paramsDump,
                                    scan = scanInfo
                                });
                            }
                        }

                        string apiUsed = (apiRequested == "mt" || apiRequested == "mt-scan") ? "mt" : "ftr";
                        bool fallbackAttempted = false;
                        int? fallbackCode = null;

                        if (method == "enroll")
                        {
                            // MTEnroll no está confirmado en este SDK (dump-exports no lo lista).
                            var rEnroll = Native.FTREnroll(apiHandle, purpose, ref data);
                            apiUsed = "ftr";
                            if (rEnroll == 0)
                            {
                                var written = (int)data.dwSize;
                                if (written > 0 && written <= buf.Length)
                                {
                                    var tpl = Convert.ToBase64String(buf, 0, written);
                                    return new CliResult(0, new
                                    {
                                        ok = true,
                                        code = 0,
                                        method = "enroll",
                                        purpose,
                                        hwndMode = useNullHwnd ? "null" : "winforms",
                                        handleMode,
                                        api = apiUsed,
                                        apiRequested,
                                        fallbackAttempted,
                                        fallbackCode,
                                        bytes = written,
                                        templateBase64 = tpl,
                                        preCaptureCode = capCode,
                                        preCaptureCodeMt = capCodeMt,
                                        captureHistory,
                                        setParams = setParamResults,
                                        paramsDump,
                                        scan = scanInfo
                                    });
                                }

                                return new CliResult(11, new
                                {
                                    ok = false,
                                    stage = "enroll",
                                    code = 0,
                                    method = "enroll",
                                    purpose,
                                    hwndMode = useNullHwnd ? "null" : "winforms",
                                    handleMode,
                                    api = apiUsed,
                                    apiRequested,
                                    fallbackAttempted,
                                    fallbackCode,
                                    error = "dwSize inválido",
                                    dwSize = data.dwSize,
                                    preCaptureCode = capCode,
                                    preCaptureCodeMt = capCodeMt,
                                    captureHistory,
                                    setParams = setParamResults,
                                    paramsDump,
                                    scan = scanInfo
                                });
                            }

                            return new CliResult(12, new
                            {
                                ok = false,
                                stage = "enroll",
                                code = rEnroll,
                                method = "enroll",
                                purpose,
                                hwndMode = useNullHwnd ? "null" : "winforms",
                                handleMode,
                                api = apiUsed,
                                apiRequested,
                                fallbackAttempted,
                                fallbackCode,
                                preCaptureCode = capCode,
                                preCaptureCodeMt = capCodeMt,
                                captureHistory,
                                setParams = setParamResults,
                                paramsDump,
                                scan = scanInfo
                            });
                        }
                        else
                        {
                            int quality;
                            int r;
                            if ((apiRequested == "mt" || apiRequested == "mt-scan") && mtEnrollX != null)
                            {
                                r = mtEnrollX(apiHandle, purpose, ref data, out quality, mtEnrollArg5);
                                apiUsed = "mt";
                            }
                            else
                            {
                                r = Native.FTREnrollX(apiHandle, purpose, ref data, out quality);
                                apiUsed = "ftr";
                            }
                            if (r == 0)
                            {
                                var written = (int)data.dwSize;
                                if (written > 0 && written <= buf.Length)
                                {
                                    var tpl = Convert.ToBase64String(buf, 0, written);
                                    return new CliResult(0, new
                                    {
                                        ok = true,
                                        code = 0,
                                        method = "enrollx",
                                        purpose,
                                        hwndMode = useNullHwnd ? "null" : "winforms",
                                        handleMode,
                                        api = apiUsed,
                                        apiRequested,
                                        fallbackAttempted,
                                        fallbackCode,
                                        quality,
                                        bytes = written,
                                        templateBase64 = tpl,
                                        preCaptureCode = capCode,
                                        preCaptureCodeMt = capCodeMt,
                                        captureHistory,
                                        setParams = setParamResults,
                                        paramsDump,
                                        scan = scanInfo
                                    });
                                }

                                return new CliResult(11, new
                                {
                                    ok = false,
                                    stage = "enroll",
                                    code = 0,
                                    method = "enrollx",
                                    purpose,
                                    hwndMode = useNullHwnd ? "null" : "winforms",
                                    handleMode,
                                    api = apiUsed,
                                    apiRequested,
                                    fallbackAttempted,
                                    fallbackCode,
                                    quality,
                                    error = "dwSize inválido",
                                    dwSize = data.dwSize,
                                    preCaptureCode = capCode,
                                    preCaptureCodeMt = capCodeMt,
                                    captureHistory,
                                    setParams = setParamResults,
                                    paramsDump,
                                    scan = scanInfo
                                });
                            }

                            return new CliResult(12, new
                            {
                                ok = false,
                                stage = "enroll",
                                code = r,
                                method = "enrollx",
                                purpose,
                                hwndMode = useNullHwnd ? "null" : "winforms",
                                handleMode,
                                api = apiUsed,
                                apiRequested,
                                fallbackAttempted,
                                fallbackCode,
                                quality,
                                preCaptureCode = capCode,
                                preCaptureCodeMt = capCodeMt,
                                captureHistory,
                                setParams = setParamResults,
                                paramsDump,
                                scan = scanInfo
                            });
                        }
                    }
                    finally
                    {
                        if (scanHandle != IntPtr.Zero && scanClose != null)
                        {
                            try { scanClose(scanHandle); } catch { }
                        }
                    }
                }, visible);

                JsonOut.Print(result.Payload);
                return result.ExitCode;
            }
            finally
            {
                if (pinned.IsAllocated) pinned.Free();
            }
        }
        finally
        {
            try
            {
                if (mtInitialized && mtTerm != null) mtTerm(mtTermArg);
                else Native.FTRTerminate();
            }
            catch { }
            try { Environment.CurrentDirectory = oldCwd; } catch { }
            try { Native.SetDllDirectoryA(null); } catch { }
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int MTInitDelegate(int arg1);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void MTTerminateDelegate(int arg1);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int MTCaptureDelegate(IntPtr handle, int arg2, int arg3);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int MTEnrollXDelegate(
        IntPtr handle,
        int purpose,
        ref Native.FTR_DATA outTemplate,
        out int quality,
        int arg5
    );

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate IntPtr ftrScanOpenDeviceDelegate();

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void ftrScanCloseDeviceDelegate(IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ftrScanIsFingerPresentDelegate(IntPtr device, out int present);

    [StructLayout(LayoutKind.Sequential)]
    private struct FTRSCAN_FRAME_PARAMETERS
    {
        public int nWidth;
        public int nHeight;
        public int nImageSize;
        public int nResolution;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ftrScanGetFrameStdCallDelegate(IntPtr device, IntPtr pBuffer, ref FTRSCAN_FRAME_PARAMETERS pParams);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int ftrScanGetFrameCdeclDelegate(IntPtr device, IntPtr pBuffer, ref FTRSCAN_FRAME_PARAMETERS pParams);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ftrScanGetLastErrorDelegate();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int ftrScanGetLastErrorCdeclDelegate();

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ftrScanGetImageSizeDelegate(IntPtr device, ref FTRSCAN_FRAME_PARAMETERS pParams);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ftrScanGetImage2Delegate(IntPtr device, IntPtr pBuffer, ref FTRSCAN_FRAME_PARAMETERS pParams);

    private static T? TryGetProc<T>(IntPtr module, string name) where T : class
    {
        if (module == IntPtr.Zero) return null;
        var p = Native.GetProcAddress(module, name);
        if (p == IntPtr.Zero) return null;
        return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
    }

    private static List<string> CollectMultiArgs(string[] argv, params string[] keys)
    {
        var list = new List<string>();
        for (int i = 0; i < argv.Length; i++)
        {
            var a = argv[i];
            if (!keys.Contains(a, StringComparer.OrdinalIgnoreCase))
                continue;

            if (i + 1 < argv.Length)
                list.Add(argv[++i]);
        }
        return list;
    }

    private static List<(int id, int value)> ParseParams(List<string> raw)
    {
        var list = new List<(int id, int value)>();
        foreach (var token in raw)
        {
            var parts = token.Split('=', 2, StringSplitOptions.TrimEntries);
            if (parts.Length != 2) continue;
            if (!int.TryParse(parts[0], out var id)) continue;
            if (!int.TryParse(parts[1], out var value)) continue;
            list.Add((id, value));
        }
        return list;
    }

    private static void PumpDelay(int delayMs)
    {
        try
        {
            // Si el SDK depende de mensajes Windows, dormir el hilo UI rompe el flujo.
            // Esto mantiene el message loop vivo mientras esperamos.
            if (delayMs <= 0)
            {
                Application.DoEvents();
                return;
            }

            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < delayMs)
            {
                Application.DoEvents();
                Thread.Sleep(10);
            }
        }
        catch
        {
            // Fallback best-effort
            Thread.Sleep(Math.Max(0, delayMs));
        }
    }

    private sealed record ChildCaptureResult(
        int ExitCode,
        bool Crashed,
        string? Stage,
        string? Error,
        List<int> Captures,
        Dictionary<int, int> SetCodes
    );

    private static class PeExports
    {
        public sealed record ExportInfo(string Name, uint Rva, int? StdcallArgBytes);
        public sealed record PeInfo(string Arch, List<ExportInfo> Exports);

        public static PeInfo Read(string path, string? filter, int maxExports)
        {
            var buf = File.ReadAllBytes(path);
            if (buf.Length < 0x100) throw new InvalidOperationException("Archivo demasiado pequeño para ser PE");
            if (buf[0] != (byte)'M' || buf[1] != (byte)'Z') throw new InvalidOperationException("No es PE (sin MZ)");

            uint e_lfanew = ReadU32(buf, 0x3c);
            if (e_lfanew + 4 > buf.Length) throw new InvalidOperationException("PE offset fuera de rango");
            if (buf[e_lfanew] != (byte)'P' || buf[e_lfanew + 1] != (byte)'E' || buf[e_lfanew + 2] != 0 || buf[e_lfanew + 3] != 0)
                throw new InvalidOperationException("No es PE (sin firma PE\\0\\0)");

            ushort sizeOfOptionalHeader = ReadU16(buf, (int)e_lfanew + 20);
            int optOff = (int)e_lfanew + 24;
            ushort magic = ReadU16(buf, optOff);
            string arch = magic == 0x10b ? "x86" : magic == 0x20b ? "x64" : "unknown";

            int dataDirBase = magic == 0x10b ? optOff + 96 : optOff + 112;
            uint exportRva = ReadU32(buf, dataDirBase + 0);
            if (exportRva == 0)
                return new PeInfo(arch, new List<ExportInfo>());

            int peOffset = (int)e_lfanew;
            int? exportDirOff = RvaToFileOffset(buf, peOffset, exportRva);
            if (exportDirOff == null) throw new InvalidOperationException("No se pudo mapear export directory RVA");

            uint numberOfFunctions = ReadU32(buf, exportDirOff.Value + 20);
            uint numberOfNames = ReadU32(buf, exportDirOff.Value + 24);
            uint addressOfFunctionsRva = ReadU32(buf, exportDirOff.Value + 28);
            uint addressOfNamesRva = ReadU32(buf, exportDirOff.Value + 32);
            uint addressOfNameOrdinalsRva = ReadU32(buf, exportDirOff.Value + 36);

            int? namesOff = RvaToFileOffset(buf, peOffset, addressOfNamesRva);
            int? ordOff = RvaToFileOffset(buf, peOffset, addressOfNameOrdinalsRva);
            int? funcsOff = RvaToFileOffset(buf, peOffset, addressOfFunctionsRva);
            if (namesOff == null || ordOff == null || funcsOff == null)
                throw new InvalidOperationException("Export directory incompleto (tables)");

            // Build sorted unique function RVAs (to approximate end ranges)
            var allFuncRvas = new List<uint>();
            for (int i = 0; i < numberOfFunctions; i++)
            {
                var rva = ReadU32(buf, funcsOff.Value + i * 4);
                if (rva > 0) allFuncRvas.Add(rva);
            }
            allFuncRvas.Sort();
            var unique = new List<uint>();
            foreach (var rva in allFuncRvas)
            {
                if (unique.Count == 0 || unique[^1] != rva) unique.Add(rva);
            }

            var exports = new List<ExportInfo>();
            int count = (int)Math.Min(numberOfNames, (uint)Math.Max(0, maxExports));
            for (int i = 0; i < count; i++)
            {
                uint nameRva = ReadU32(buf, namesOff.Value + i * 4);
                int? nameOff = RvaToFileOffset(buf, peOffset, nameRva);
                if (nameOff == null) continue;
                string? name = ReadCString(buf, nameOff.Value);
                if (string.IsNullOrWhiteSpace(name)) continue;
                if (!string.IsNullOrWhiteSpace(filter) && !name.Contains(filter, StringComparison.OrdinalIgnoreCase))
                    continue;

                ushort ordIndex = ReadU16(buf, ordOff.Value + i * 2);
                if (ordIndex >= numberOfFunctions) continue;
                uint funcRva = ReadU32(buf, funcsOff.Value + ordIndex * 4);
                if (funcRva == 0) continue;

                int? funcOff = RvaToFileOffset(buf, peOffset, funcRva);
                int? nextOff = null;
                uint? nextRva = null;
                foreach (var candidate in unique)
                {
                    if (candidate > funcRva)
                    {
                        nextRva = candidate;
                        break;
                    }
                }
                if (nextRva.HasValue) nextOff = RvaToFileOffset(buf, peOffset, nextRva.Value);

                int? rangeEnd = null;
                if (funcOff != null)
                {
                    if (nextOff != null && nextOff > funcOff) rangeEnd = nextOff;
                    else rangeEnd = Math.Min(buf.Length, funcOff.Value + 4096);
                }

                int? stdcallBytes = null;
                if (arch == "x86" && funcOff != null && rangeEnd != null)
                {
                    stdcallBytes = GuessStdcallArgBytesInRange(buf, funcOff.Value, rangeEnd.Value);
                }

                exports.Add(new ExportInfo(name, funcRva, stdcallBytes));
            }

            return new PeInfo(arch, exports);
        }

        private static ushort ReadU16(byte[] buf, int off)
        {
            if (off < 0 || off + 2 > buf.Length) return 0;
            return BitConverter.ToUInt16(buf, off);
        }

        private static uint ReadU32(byte[] buf, int off)
        {
            if (off < 0 || off + 4 > buf.Length) return 0;
            return BitConverter.ToUInt32(buf, off);
        }

        private static string? ReadCString(byte[] buf, int off)
        {
            int end = off;
            while (end < buf.Length && buf[end] != 0) end++;
            if (end >= buf.Length) return null;
            return System.Text.Encoding.ASCII.GetString(buf, off, end - off);
        }

        private static int? RvaToFileOffset(byte[] buf, int peOffset, uint rva)
        {
            ushort numberOfSections = ReadU16(buf, peOffset + 6);
            ushort sizeOfOptionalHeader = ReadU16(buf, peOffset + 20);
            int sectionTable = peOffset + 24 + sizeOfOptionalHeader;
            for (int i = 0; i < numberOfSections; i++)
            {
                int secOff = sectionTable + i * 40;
                uint virtualSize = ReadU32(buf, secOff + 8);
                uint virtualAddress = ReadU32(buf, secOff + 12);
                uint sizeOfRawData = ReadU32(buf, secOff + 16);
                uint pointerToRawData = ReadU32(buf, secOff + 20);
                uint maxSize = Math.Max(virtualSize, sizeOfRawData);
                if (rva >= virtualAddress && rva < virtualAddress + maxSize)
                {
                    return checked((int)(pointerToRawData + (rva - virtualAddress)));
                }
            }
            return null;
        }

        private static int? GuessStdcallArgBytesInRange(byte[] buf, int startOff, int endOff)
        {
            if (startOff < 0 || startOff >= buf.Length) return null;
            int end = Math.Min(buf.Length, Math.Max(startOff, endOff));
            int? last = null;
            for (int i = startOff; i + 2 < end; i++)
            {
                if (buf[i] == 0xC2)
                {
                    int imm = buf[i + 1] | (buf[i + 2] << 8);
                    last = imm;
                }
            }
            if (last == null) return null;
            if (last > 128) return null;
            if (last % 4 != 0) return null;
            return last;
        }
    }

    private sealed record ChildJsonResult(
        int ExitCode,
        bool Crashed,
        bool Ok,
        string? Stage,
        int? Code,
        string? Error
    );

    private static ChildCaptureResult RunChildCapture(string selfExe, List<string> childArgs)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = selfExe,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            foreach (var a in childArgs)
                psi.ArgumentList.Add(a);

            using var p = Process.Start(psi);
            if (p == null)
            {
                return new ChildCaptureResult(127, false, "spawn", "No se pudo iniciar el proceso hijo", new List<int>(), new Dictionary<int, int>());
            }

            var stdout = p.StandardOutput.ReadToEnd();
            var stderr = p.StandardError.ReadToEnd();
            p.WaitForExit();

            // En Windows, access violation suele ser 3221225477 (0xC0000005)
            var crashed = p.ExitCode == unchecked((int)0xC0000005);

            // Intentar parsear JSON de salida
            List<int> codes = new();
            string? stage = null;
            string? error = null;
            var setCodes = new Dictionary<int, int>();

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                try
                {
                    using var doc = JsonDocument.Parse(stdout.Trim());
                    var root = doc.RootElement;
                    if (root.TryGetProperty("stage", out var st) && st.ValueKind == JsonValueKind.String)
                        stage = st.GetString();
                    if (root.TryGetProperty("error", out var er) && er.ValueKind == JsonValueKind.String)
                        error = er.GetString();
                    if (root.TryGetProperty("codes", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var el in arr.EnumerateArray())
                            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n))
                                codes.Add(n);
                    }
                    else if (root.TryGetProperty("code", out var codeEl) && codeEl.ValueKind == JsonValueKind.Number && codeEl.TryGetInt32(out var one))
                    {
                        codes.Add(one);
                    }

                    if (root.TryGetProperty("setParams", out var sp) && sp.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in sp.EnumerateArray())
                        {
                            if (item.ValueKind != JsonValueKind.Object) continue;
                            if (item.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var id) &&
                                item.TryGetProperty("code", out var cEl) && cEl.TryGetInt32(out var c))
                            {
                                setCodes[id] = c;
                            }
                        }
                    }
                }
                catch
                {
                    // Si no es JSON, dejamos error por stderr/stdout.
                }
            }

            if (codes.Count == 0 && crashed)
                error ??= "Proceso hijo crash (0xC0000005)";
            if (codes.Count == 0 && !string.IsNullOrWhiteSpace(stderr))
                error ??= stderr.Trim();

            return new ChildCaptureResult(p.ExitCode, crashed, stage, error, codes, setCodes);
        }
        catch (Exception ex)
        {
            return new ChildCaptureResult(127, false, "spawn", ex.Message, new List<int>(), new Dictionary<int, int>());
        }
    }

    private static ChildJsonResult RunChildJson(string selfExe, List<string> childArgs)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = selfExe,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            foreach (var a in childArgs)
                psi.ArgumentList.Add(a);

            using var p = Process.Start(psi);
            if (p == null)
                return new ChildJsonResult(127, false, false, "spawn", null, "No se pudo iniciar el proceso hijo");

            var stdout = p.StandardOutput.ReadToEnd();
            var stderr = p.StandardError.ReadToEnd();
            p.WaitForExit();

            var crashed = p.ExitCode == unchecked((int)0xC0000005);
            if (crashed)
                return new ChildJsonResult(p.ExitCode, true, false, "crash", null, string.IsNullOrWhiteSpace(stderr) ? "0xC0000005" : stderr.Trim());

            bool ok = false;
            string? stage = null;
            int? code = null;
            string? error = null;

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                try
                {
                    using var doc = JsonDocument.Parse(stdout.Trim());
                    var root = doc.RootElement;
                    if (root.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.True) ok = true;
                    if (root.TryGetProperty("stage", out var st) && st.ValueKind == JsonValueKind.String) stage = st.GetString();
                    if (root.TryGetProperty("code", out var cEl) && cEl.ValueKind == JsonValueKind.Number && cEl.TryGetInt32(out var n)) code = n;
                    if (root.TryGetProperty("error", out var er) && er.ValueKind == JsonValueKind.String) error = er.GetString();
                }
                catch
                {
                    // ignore parse failures
                }
            }

            if (!string.IsNullOrWhiteSpace(stderr))
                error ??= stderr.Trim();

            return new ChildJsonResult(p.ExitCode, false, ok, stage, code, error);
        }
        catch (Exception ex)
        {
            return new ChildJsonResult(127, false, false, "spawn", null, ex.Message);
        }
    }
}
