import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const build = process.env.HORISUB_DIST_DIR ?? 'dist';
const release = process.env.HORISUB_RELEASE_DIR ?? 'release';
const manifest = JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8'));
const output = join(release, 'HoriSub-' + manifest.version + '.zip');
const entries = await readdir(build, { recursive: true, withFileTypes: true });
const paths = entries.filter(entry => entry.isFile())
  .map(entry => relative(build, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
  .sort();
const files = [];
const directory = [];
let offset = 0;
let directorySize = 0;

for (const path of paths) {
  const name = Buffer.from(path);
  const data = await readFile(join(build, path));
  const compressed = deflateRawSync(data);
  const checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  files.push(header, name, compressed);

  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  header.copy(record, 6, 4, 28);
  record.writeUInt16LE(20, 4);
  record.writeUInt32LE(offset, 42);
  directory.push(record, name);
  offset += header.length + name.length + compressed.length;
  directorySize += record.length + name.length;
}

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(paths.length, 8);
end.writeUInt16LE(paths.length, 10);
end.writeUInt32LE(directorySize, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...files, ...directory, end]);
await mkdir(release, { recursive: true });
await writeFile(output, zip);
const checksum = createHash('sha256').update(zip).digest('hex');
await writeFile(output + '.sha256', checksum + '  ' + basename(output) + '\n');
console.log(output, checksum);
