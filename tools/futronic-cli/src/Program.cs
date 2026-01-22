using System;
using System.Collections.Generic;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTRInitialize();

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void FTRTerminate();

    [DllImport("FTRAPI.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int FTRSetParam(int id, int value);

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
        if (!noLoadLibrary)
        {
            var hMod = Native.LoadLibraryW(dllPath);
            if (hMod == IntPtr.Zero)
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

        var init = Native.FTRInitialize();
        if (init != 0)
        {
            JsonOut.Print(new { ok = false, stage = "init", code = init, is64Process = Environment.Is64BitProcess, is64OS = Environment.Is64BitOperatingSystem });
            Environment.CurrentDirectory = oldCwd;
            return 10;
        }

        try
        {
            if (cmd != "enroll")
            {
                JsonOut.Print(new { ok = false, error = $"Comando no soportado: {cmd}" });
                return 2;
            }

            var purpose = Args.GetInt(opt, "purpose", 3);
            var captureArg2 = Args.GetInt(opt, "captureArg2", 0);
            var doPreCapture = Args.GetInt(opt, "preCapture", 0) != 0;
            var useNullHwnd = Args.GetInt(opt, "nullHwnd", 0) != 0;
            var method = (Args.GetStr(opt, "method") ?? "enrollx").Trim().ToLowerInvariant();

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

                var result = WinFormsLoop.RunOnUiThread(hwndFromUi =>
                {
                    var hwnd = useNullHwnd ? IntPtr.Zero : hwndFromUi;

                    // Determinar handle a usar en la API: hwnd (default) o handle de dispositivo.
                    IntPtr apiHandle = hwnd;
                    IntPtr scanHandle = IntPtr.Zero;
                    object? scanInfo = null;

                    if (handleMode == "scan")
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

                        apiHandle = scanHandle;

                        // Asegurar cierre al terminar.
                        if (close != null)
                        {
                            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                            {
                                try { close(scanHandle); } catch { }
                            };
                        }
                    }
                    else if (handleMode == "null")
                    {
                        apiHandle = IntPtr.Zero;
                    }

                    var setParamResults = new List<object>();
                    foreach (var (id, value) in parsedParams)
                    {
                        var sp = Native.FTRSetParam(id, value);
                        setParamResults.Add(new { id, value, code = sp });
                    }

                    int capCode = 0;
                    if (doPreCapture)
                    {
                        capCode = Native.FTRCaptureFrame(apiHandle, captureArg2);
                    }

                    if (method == "enroll")
                    {
                        var rEnroll = Native.FTREnroll(apiHandle, purpose, ref data);
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
                                    bytes = written,
                                    templateBase64 = tpl,
                                    preCaptureCode = capCode,
                                    setParams = setParamResults,
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
                                error = "dwSize inválido",
                                dwSize = data.dwSize,
                                preCaptureCode = capCode,
                                setParams = setParamResults,
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
                            preCaptureCode = capCode,
                            setParams = setParamResults,
                            scan = scanInfo
                        });
                    }
                    else
                    {
                        int quality;
                        var r = Native.FTREnrollX(apiHandle, purpose, ref data, out quality);
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
                                    quality,
                                    bytes = written,
                                    templateBase64 = tpl,
                                    preCaptureCode = capCode,
                                    setParams = setParamResults,
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
                                quality,
                                error = "dwSize inválido",
                                dwSize = data.dwSize,
                                preCaptureCode = capCode,
                                setParams = setParamResults,
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
                            quality,
                            preCaptureCode = capCode,
                            setParams = setParamResults,
                            scan = scanInfo
                        });
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
            try { Native.FTRTerminate(); } catch { }
            try { Environment.CurrentDirectory = oldCwd; } catch { }
            try { Native.SetDllDirectoryA(null); } catch { }
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate IntPtr ftrScanOpenDeviceDelegate();

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void ftrScanCloseDeviceDelegate(IntPtr device);

    private static T? TryGetProc<T>(IntPtr module, string name) where T : class
    {
        // Si module==0, GetProcAddress no sirve. En nuestro caso, las funciones scan pueden estar en FTRAPI.dll,
        // pero ya están cargadas en el proceso con el nombre "FTRAPI.dll". No tenemos el handle aquí.
        // Por eso solo resolvemos si nos pasaron --scanDll.
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
}
