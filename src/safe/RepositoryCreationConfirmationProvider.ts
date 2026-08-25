import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { type ElicitRequestFormParams, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { SafeAbapError } from './errors.js';
import type { RepositoryCreationConfirmationProviderMode } from './RepositoryCreationConfirmationChallengeStore.js';

const MAX_HELPER_OUTPUT_BYTES = 4 * 1024;
const POWERSHELL_CONFIRMATION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$pipeName = '__PIPE_NAME__'
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
$client.Connect(15000)
$reader = New-Object System.IO.StreamReader($client, [System.Text.UTF8Encoding]::new($false), $false, 4096, $true)
$writer = New-Object System.IO.StreamWriter($client, [System.Text.UTF8Encoding]::new($false), 4096, $true)
$writer.AutoFlush = $true
$requestLine = $reader.ReadLine()
if ([string]::IsNullOrWhiteSpace($requestLine) -or $requestLine.Length -gt 4096) { exit 2 }
$request = $requestLine | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$request.challengeId) -or ([string]$request.challengeId).Length -gt 128) { exit 3 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = [string]$request.title
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(680, 520)
$form.MinimumSize = New-Object System.Drawing.Size(680, 520)
$form.TopMost = $true
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.FormBorderStyle = 'FixedDialog'
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object System.Drawing.Point(0, 0)
$header.Size = New-Object System.Drawing.Size(680, 76)
$header.BackColor = [System.Drawing.Color]::FromArgb(15, 91, 154)
$headerTitle = New-Object System.Windows.Forms.Label
$headerTitle.Location = New-Object System.Drawing.Point(24, 14)
$headerTitle.Size = New-Object System.Drawing.Size(620, 30)
$headerTitle.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$headerTitle.ForeColor = [System.Drawing.Color]::White
$headerTitle.Text = [string]$request.title
$header.Controls.Add($headerTitle)
$headerSubtitle = New-Object System.Windows.Forms.Label
$headerSubtitle.Location = New-Object System.Drawing.Point(26, 47)
$headerSubtitle.Size = New-Object System.Drawing.Size(620, 20)
$headerSubtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$headerSubtitle.ForeColor = [System.Drawing.Color]::FromArgb(220, 238, 250)
$headerSubtitle.Text = '受控变更 | 请核对对象与传输信息'
$header.Controls.Add($headerSubtitle)
$intro = New-Object System.Windows.Forms.Label
$intro.Location = New-Object System.Drawing.Point(24, 91)
$intro.Size = New-Object System.Drawing.Size(632, 25)
$intro.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$intro.ForeColor = [System.Drawing.Color]::FromArgb(35, 45, 55)
$intro.Text = [string]$request.introduction
$objectGroup = New-Object System.Windows.Forms.GroupBox
$objectGroup.Location = New-Object System.Drawing.Point(24, 126)
$objectGroup.Size = New-Object System.Drawing.Size(632, 166)
$objectGroup.Text = [string]$request.objectGroupTitle
$objectGroup.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 95)
$fieldLabelFont = New-Object System.Drawing.Font('Segoe UI', 9)
$fieldValueFont = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$kindCaption = New-Object System.Windows.Forms.Label
$kindCaption.Location = New-Object System.Drawing.Point(20, 31)
$kindCaption.Size = New-Object System.Drawing.Size(82, 24)
$kindCaption.Text = '对象类型'
$kindValue = New-Object System.Windows.Forms.Label
$kindValue.Location = New-Object System.Drawing.Point(105, 31)
$kindValue.Size = New-Object System.Drawing.Size(190, 24)
$kindValue.Font = $fieldValueFont
$kindValue.Text = [string]$request.objectKind
$nameCaption = New-Object System.Windows.Forms.Label
$nameCaption.Location = New-Object System.Drawing.Point(320, 31)
$nameCaption.Size = New-Object System.Drawing.Size(82, 24)
$nameCaption.Text = '对象名称'
$nameValue = New-Object System.Windows.Forms.Label
$nameValue.Location = New-Object System.Drawing.Point(405, 31)
$nameValue.Size = New-Object System.Drawing.Size(202, 24)
$nameValue.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$nameValue.ForeColor = [System.Drawing.Color]::FromArgb(15, 91, 154)
$nameValue.Text = [string]$request.objectName
$packageCaption = New-Object System.Windows.Forms.Label
$packageCaption.Location = New-Object System.Drawing.Point(20, 73)
$packageCaption.Size = New-Object System.Drawing.Size(82, 24)
$packageCaption.Text = '开发包'
$packageValue = New-Object System.Windows.Forms.Label
$packageValue.Location = New-Object System.Drawing.Point(105, 73)
$packageValue.Size = New-Object System.Drawing.Size(190, 24)
$packageValue.Font = $fieldValueFont
$packageValue.Text = [string]$request.packageName
$transportCaption = New-Object System.Windows.Forms.Label
$transportCaption.Location = New-Object System.Drawing.Point(320, 73)
$transportCaption.Size = New-Object System.Drawing.Size(82, 24)
$transportCaption.Text = '传输请求'
$transportValue = New-Object System.Windows.Forms.Label
$transportValue.Location = New-Object System.Drawing.Point(405, 73)
$transportValue.Size = New-Object System.Drawing.Size(202, 24)
$transportValue.Font = $fieldValueFont
$transportValue.Text = [string]$request.transportRequest
$summary = New-Object System.Windows.Forms.Label
$summary.Location = New-Object System.Drawing.Point(20, 113)
$summary.Size = New-Object System.Drawing.Size(587, 35)
$summary.Font = $fieldLabelFont
$summary.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 95)
$summary.Text = [string]$request.summary
$objectGroup.Controls.AddRange(@($kindCaption, $kindValue, $nameCaption, $nameValue, $packageCaption, $packageValue, $transportCaption, $transportValue, $summary))
$executionGroup = New-Object System.Windows.Forms.GroupBox
$executionGroup.Location = New-Object System.Drawing.Point(24, 305)
$executionGroup.Size = New-Object System.Drawing.Size(632, 105)
$executionGroup.Text = '执行信息'
$executionGroup.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 95)
$fingerprintCaption = New-Object System.Windows.Forms.Label
$fingerprintCaption.Location = New-Object System.Drawing.Point(20, 31)
$fingerprintCaption.Size = New-Object System.Drawing.Size(82, 24)
$fingerprintCaption.Text = '计划指纹'
$fingerprintValue = New-Object System.Windows.Forms.Label
$fingerprintValue.Location = New-Object System.Drawing.Point(105, 31)
$fingerprintValue.Size = New-Object System.Drawing.Size(480, 24)
$fingerprintValue.Font = $fieldLabelFont
$fingerprintValue.Text = [string]$request.payloadFingerprint
$expiresCaption = New-Object System.Windows.Forms.Label
$expiresCaption.Location = New-Object System.Drawing.Point(20, 68)
$expiresCaption.Size = New-Object System.Drawing.Size(82, 24)
$expiresCaption.Text = '有效期至'
$expiresValue = New-Object System.Windows.Forms.Label
$expiresValue.Location = New-Object System.Drawing.Point(105, 68)
$expiresValue.Size = New-Object System.Drawing.Size(480, 24)
$expiresValue.Font = $fieldLabelFont
$expiresValue.Text = [string]$request.expiresAt
$executionGroup.Controls.AddRange(@($fingerprintCaption, $fingerprintValue, $expiresCaption, $expiresValue))
$warning = New-Object System.Windows.Forms.Label
$warning.Location = New-Object System.Drawing.Point(24, 425)
$warning.Size = New-Object System.Drawing.Size(632, 25)
$warning.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$warning.ForeColor = [System.Drawing.Color]::FromArgb(154, 87, 0)
$warning.Text = [string]$request.warning
$applyButton = New-Object System.Windows.Forms.Button
$applyButton.Text = [string]$request.confirmButtonText
$applyButton.Location = New-Object System.Drawing.Point(412, 462)
$applyButton.Size = New-Object System.Drawing.Size(112, 36)
$applyButton.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$applyButton.BackColor = [System.Drawing.Color]::FromArgb(15, 91, 154)
$applyButton.ForeColor = [System.Drawing.Color]::White
$applyButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$applyButton.FlatAppearance.BorderSize = 0
$applyButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = '取消'
$cancelButton.Location = New-Object System.Drawing.Point(536, 462)
$cancelButton.Size = New-Object System.Drawing.Size(112, 36)
$cancelButton.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$cancelButton.BackColor = [System.Drawing.Color]::White
$cancelButton.ForeColor = [System.Drawing.Color]::FromArgb(55, 65, 75)
$cancelButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$cancelButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(185, 195, 205)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($header)
$form.Controls.Add($intro)
$form.Controls.Add($objectGroup)
$form.Controls.Add($executionGroup)
$form.Controls.Add($warning)
$form.Controls.Add($applyButton)
$form.Controls.Add($cancelButton)
$form.AcceptButton = $applyButton
$form.CancelButton = $cancelButton
$form.ActiveControl = $cancelButton
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, ([int]$request.timeoutSeconds * 1000))
$timer.Add_Tick({ $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Close() })
$timer.Start()
$result = $form.ShowDialog()
$timer.Stop()
$action = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { 'apply' } else { 'cancel' }
$writer.WriteLine((@{ challengeId = [string]$request.challengeId; action = $action } | ConvertTo-Json -Compress))
$writer.Dispose()
$reader.Dispose()
$client.Dispose()
`;

export interface RepositoryCreationConfirmationRequest {
  challengeId: string;
  creationPlanId: string;
  operation?: 'create' | 'cleanup';
  summary: string;
  objectKind: string;
  objectName: string;
  packageName?: string;
  transportRequest?: string;
  payloadFingerprint: string;
  expiresAt: string;
}

export type RepositoryCreationDecision =
  | { action: 'apply'; challengeId: string }
  | { action: 'cancel'; challengeId: string };

export interface RepositoryCreationConfirmationProviderOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RepositoryCreationConfirmationProvider {
  readonly mode: RepositoryCreationConfirmationProviderMode;
  confirm(
    request: RepositoryCreationConfirmationRequest,
    options: RepositoryCreationConfirmationProviderOptions
  ): Promise<RepositoryCreationDecision>;
}

export type WindowsConfirmationRunner = (
  requestLine: string,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<string>;

export interface RepositoryCreationConfirmationProviderFactoryOptions {
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  supportsFormElicitation: () => boolean;
  elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>;
  windowsRunner?: WindowsConfirmationRunner;
}

export class McpFormRepositoryCreationConfirmationProvider implements RepositoryCreationConfirmationProvider {
  readonly mode = 'mcp-form' as const;

  constructor(
    private readonly supportsFormElicitation: () => boolean,
    private readonly elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>
  ) {}

  async confirm(
    request: RepositoryCreationConfirmationRequest,
    options: RepositoryCreationConfirmationProviderOptions
  ): Promise<RepositoryCreationDecision> {
    if (!this.supportsFormElicitation()) {
      throw new SafeAbapError('CONFIRMATION_UNSUPPORTED', 'confirmation', 'Native MCP form elicitation is not supported by this client session.');
    }
    const response = await this.elicitInput({
      mode: 'form',
      message: confirmationMessage(request),
      requestedSchema: {
        type: 'object',
        properties: { decision: { type: 'string', enum: ['apply', 'cancel'] } },
        required: ['decision']
      }
    }, options.timeoutMs);
    if (response.action === 'accept' && response.content?.decision === 'apply') {
      return { action: 'apply', challengeId: request.challengeId };
    }
    if (response.action === 'cancel'
      || response.action === 'decline'
      || (response.action === 'accept' && response.content?.decision === 'cancel')) {
      return { action: 'cancel', challengeId: request.challengeId };
    }
    throw new Error('MCP form confirmation returned a malformed decision.');
  }
}

export class WindowsNativeRepositoryCreationConfirmationProvider implements RepositoryCreationConfirmationProvider {
  readonly mode = 'windows-native' as const;

  constructor(private readonly runner: WindowsConfirmationRunner = runWindowsConfirmationHelper) {}

  async confirm(
    request: RepositoryCreationConfirmationRequest,
    options: RepositoryCreationConfirmationProviderOptions
  ): Promise<RepositoryCreationDecision> {
    const cleanup = request.operation === 'cleanup';
    const requestLine = JSON.stringify({
      challengeId: request.challengeId,
      title: cleanup ? 'SAP 验证对象删除确认' : 'SAP 受控创建确认',
      introduction: cleanup ? '请确认是否删除以下 SAP DEV 验证对象' : '请确认是否在 SAP DEV 中创建以下对象',
      objectGroupTitle: cleanup ? '删除对象' : '创建对象',
      warning: cleanup ? '确认后将执行一次不可重放的 SAP 验证对象删除。' : '确认后将执行一次受控 SAP 创建流程。',
      confirmButtonText: cleanup ? '确认删除' : '确认创建',
      message: confirmationMessage(request),
      summary: request.summary,
      objectKind: request.objectKind,
      objectName: request.objectName,
      packageName: request.packageName || '[无]',
      transportRequest: request.transportRequest || '[无]',
      payloadFingerprint: request.payloadFingerprint,
      expiresAt: formatChinaStandardTime(request.expiresAt),
      timeoutSeconds: Math.max(1, Math.floor((options.timeoutMs - 1_000) / 1_000))
    });
    if (Buffer.byteLength(requestLine, 'utf8') > MAX_HELPER_OUTPUT_BYTES) {
      throw new Error('Windows confirmation request exceeds the protocol limit.');
    }
    const output = await this.runner(`${requestLine}\n`, options.timeoutMs, options.signal);
    return parseWindowsDecision(output, request.challengeId);
  }
}

class AutoRepositoryCreationConfirmationProvider implements RepositoryCreationConfirmationProvider {
  private readonly formProvider: McpFormRepositoryCreationConfirmationProvider;
  private readonly windowsProvider: WindowsNativeRepositoryCreationConfirmationProvider;

  constructor(
    private readonly supportsFormElicitation: () => boolean,
    elicitInput: (params: ElicitRequestFormParams, timeoutMs: number) => Promise<ElicitResult>,
    windowsRunner?: WindowsConfirmationRunner
  ) {
    this.formProvider = new McpFormRepositoryCreationConfirmationProvider(supportsFormElicitation, elicitInput);
    this.windowsProvider = new WindowsNativeRepositoryCreationConfirmationProvider(windowsRunner);
  }

  get mode(): RepositoryCreationConfirmationProviderMode {
    return this.selectProvider().mode;
  }

  confirm(
    request: RepositoryCreationConfirmationRequest,
    options: RepositoryCreationConfirmationProviderOptions
  ): Promise<RepositoryCreationDecision> {
    return this.selectProvider().confirm(request, options);
  }

  private selectProvider(): RepositoryCreationConfirmationProvider {
    return this.supportsFormElicitation() ? this.formProvider : this.windowsProvider;
  }
}

export function createRepositoryCreationConfirmationProvider(
  options: RepositoryCreationConfirmationProviderFactoryOptions
): RepositoryCreationConfirmationProvider {
  const environment = options.environment || process.env;
  const platform = options.platform || process.platform;
  const configured = String(environment.SAP_MCP_CONFIRMATION_PROVIDER || 'auto').trim().toLowerCase();
  if (!['auto', 'mcp-app', 'windows-native', 'mcp-form'].includes(configured)) {
    throw new Error('SAP_MCP_CONFIRMATION_PROVIDER must be auto, mcp-app, windows-native, or mcp-form.');
  }
  if (configured === 'mcp-app') {
    return new UnavailableRepositoryCreationConfirmationProvider(
      'mcp-app',
      'MCP App confirmation is unavailable because App-only tool isolation has not been verified for this server.'
    );
  }
  if (configured === 'windows-native') {
    if (platform !== 'win32') {
      return new UnavailableRepositoryCreationConfirmationProvider('windows-native', 'Windows native confirmation requires an interactive Windows session.');
    }
    return new WindowsNativeRepositoryCreationConfirmationProvider(options.windowsRunner);
  }
  if (configured === 'auto' && platform === 'win32') {
    return new AutoRepositoryCreationConfirmationProvider(
      options.supportsFormElicitation,
      options.elicitInput,
      options.windowsRunner
    );
  }
  return new McpFormRepositoryCreationConfirmationProvider(options.supportsFormElicitation, options.elicitInput);
}

class UnavailableRepositoryCreationConfirmationProvider implements RepositoryCreationConfirmationProvider {
  constructor(
    readonly mode: RepositoryCreationConfirmationProviderMode,
    private readonly message: string
  ) {}

  async confirm(): Promise<RepositoryCreationDecision> {
    throw new SafeAbapError('CONFIRMATION_UNSUPPORTED', 'confirmation', this.message);
  }
}

function confirmationMessage(request: RepositoryCreationConfirmationRequest): string {
  const action = request.operation === 'cleanup' ? '删除以下验证对象' : '创建以下对象';
  return `请确认是否在 SAP DEV 中${action}：${request.objectKind} ${request.objectName}\n开发包：${request.packageName || '[无]'}\n传输请求：${request.transportRequest || '[无]'}\n计划指纹：${request.payloadFingerprint}\n有效期至：${formatChinaStandardTime(request.expiresAt)}`;
}

function formatChinaStandardTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const chinaTime = new Date(timestamp + 8 * 60 * 60 * 1000);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${chinaTime.getUTCFullYear()}-${pad(chinaTime.getUTCMonth() + 1)}-${pad(chinaTime.getUTCDate())}`
    + ` ${pad(chinaTime.getUTCHours())}:${pad(chinaTime.getUTCMinutes())}:${pad(chinaTime.getUTCSeconds())} UTC+08:00`;
}

