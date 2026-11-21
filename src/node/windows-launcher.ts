import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

async function run(script: string, env: NodeJS.ProcessEnv) {
  await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, ...env }, shell: false, windowsHide: true, timeout: 10_000,
  });
}

export async function prepareLauncher(directory: string, name: string, source: string): Promise<string> {
  const version = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const launcher = path.join(directory, `${name}-${version}.exe`);
  await mkdir(directory, { recursive: true });
  await run(String.raw`
$ErrorActionPreference = 'Stop'
$output = $env:OPI_HUB_LAUNCHER
if (-not [IO.File]::Exists($output)) {
  $temp = Join-Path ([IO.Path]::GetDirectoryName($output)) ([guid]::NewGuid().ToString() + '.exe')
  try {
    Add-Type -TypeDefinition $env:OPI_HUB_SOURCE -ReferencedAssemblies System.dll,System.Security.dll -OutputAssembly $temp -OutputType WindowsApplication
    try { [IO.File]::Move($temp, $output) }
    catch [IO.IOException] { if (-not [IO.File]::Exists($output)) { throw } }
  } finally { [IO.File]::Delete($temp) }
}
`, { OPI_HUB_LAUNCHER: launcher, OPI_HUB_SOURCE: source });
  return launcher;
}

export async function registerLauncher(scheme: string, description: string, launcher: string) {
  await run(String.raw`
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\' + $env:OPI_HUB_SCHEME)
$key.SetValue('', $env:OPI_HUB_DESCRIPTION)
$key.SetValue('URL Protocol', '')
$key.CreateSubKey('shell\open\command').SetValue('', $env:OPI_HUB_HANDLER)
`, { OPI_HUB_SCHEME: scheme, OPI_HUB_DESCRIPTION: description, OPI_HUB_HANDLER: `"${launcher}" "%1"` });
}
