import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import open from 'open';

export interface Desktop {
  openBrowser(url: string): Promise<void>;
  openLoginTerminal(): Promise<number>;
}

const execute = promisify(execFile);

export function buildWindowsLoginCommand(nodePath: string, entryPath: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `& ${quote(nodePath)} ${quote(entryPath)} auth login --no-browser`,
    '$onesLoginExit = $LASTEXITCODE',
    "if ($onesLoginExit -ne 0) { Write-Host 'ONES API Key setup did not complete.'; [void](Read-Host 'Press Enter to close') }",
    'exit $onesLoginExit',
  ].join('; ');
}

export class LocalDesktop implements Desktop {
  async openBrowser(url: string): Promise<void> {
    await open(url);
  }

  async openLoginTerminal(): Promise<number> {
    if (process.platform !== 'win32') {
      throw new Error('当前平台请在独立终端运行 ones-mcp auth login。');
    }
    const command = buildWindowsLoginCommand(
      process.execPath, fileURLToPath(new URL('./index.js', import.meta.url)),
    );
    // A detached child with ignored stdio receives NUL handles even in its own
    // console. Start-Process creates an actual interactive console instead.
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const launch = "$ErrorActionPreference = 'Stop'; " +
      "Start-Process -FilePath 'powershell.exe' " +
      `-ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', '${encoded}') ` +
      '-WindowStyle Normal -PassThru | ForEach-Object { $_.Id }';
    try {
      const { stdout } = await execute('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(launch, 'utf16le').toString('base64'),
      ], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
      const pid = Number(stdout.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid terminal PID');
      return pid;
    } catch {
      throw new Error('无法打开输入终端，请手动运行 npx @suplaser/onces-mcp auth login。');
    }
  }
}
