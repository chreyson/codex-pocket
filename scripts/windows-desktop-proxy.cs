using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// A native entry point is required because Electron spawns the CLI without cmd.exe.
public static class PocketDesktopProxy
{
    public class Configuration
    {
        public string nodePath;
        public string codexPath;
        public string[] proxyArgs;
    }

    static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    static async Task Pump(Stream source, Stream destination)
    {
        var buffer = new byte[8192];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) != 0)
        {
            await destination.WriteAsync(buffer, 0, count);
            // RPC peers wait for each reply while keeping stdin open.
            await destination.FlushAsync();
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            string configPath = Process.GetCurrentProcess().MainModule.FileName + ".json";
            var config = new JavaScriptSerializer().Deserialize<Configuration>(File.ReadAllText(configPath));
            bool server = args.Contains("app-server");
            var start = new ProcessStartInfo
            {
                FileName = server ? config.nodePath : config.codexPath,
                Arguments = string.Join(" ", (server ? config.proxyArgs.Concat(args) : args).Select(Quote)),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.EnvironmentVariables["CODEX_BIN"] = config.codexPath;
            using (var child = Process.Start(start))
            {
                // Do not await stdin: the desktop can keep its pipe open after child exit.
                Task.Run(async () => {
                    try { await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                });
                var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                var error = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            using (var stderr = new StreamWriter(Console.OpenStandardError())) stderr.WriteLine("Codex Pocket: " + error.Message);
            return 1;
        }
    }
}
