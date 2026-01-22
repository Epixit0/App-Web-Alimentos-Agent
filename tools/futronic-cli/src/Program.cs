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

        var dllDir = Path.GetDirectoryName(dllPath);
        if (!string.IsNullOrWhiteSpace(dllDir))
            Native.SetDllDirectoryA(dllDir);

        var init = Native.FTRInitialize();
        if (init != 0)
        {
            JsonOut.Print(new { ok = false, stage = "init", code = init });
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

                    foreach (var (id, value) in parsedParams)
                    {
                        _ = Native.FTRSetParam(id, value);
                    }

                    int capCode = 0;
                    if (doPreCapture)
                    {
                        capCode = Native.FTRCaptureFrame(hwnd, captureArg2);
                    }

                    if (method == "enroll")
                    {
                        var rEnroll = Native.FTREnroll(hwnd, purpose, ref data);
                        if (rEnroll == 0)
                        {
                            var written = (int)data.dwSize;
                            if (written > 0 && written <= buf.Length)
                            {
                                var tpl = Convert.ToBase64String(buf, 0, written);
                                return new CliResult(0, new { ok = true, code = 0, method = "enroll", bytes = written, templateBase64 = tpl, preCaptureCode = capCode });
                            }

                            return new CliResult(11, new { ok = false, stage = "enroll", code = 0, method = "enroll", error = "dwSize inválido", dwSize = data.dwSize, preCaptureCode = capCode });
                        }

                        return new CliResult(12, new { ok = false, stage = "enroll", code = rEnroll, method = "enroll", preCaptureCode = capCode });
                    }
                    else
                    {
                        int quality;
                        var r = Native.FTREnrollX(hwnd, purpose, ref data, out quality);
                        if (r == 0)
                        {
                            var written = (int)data.dwSize;
                            if (written > 0 && written <= buf.Length)
                            {
                                var tpl = Convert.ToBase64String(buf, 0, written);
                                return new CliResult(0, new { ok = true, code = 0, method = "enrollx", quality, bytes = written, templateBase64 = tpl, preCaptureCode = capCode });
                            }

                            return new CliResult(11, new { ok = false, stage = "enroll", code = 0, method = "enrollx", quality, error = "dwSize inválido", dwSize = data.dwSize, preCaptureCode = capCode });
                        }

                        return new CliResult(12, new { ok = false, stage = "enroll", code = r, method = "enrollx", quality, preCaptureCode = capCode });
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
        }
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
