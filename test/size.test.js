const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { measureSize, formatSize } = require('../size');

test('real files, nested and hidden folders, Unicode paths and empty files have exact logical sizes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-size-peek-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '中文 folder'));
  await fs.mkdir(path.join(root, '.hidden-dir'));
  await fs.writeFile(path.join(root, 'sample.bin'), Buffer.alloc(1500));
  await fs.writeFile(path.join(root, 'empty'), '');
  await fs.writeFile(path.join(root, '中文 folder', '文档.txt'), Buffer.alloc(1024));
  await fs.writeFile(path.join(root, '.hidden-dir', '.data'), Buffer.alloc(8));
  const file = await measureSize(path.join(root, 'sample.bin'));
  assert.equal(file.kind, 'file'); assert.equal(file.bytes, 1500);
  const folder = await measureSize(root);
  assert.equal(folder.bytes, 2532); assert.equal(folder.files, 4); assert.equal(folder.directories, 2);
  assert.equal(folder.errors, 0);
  const empty = await measureSize(path.join(root, 'empty')); assert.equal(empty.bytes, 0);
  await fs.mkdir(path.join(root, 'empty-dir'));
  assert.equal((await measureSize(path.join(root, 'empty-dir'))).bytes, 0);
});

test('real hard links count per path; directory links are skipped to avoid cycles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-size-peek-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a'), Buffer.alloc(37));
  await fs.link(path.join(root, 'a'), path.join(root, 'b'));
  await fs.symlink(root, path.join(root, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await measureSize(root);
  assert.equal(result.bytes, 74); assert.equal(result.files, 2); assert.equal(result.skippedLinks, 1);
  const link = await measureSize(path.join(root, 'cycle'));
  assert.equal(link.kind, 'link'); assert.equal(link.bytes, (await fs.lstat(path.join(root, 'cycle'))).size);
});

const stat = (kind, size = 0) => ({ size, isDirectory: () => kind === 'directory', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
function fakeTree(names, { token, cancelAfter, failures = [] } = {}) {
  const root = path.resolve('fake-root'); let reads = 0, closed = 0, active = 0, maximum = 0;
  const fileSystem = {
    async lstat(filename) {
      if (filename === root) return stat('directory');
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      if (failures.includes(path.basename(filename))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return stat('file', 10);
    },
    async opendir() {
      let index = 0;
      return {
        async read() {
          if (index === names.length) return null;
          reads++;
          if (cancelAfter === reads) token.isCancellationRequested = true;
          const name = names[index++]; return { name, ...stat('file') };
        },
        async close() { closed++; }
      };
    }
  };
  return { root, fileSystem, counts: () => ({ reads, closed, maximum, active }) };
}

test('metadata concurrency is bounded and all entries beyond the first page are counted', async () => {
  const fixture = fakeTree(Array.from({ length: 2500 }, (_, i) => 'file-' + i));
  const result = await measureSize(fixture.root, fixture);
  assert.equal(result.bytes, 25000); assert.equal(result.files, 2500);
  assert.ok(fixture.counts().maximum <= 16); assert.equal(fixture.counts().closed, 1);
  assert.equal(fixture.counts().active, 0);
});

test('permission failures produce partial results with bounded error details, not false zero success', async () => {
  const names = Array.from({ length: 25 }, (_, i) => 'denied-' + i);
  const fixture = fakeTree(['readable', ...names], { failures: names });
  const result = await measureSize(fixture.root, fixture);
  assert.equal(result.bytes, 10); assert.equal(result.files, 1); assert.equal(result.errors, 25); assert.equal(result.issues.length, 20);
  assert.equal(result.issues[0].code, 'EACCES');
});

test('cancellation closes directory handles and waits for outstanding reads', async () => {
  const token = { isCancellationRequested: false };
  const fixture = fakeTree(Array.from({ length: 500 }, (_, i) => 'file-' + i), { token, cancelAfter: 31 });
  await assert.rejects(measureSize(fixture.root, { ...fixture, token }), { code: 'CANCELLED' });
  assert.equal(fixture.counts().closed, 1); assert.equal(fixture.counts().active, 0); assert.equal(fixture.counts().reads, 31);
  const early = fakeTree([]);
  await assert.rejects(measureSize(early.root, { ...early, token }), { code: 'CANCELLED' }); assert.equal(early.counts().reads, 0);
});

test('missing selected files propagate errors and unit formatting retains byte precision', async () => {
  await assert.rejects(measureSize(path.join(os.tmpdir(), 'file-size-peek-no-such-file-' + process.pid)), { code: 'ENOENT' });
  assert.equal(formatSize(0), '0 B'); assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1.00 KiB'); assert.equal(formatSize(1024 ** 3 * 1.5), '1.50 GiB');
});
