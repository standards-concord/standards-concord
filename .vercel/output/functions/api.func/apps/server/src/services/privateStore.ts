import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { get, put, transaction } from '../db.js';

/**
 * Private data kept by this server (not in a pod): with no Solid server, or for an account with no pod record.
 * On the VM it is files under the data directory; on Vercel, which has no lasting disk, rows in the database
 * (`privateFiles`, one per file, under its owner). Both answer the same way, including the conditional writes a
 * pod's PUT gives (If-Match on a hash of the bytes, If-None-Match: *).
 */
export interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: '*';
}
export class PreconditionFailed extends Error {}

export const localTag = (bytes: Buffer) => `"sha256-${createHash('sha256').update(bytes).digest('hex')}"`;

export interface PrivateStore {
  read(userId: string, relPath: string): Promise<Buffer | undefined>;
  write(userId: string, relPath: string, bytes: Buffer): Promise<void>;
  /** Writes only if `when` holds (see WriteCondition); PreconditionFailed if not. */
  writeIf(userId: string, relPath: string, bytes: Buffer, when: WriteCondition): Promise<void>;
  /** Creates a copy of `bytes` at `relPath` only if nothing is there, keeping the permissions of `like` (files). False if taken. */
  createCopy(userId: string, relPath: string, bytes: Buffer, like: string): Promise<boolean>;
}

/* ------------------------------------------------------------------ files */

const fileOf = (userId: string, relPath: string) => path.join(config.dataDir, 'private', userId, relPath);

/** The permission bits of a file, if it exists. */
const modeOf = (file: string) => {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
};

/** The one temporary name used to replace `file`: a leftover from a crash is simply reused (overwritten), never piled up. */
const tmpFor = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.concord-tmp`);

/**
 * Write a private file only if `when` holds, the way a pod's PUT would:
 * `ifNoneMatch: '*'` creates it exclusively; `ifMatch` replaces it only if its
 * bytes still hash to that tag, through a temporary file (with the original's
 * permissions) renamed into place, so a reader never sees half a file.
 *
 * What this guarantees: no other write by this server can land between the
 * check and the rename, because everything from the read to the rename runs
 * synchronously on the one thread that does all of this server's writes to
 * these files (this assumes one server process per data directory, as deployed).
 * What it doesn't: only Concord is meant to write these files; a program outside
 * Concord editing a file in the instant between the check and the rename can
 * still lose that edit. (Pods get a real compare-and-swap through If-Match.)
 */
function writeLocalIf(file: string, bytes: Buffer, when: WriteCondition) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (when.ifNoneMatch === '*') {
    try {
      fs.writeFileSync(file, bytes, { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new PreconditionFailed(`${file} already exists`);
      throw err;
    }
  }
  let current: Buffer;
  try {
    current = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PreconditionFailed(`${file} is gone`);
    throw err;
  }
  if (localTag(current) !== when.ifMatch) throw new PreconditionFailed(`${file} changed`);
  const tmp = tmpFor(file);
  try {
    // Private from the start (even a leftover from a crash is made 0600 before anything is written to it),
    // and given the original's permissions only once the content is complete.
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      // writeSync may write fewer bytes than asked: keep going until all of them are down.
      for (let off = 0; off < bytes.length; ) {
        const n = fs.writeSync(fd, bytes, off, bytes.length - off);
        if (n <= 0) throw new Error(`could not write ${tmp}`);
        off += n;
      }
      const mode = modeOf(file);
      if (mode !== undefined) fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const files: PrivateStore = {
  async read(userId, relPath) {
    const file = fileOf(userId, relPath);
    try {
      return fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  },
  async write(userId, relPath, bytes) {
    const file = fileOf(userId, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  },
  async writeIf(userId, relPath, bytes, when) {
    writeLocalIf(fileOf(userId, relPath), bytes, when);
  },
  async createCopy(userId, relPath, bytes, like) {
    const aside = fileOf(userId, relPath);
    const mode = modeOf(fileOf(userId, like));
    try {
      // Created exclusively, then given the original's permissions (a private file's copy stays private).
      fs.mkdirSync(path.dirname(aside), { recursive: true });
      fs.writeFileSync(aside, bytes, { flag: 'wx', mode: 0o600 });
      if (mode !== undefined) fs.chmodSync(aside, mode);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  },
};

/* --------------------------------------------------------------- database */

interface PrivateFile {
  id: string;
  /** The bytes, base64. */
  data: string;
}
const rowId = (userId: string, relPath: string) => `${userId}/${path.posix.normalize(relPath).replace(/^\/+/, '')}`;
const readRow = async (userId: string, relPath: string) => {
  const row = await get<PrivateFile>('privateFiles', rowId(userId, relPath));
  return row ? Buffer.from(row.data, 'base64') : undefined;
};
const putRow = (userId: string, relPath: string, bytes: Buffer) => put<PrivateFile>('privateFiles', { id: rowId(userId, relPath), data: bytes.toString('base64') }, userId);

const rows: PrivateStore = {
  read: readRow,
  async write(userId, relPath, bytes) {
    await putRow(userId, relPath, bytes);
  },
  async writeIf(userId, relPath, bytes, when) {
    // Checked and written in one transaction: a real compare-and-swap, on every instance.
    await transaction(async () => {
      const current = await readRow(userId, relPath);
      if (when.ifNoneMatch === '*' && current) throw new PreconditionFailed(`${relPath} already exists`);
      if (when.ifMatch && (!current || localTag(current) !== when.ifMatch)) throw new PreconditionFailed(`${relPath} ${current ? 'changed' : 'is gone'}`);
      await putRow(userId, relPath, bytes);
    });
  },
  async createCopy(userId, relPath, bytes) {
    return transaction(async () => {
      if (await readRow(userId, relPath)) return false;
      await putRow(userId, relPath, bytes);
      return true;
    });
  },
};

export const privateStore = (): PrivateStore => (config.privateStore === 'db' ? rows : files);
