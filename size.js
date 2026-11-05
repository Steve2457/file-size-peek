const fs = require('node:fs/promises');
const path = require('node:path');

class ScanCancelled extends Error {
  constructor() { super('Size scan cancelled.'); this.code = 'CANCELLED'; }
}
const check = token => { if (token?.isCancellationRequested) throw new ScanCancelled(); };
function formatSize(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let size = bytes, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return (unit ? size.toFixed(2) : String(size)) + ' ' + units[unit];
}

// Use the extension host's filesystem so SSH scans execute on the server.
// Stream each directory and bound file metadata reads; no shell or dependencies.
async function measureSize(target, { token, onProgress = () => {}, fileSystem = fs } = {}) {
  check(token);
  const root = await fileSystem.lstat(target);
  check(token);
  const result = { path: target, kind: root.isSymbolicLink() ? 'link' : root.isDirectory() ? 'directory' : root.isFile() ? 'file' : 'other',
    bytes: 0, files: 0, directories: 0, skippedLinks: 0, skippedOther: 0, errors: 0, issues: [] };
  if (result.kind !== 'directory') {
    if (result.kind === 'other') throw new Error('Only regular files, folders and symbolic links are supported.');
    result.bytes = root.size; result.files = result.kind === 'file' ? 1 : 0;
    return result;
  }
  const stack = [target], pending = new Set();
  let lastReport = 0;
  const report = (force = false) => {
    if (token?.isCancellationRequested) return;
    if (force || Date.now() - lastReport >= 250) { lastReport = Date.now(); onProgress({ bytes: result.bytes, files: result.files, directories: result.directories }); }
  };
  const issue = (filename, error) => {
    result.errors++;
    if (result.issues.length < 20) result.issues.push({ path: filename, code: error.code || '', message: error.message });
  };
  const addFile = filename => {
    const task = (async () => {
      try {
        const stat = await fileSystem.lstat(filename);
        if (token?.isCancellationRequested) return;
        if (stat.isSymbolicLink()) result.skippedLinks++;
        else if (stat.isFile()) { result.bytes += stat.size; result.files++; }
        else if (stat.isDirectory()) { result.directories++; stack.push(filename); }
        else result.skippedOther++;
      } catch (error) { issue(filename, error); }
      report();
    })();
    pending.add(task); task.then(() => pending.delete(task));
  };
  try {
    report(true);
    while (stack.length || pending.size) {
      check(token);
      if (!stack.length) { await Promise.all(pending); continue; }
      const directory = stack.pop();
      let handle;
      try {
        // Recheck queued directories: a folder may become a symlink mid-scan.
        const current = await fileSystem.lstat(directory);
        check(token);
        if (current.isSymbolicLink()) { result.skippedLinks++; continue; }
        if (!current.isDirectory()) { issue(directory, new Error('Directory changed during the scan.')); continue; }
        handle = await fileSystem.opendir(directory);
        let entry;
        while ((entry = await handle.read()) !== null) {
          check(token);
          const filename = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) result.skippedLinks++;
          else if (entry.isDirectory()) { result.directories++; stack.push(filename); }
          else if (entry.isFile()) {
            addFile(filename);
            if (pending.size >= 16) await Promise.race(pending);
          } else {
            // Unknown Dirent types occur on some remote/network filesystems.
            addFile(filename);
            if (pending.size >= 16) await Promise.race(pending);
          }
          report();
        }
      } catch (error) {
        if (error.code === 'CANCELLED') throw error;
        issue(directory, error);
      } finally { if (handle) await handle.close().catch(error => issue(directory, error)); }
    }
    check(token); report(true); return result;
  } finally { await Promise.all(pending); }
}

module.exports = { measureSize, formatSize, ScanCancelled };