function parseWindowsDecision(output: string, challengeId: string): RepositoryCreationDecision {
  const raw = String(output).replace(/^\uFEFF/, '');
  const normalized = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!normalized
    || normalized !== normalized.trim()
    || normalized.includes('\n')
    || normalized.includes('\r')
    || Buffer.byteLength(raw, 'utf8') > MAX_HELPER_OUTPUT_BYTES) {
    throw new Error('Windows confirmation helper returned invalid output framing.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error('Windows confirmation helper returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows confirmation helper returned an invalid decision.');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'action,challengeId'
    || record.challengeId !== challengeId
    || !['apply', 'cancel'].includes(String(record.action))) {
    throw new Error('Windows confirmation helper returned a mismatched decision.');
  }
  return { action: record.action as 'apply' | 'cancel', challengeId };
}

async function runWindowsConfirmationHelper(
  requestLine: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pipeName = `sap-mcp-confirm-${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const helperPath = path.join(os.tmpdir(), `sap-mcp-confirm-${randomUUID()}.ps1`);
  const helperSource = POWERSHELL_CONFIRMATION_SCRIPT.replace('__PIPE_NAME__', pipeName);
  await fs.writeFile(helperPath, `\uFEFF${helperSource}`, 'utf8');
  const escapedExecutable = executable.replace(/'/g, "''");
  const escapedHelperPath = helperPath.replace(/"/g, '\\"');
  const helperArguments = `-NoLogo -NoProfile -WindowStyle Hidden -STA -ExecutionPolicy Bypass -File "${escapedHelperPath}"`;
  const brokerScript = `$shell = New-Object -ComObject Shell.Application; $shell.ShellExecute('${escapedExecutable}', '${helperArguments.replace(/'/g, "''")}', '', 'open', 0)`;
  const encodedBrokerScript = Buffer.from(brokerScript, 'utf16le').toString('base64');
  return new Promise<string>((resolve, reject) => {
    let broker: ChildProcess | undefined;
    let socket: net.Socket | undefined;
    let server: net.Server | undefined;
    let output = '';
    let settled = false;
    const cleanup = (): void => {
      socket?.destroy();
      server?.close();
      broker?.kill();
      void fs.rm(helperPath, { force: true });
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      cleanup();
      if (error) reject(error);
      else resolve(output);
    };
    const abort = (): void => finish(new Error('Windows confirmation was cancelled.'));
    const timer = setTimeout(() => finish(new Error('Windows confirmation timed out.')), Math.max(1, timeoutMs));
    server = net.createServer(connection => {
      if (socket) {
        connection.destroy();
        return;
      }
      socket = connection;
      socket.setEncoding('utf8');
      socket.setTimeout(Math.max(1, timeoutMs));
      socket.on('timeout', () => finish(new Error('Windows confirmation timed out.')));
      socket.on('error', error => finish(error));
      socket.on('data', chunk => {
        output += String(chunk);
        if (Buffer.byteLength(output, 'utf8') > MAX_HELPER_OUTPUT_BYTES) {
          finish(new Error('Windows confirmation helper returned too much output.'));
        } else if (output.includes('\n')) {
          finish();
        }
      });
      socket.write(requestLine, 'utf8');
    });
    server.once('error', error => finish(error));
    server.listen(pipePath, () => {
      broker = spawn(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedBrokerScript
      ], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: windowsHelperEnvironment(systemRoot)
      });
      broker.once('error', error => finish(error));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function windowsHelperEnvironment(systemRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: process.env.WINDIR || systemRoot };
  for (const name of ['ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}
