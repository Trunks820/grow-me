import { isMain } from './entry.mjs';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { validateTree } from './model.mjs';

const run = promisify(execFile);
const wmiCommand = Buffer.from(
  `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  CreateFlags = [uint32]8 # DETACHED_PROCESS
  ShowWindow = [uint16]0
}
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $env:GROW_ME_WMI_COMMAND_LINE
  CurrentDirectory = $env:GROW_ME_WMI_CWD
  ProcessStartupInformation = $startup
}
if ($result.ReturnValue -eq 0) { [Console]::WriteLine($result.ProcessId) }
`,
  'utf16le'
).toString('base64');

function quoteWindowsArg(arg) {
  // Double backslashes before closing quotes and escape any embedded quote.
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
}

export async function startWithWmi(args, cwd = process.cwd()) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', wmiCommand],
      {
        timeout: 12000,
        windowsHide: true,
        env: {
          ...process.env,
          GROW_ME_WMI_COMMAND_LINE: [process.execPath, ...args].map(quoteWindowsArg).join(' '),
          GROW_ME_WMI_CWD: cwd
        }
      }
    );
    const pid = Number(stdout.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function spawnService(args, cwd, logFile) {
  const fd = openSync(logFile, 'wx');
  try {
    return spawn(process.execPath, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    });
  } finally {
    closeSync(fd);
  }
}

export async function startService({ stateFile, documentFile, port = 0, sessionId }) {
  stateFile = resolve(stateFile);
  documentFile = resolve(documentFile ?? join(dirname(stateFile), 'outputs', 'task.html'));
  const tree = validateTree(JSON.parse(readFileSync(stateFile, 'utf8')));
  if (!sessionId || tree.session_id !== sessionId)
    throw Error('原文件的会话身份不匹配，未启动服务。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
  mkdirSync(dirname(stateFile), { recursive: true });
  const cwd = dirname(stateFile);
  const logFile = join(cwd, '.grow-me-server-' + randomUUID() + '.log');
  const args = [
    fileURLToPath(new URL('./server.mjs', import.meta.url)),
    '--state',
    stateFile,
    '--document',
    documentFile,
    '--port',
    String(port)
  ];
  const wmiPid = await startWithWmi([...args, '--log-file', logFile], cwd);
  let child, launchError;
  if (wmiPid === null) {
    try {
      child = spawnService(args, cwd, logFile);
    } catch (error) {
      // A WMI server that started before the fallback reached this point owns the log.
      if (process.platform !== 'win32' || error.code !== 'EEXIST') throw error;
    }
    child?.on('error', error => {
      launchError = error;
    });
  }
  const launch = child ? 'spawn' : 'wmi';
  const until = Date.now() + (launch === 'wmi' ? 12000 : 3000);
  while (Date.now() < until) {
    const exited = child
      ? child.exitCode !== null || child.signalCode !== null
      : wmiPid !== null && processExited(wmiPid);
    let output = '';
    try {
      output = readFileSync(logFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const line of output.split(/\r?\n/)) {
      try {
        const started = JSON.parse(line);
        if (
          started.session_id === sessionId &&
          started.url &&
          Number.isSafeInteger(started.pid) &&
          started.pid > 0
        ) {
          child?.unref();
          return { ...started, log_file: logFile, launch };
        }
      } catch {
        /* The startup receipt is one complete JSON line. */
      }
    }
    const occupied = /^listen EADDRINUSE\b/m.test(output);
    if (launchError || exited || occupied) {
      const error = Error(
        occupied ? 'Port already in use' : '本机服务未启动，请查看本地启动日志。'
      );
      error.code = occupied ? 'EADDRINUSE' : 'START_FAILED';
      throw error;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  if (child) child.kill();
  else if (wmiPid !== null) {
    try {
      process.kill(wmiPid);
    } catch {
      /* The WMI process may already have exited. */
    }
  }
  throw Error('本机服务启动超时；原文件未改动。');
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2),
    arg = (name, fallback) => {
      const i = args.indexOf(name);
      return i < 0 ? fallback : args[i + 1];
    };
  if (args.includes('--help'))
    console.log(
      'node scripts/start.mjs --state <tree.json> --session <session_id> [--document <task.html>] [--port 0]\nStarts a separate local service and exits after its receipt. Never creates/replaces tree.json.'
    );
  else
    try {
      if (!arg('--state')) throw Error('--state required');
      console.log(
        JSON.stringify(
          await startService({
            stateFile: arg('--state'),
            documentFile: arg('--document'),
            sessionId: arg('--session'),
            port: Number(arg('--port', 0))
          })
        )
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
