const vscode = require('vscode');
const path = require('node:path');
const { measureSize, formatSize } = require('./size');

function activate(context) {
  const zh = (vscode.env.language || '').startsWith('zh');
  const t = (cn, en) => zh ? cn : en;
  const output = vscode.window.createOutputChannel('File Size Peek');
  let active = null;
  context.subscriptions.push(output, { dispose() { if (active) active.cancelled = true; } });
  context.subscriptions.push(vscode.commands.registerCommand('fileSizePeek.showSize', async uri => {
    uri ||= vscode.window.activeTextEditor?.document.uri;
    if (!uri || !['file', 'vscode-remote'].includes(uri.scheme) || !uri.fsPath) {
      await vscode.window.showInformationMessage(t('请在文件资源管理器中右键文件或文件夹，选择“查看大小”。', 'Right-click a file or folder in Explorer and choose Show Size.'));
      return;
    }
    if (active) active.cancelled = true;
    const operation = { cancelled: false }; active = operation;
    const name = path.basename(uri.fsPath) || uri.fsPath;
    let result;
    try {
      result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: t('正在统计大小：', 'Measuring size: ') + name, cancellable: true }, async (progress, cancellation) => {
        const token = { get isCancellationRequested() { return operation.cancelled || cancellation.isCancellationRequested; } };
        return measureSize(uri.fsPath, { token, onProgress: current => progress.report({
          message: formatSize(current.bytes) + ' · ' + current.files.toLocaleString() + t(' 个文件', ' files')
        }) });
      });
      if (operation.cancelled || active !== operation) return;
    } catch (error) {
      if (error.code !== 'CANCELLED' && !operation.cancelled) {
        output.appendLine(uri.fsPath + '\n' + error.message);
        await vscode.window.showErrorMessage(t('无法统计大小：', 'Could not measure size: ') + name + ' · ' + error.message);
      }
      return;
    } finally { if (active === operation) active = null; }
    const formatted = formatSize(result.bytes) + ' (' + result.bytes.toLocaleString() + t(' 字节)', ' bytes)');
    let message = name + '：' + (result.errors ? t('至少 ', 'at least ') : '') + formatted;
    if (result.kind === 'directory') message += ' · ' + result.files.toLocaleString() + t(' 个文件', ' files');
    if (result.kind === 'link') message += t(' · 符号链接本身', ' · symbolic link itself');
    if (result.skippedLinks) message += ' · ' + t('跳过 ', 'skipped ') + result.skippedLinks + t(' 个符号链接', ' symlinks');
    if (result.errors) message += ' · ' + result.errors + t(' 项无法读取，结果不完整', ' unreadable items; incomplete result');
    const detail = [message, result.path, t('逻辑大小，非实际磁盘占用。', 'Logical size, not allocated disk space.'),
      t('子文件夹：', 'Subfolders: ') + result.directories, t('跳过的特殊文件：', 'Skipped special files: ') + result.skippedOther,
      ...result.issues.map(issue => issue.path + ' · ' + issue.code + ' · ' + issue.message)].join('\n');
    output.appendLine(detail + '\n');
    const copy = t('复制结果', 'Copy result'), details = t('查看详情', 'Details');
    const show = result.errors ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const choice = await show.call(vscode.window, message, copy, details);
    if (choice === copy) await vscode.env.clipboard.writeText(detail);
    else if (choice === details) output.show(true);
  }));
}

module.exports = { activate, deactivate() {} };
