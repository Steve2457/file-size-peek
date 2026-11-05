const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { formatSize, ScanCancelled } = require('../size');

function harness({ language = 'zh-CN', result, scan, choice, cancel = false } = {}) {
  const messages = [], reports = [], output = [], copies = [], calls = [];
  let command;
  const vscode = {
    env: { language, clipboard: { async writeText(value) { copies.push(value); } } },
    ProgressLocation: { Notification: 15 },
    commands: { registerCommand(name, handler) { command = handler; calls.push(name); return { dispose() {} }; } },
    window: {
      createOutputChannel() { return { appendLine(value) { output.push(value); }, show() { output.push('opened'); }, dispose() {} }; },
      async withProgress(options, handler) { calls.push(options); return handler({ report(value) { reports.push(value); } }, { isCancellationRequested: cancel }); },
      async showInformationMessage(message, ...buttons) { messages.push({ kind: 'info', message, buttons }); return choice; },
      async showWarningMessage(message, ...buttons) { messages.push({ kind: 'warning', message, buttons }); return choice; },
      async showErrorMessage(message) { messages.push({ kind: 'error', message }); }
    }
  };
  const size = { formatSize, measureSize: scan || (async (target, options) => {
    calls.push(target);
    if (options.token.isCancellationRequested) throw new ScanCancelled();
    options.onProgress({ files: 2, bytes: 2048 });
    return { path: target, kind: 'directory', bytes: 2048, files: 2, directories: 1, skippedLinks: 0, skippedOther: 0, errors: 0, issues: [], ...result };
  }) };
  const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const context = { module: { exports: {} }, require(name) { return name === 'vscode' ? vscode : name === './size' ? size : require(name); } };
  vm.runInNewContext(source, context);
  const subscriptions = []; context.module.exports.activate({ subscriptions });
  return { command, messages, reports, output, copies, calls, subscriptions, vscode };
}

test('Explorer command uses the supplied remote path and displays/copies exact size without selecting another file', async () => {
  const h = harness({ choice: '复制结果' });
  await h.command({ scheme: 'vscode-remote', fsPath: '/home/me/中文 project' });
  assert.ok(h.calls.includes('/home/me/中文 project'));
  assert.match(h.messages[0].message, /2.00 KiB \(2,048 字节\)/);
  assert.equal(h.copies.length, 1); assert.match(h.copies[0], /\/home\/me\/中文 project/);
  assert.equal(h.calls[1].cancellable, true); assert.equal(h.reports.length, 1);
});

test('English messages, partial warnings and error details remain accessible', async () => {
  const h = harness({ language: 'en', choice: 'Details', result: { errors: 1, skippedLinks: 2, issues: [{ path: '/data/locked', code: 'EACCES', message: 'denied' }] } });
  await h.command({ scheme: 'file', fsPath: '/data' });
  assert.equal(h.messages[0].kind, 'warning'); assert.match(h.messages[0].message, /at least/);
  assert.match(h.messages[0].message, /incomplete result/); assert.match(h.output[0], /EACCES/); assert.equal(h.output.at(-1), 'opened');
});

test('cancellation does not display a result; filesystem errors show an error', async () => {
  const cancelled = harness({ cancel: true }); await cancelled.command({ scheme: 'file', fsPath: '/data' });
  assert.equal(cancelled.messages.length, 0);
  const failed = harness({ scan: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } });
  await failed.command({ scheme: 'file', fsPath: '/data' }); assert.equal(failed.messages[0].kind, 'error');
});

test('non-filesystem URIs are rejected, and command-palette invocation can use the active file', async () => {
  const h = harness(); await h.command({ scheme: 'git', fsPath: '/history' });
  assert.equal(h.messages[0].kind, 'info'); assert.equal(h.calls.length, 1);
  h.vscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/active.txt' } } };
  await h.command(); assert.ok(h.calls.includes('/active.txt'));
});

test('a later request supersedes an earlier scan and extension disposal cancels pending work', async () => {
  const pending = [];
  const h = harness({ scan: (target, options) => new Promise(resolve => pending.push({ target, options, resolve })) });
  const first = h.command({ scheme: 'file', fsPath: '/first' });
  const second = h.command({ scheme: 'file', fsPath: '/second' });
  assert.equal(pending[0].options.token.isCancellationRequested, true);
  const result = { kind: 'file', bytes: 3, files: 1, directories: 0, errors: 0, skippedLinks: 0, skippedOther: 0, issues: [] };
  pending[1].resolve({ ...result, path: '/second' }); await second;
  pending[0].resolve({ ...result, path: '/first' }); await first;
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].message, /second/);
  const third = h.command({ scheme: 'file', fsPath: '/third' });
  h.subscriptions[1].dispose(); assert.equal(pending[2].options.token.isCancellationRequested, true);
  pending[2].resolve({ ...result, path: '/third' }); await third;
  assert.equal(h.messages.length, 1);
});

test('manifest exposes a single Explorer action with remote/local activation and localized labels', () => {
  const project = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.commands.length, 1);
  assert.equal(manifest.contributes.menus['explorer/context'][0].command, 'fileSizePeek.showSize');
  assert.match(manifest.contributes.menus['explorer/context'][0].when, /vscode-remote/);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'package.nls.zh-cn.json'), 'utf8'))['command.showSize'], '查看大小');
});
