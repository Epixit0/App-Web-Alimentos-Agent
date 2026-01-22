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
    public static CliResult RunOnUiThread(Func<IntPtr, CliResult> work)
    {
        var tcs = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        var thread = new Thread(() =>
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using var form = new Form
                {
                    ShowInTaskbar = false,
                    Opacity = 0,
                    Width = 1,
                    Height = 1,
                    StartPosition = FormStartPosition.Manual,
                    Left = -32000,
                    Top = -32000
                };

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

        int init;
        string apiInitUsed;
        var mtInitArg = Args.GetInt(opt, "mtInitArg", 0);
        var mtTermArg = Args.GetInt(opt, "mtTermArg", 0);
        var mtCaptureArg3 = Args.GetInt(opt, "mtCaptureArg3", 0);
        var mtEnrollArg5 = Args.GetInt(opt, "mtEnrollArg5", 0);

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
            if (cmd != "enroll" && cmd != "capture")
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
                        scanInfo = new { handleMode, scanHandle = scanHandle.ToInt64(), scanDll = scanDllPath };

                        if (scanHandle == IntPtr.Zero)
                        {
                            return new CliResult(14, new { ok = false, stage = "scanOpen", error = "ftrScanOpenDevice devolvió NULL", handleMode, scanDll = scanDllPath });
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
                            if (apiRequested == "mt" && mtCapture != null)
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
                            if (captureLoop)
                            {
                                for (int i = 0; i < captureLoopMax; i++)
                                {
                                    int r;
                                    if (apiRequested == "mt" && mtCapture != null)
                                        r = mtCapture(apiHandle, arg2, mtCaptureArg3);
                                    else
                                        r = Native.FTRCaptureFrame(apiHandle, arg2);

                                    codes.Add(r);
                                    if (r == 0) break;
                                    PumpDelay(Math.Max(0, captureLoopDelayMs));
                                }
                            }
                            else
                            {
                                for (int i = 0; i < captureRepeat; i++)
                                {
                                    int r;
                                    if (apiRequested == "mt" && mtCapture != null)
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
                                if (apiRequested == "mt" && mtCapture != null)
                                    r = mtCapture(apiHandle, arg2, mtCaptureArg3);
                                else
                                    r = Native.FTRCaptureFrame(apiHandle, arg2);

                                captureHistory.Add(r);
                                capCode = r;
                                if (r == 0) break;
                                PumpDelay(Math.Max(0, captureLoopDelayMs));
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

                        string apiUsed = apiRequested == "mt" ? "mt" : "ftr";
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
                            if (apiRequested == "mt" && mtEnrollX != null)
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
                });

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
}
