/**
 * Attachment resource admission - real assembled HTTP wire proof.
 *
 * Covers the two attachment-id operations, `GET /attachments/:id/download` and
 * `DELETE /attachments/:id`, after each began with the loaded attachment's own
 * `taskId` through `authorizeTaskAccess` before the unchanged per-attachment
 * action predicate and the unchanged file/row effects.
 *
 * No middleware mocks. Every request crosses a real socket into the real
 * application from `createHttpApplication`; the root error plugin, the
 * repositories, SQLite and the filesystem are real, and the stored bytes are
 * real binary files.
 *
 * Instrument is CALL-THROUGH boundary observation only: spies keep the original
 * implementation, so real bytes still reach disk and real rows still reach the
 * database. Three limits are stated rather than faked:
 *
 *   - `fileStorage.readFile` is the only route call that opens stored bytes, so
 *     "never called" plus an unchanged file inventory is the zero-open proof.
 *   - `attachmentRepo.deleteAttachment` is the only route call that unlinks, and
 *     `fileStorage.deleteFile` is its only unlink; counting both plus the file
 *     inventory is the zero-unlink proof. Returned status alone is not.
 *   - `ensureUploadDir` is reached through the INTERNAL lexical `getFilePath`, so
 *     spying its exported binding cannot prove it was uncalled. The proof used
 *     is the stronger one: a denial against an ABSENT upload directory leaves
 *     the directory absent.
 *
 * `UPLOAD_DIR` is a module-load constant, so it is set in `vi.hoisted`, which
 * vitest lifts above the imports - before any module reads it.
 *
 * What this suite does NOT claim: it does not prove filesystem-DB atomicity,
 * orphan recovery, or immunity to arbitrary triggers. Since the DB-first
 * command landed, the file-before-row abort byte loss and the false zero-row
 * 204 are GONE: the destructive fault tests below now assert bytes-preserved
 * rollback (500/409) and postcommit-only filesystem effects. The exhaustive
 * current-authority/full-identity matrix for the same route lives in
 * taskAttachmentDeleteAuthorityWire.test.ts; this file keeps its wire
 * boundary observations and the closed download suite unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { readFileSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';

import { createHttpApplication, type HttpRuntimeHandle } from '../httpApp.js';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/mission.js';
import * as taskRepo from '../repositories/taskCrud.js';
import * as agentRepo from '../repositories/agent.js';
import * as organizationRepo from '../repositories/organization.js';
import * as teamRepo from '../repositories/team.js';
import * as teamMemberRepo from '../repositories/teamMember.js';
import * as userRepo from '../repositories/user.js';
import * as remotePodRepo from '../repositories/remotePod.js';
import * as remoteParticipantRepo from '../repositories/remoteParticipant.js';
import * as remoteCredentialService from '../services/remoteCredentialService.js';
import * as fileStorage from '../services/fileStorage.js';
import * as attachmentRepo from '../repositories/attachment.js';
import { tasks, missions, taskAttachments, taskEvents, notificationDeliveries, agents } from '../db/schema/index.js';
import { getJwtSecret } from '../middleware/jwt-verification.js';
import * as pluginManager from '../plugins/pluginManager.js';

const env = vi.hoisted(() => {
  const priorUploadDir = process.env.UPLOAD_DIR;
  const dir = `${process.env.TMPDIR || '/tmp'}/orcy-att-resource-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  return { uploadDir: dir, priorUploadDir };
});

const PREFIXES = ['/api/v1', '/api'] as const;

/** A human id that deliberately EQUALS a stored agent-shaped scalar. */
const CROSS_TYPE_USER_ID = 'aar-cross-type-shared-id';

let app: HttpRuntimeHandle;
let baseUrl: string;
let port: number;

let teamId: string;
let teamHabitatId: string;
let personalHabitatId: string;

/** The actual target Task, in the team Habitat. */
let teamTaskId: string;
/** A Task in the personal Habitat, for the personal-Habitat cells. */
let personalTaskId: string;
/** A second team-Habitat Task that `elsewhereAgent` is assigned to. */
let otherTeamTaskId: string;

let memberAdminJwt: string;
let memberEditorJwt: string;
let memberViewerJwt: string;
/** Team role `owner`, JWT role `viewer`: team standing must not grant delete. */
let memberOwnerViewerJwt: string;
let nonmemberAdminJwt: string;
let nonmemberEditorJwt: string;
let nonmemberViewerJwt: string;
let personalAdminJwt: string;
let crossTypeJwt: string;

/** Assigned to the actual target Task. */
let assignedAgentId: string;
let assignedAgentKey: string;
/** NOT assigned to the target Task, and used as the stored uploader. */
let uploaderAgentId: string;
let uploaderAgentKey: string;
/** Assigned to a DIFFERENT team Task, non-uploader. */
let elsewhereAgentId: string;
let elsewhereAgentKey: string;
/** Heartbeat-bound to a personal-Habitat Task, non-uploader. */
let boundAgentId: string;
let boundAgentKey: string;
/** No binding at all. */
let unboundAgentId: string;
let unboundAgentKey: string;

let validRemoteKey: string;

// ---- call-through boundary observation -------------------------------------
let readFileSpy: any;
let deleteAttachmentSpy: any;
let deleteFileSpy: any;
let ensureDirSpy: any;
/** Stored names actually handed to readFile, so the observation is provably live. */
let readFileNames: string[] = [];
/** Stored names actually handed to deleteFile, likewise. */
let deleteFileNames: string[] = [];

beforeEach(() => {
  readFileNames = [];
  deleteFileNames = [];
  readFileSpy?.mockClear();
  deleteAttachmentSpy?.mockClear();
  deleteFileSpy?.mockClear();
  ensureDirSpy?.mockClear();
});

// ---- helpers ---------------------------------------------------------------
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function mint(userId: string, role: string): string {
  return jwt.sign({ sub: userId, username: `aar-${userId}`, role }, getJwtSecret(), {
    expiresIn: '1h',
    issuer: 'orcy',
  });
}

function setFk(on: boolean): void {
  getDb().run(on ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(on ? 1 : 0);
}

let columnOrder = 0;
function makeTask(habitatId: string, title: string, createdBy: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `aar-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `aar-mission-${title}`,
    createdBy,
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}

function assign(agentId: string, taskId: string): void {
  getDb().update(tasks).set({ assignedAgentId: agentId }).where(eq(tasks.id, taskId)).run();
  const row = getDb().select({ a: tasks.assignedAgentId }).from(tasks).where(eq(tasks.id, taskId)).get() as
    | { a: string | null }
    | undefined;
  expect(row?.a).toBe(agentId);
}

function assignedAgentOf(taskId: string): string | null {
  const row = getDb().select({ a: tasks.assignedAgentId }).from(tasks).where(eq(tasks.id, taskId)).get() as
    | { a: string | null }
    | undefined;
  return row?.a ?? null;
}

function missionIdForTask(taskId: string): string {
  const row = getDb().select({ missionId: tasks.missionId }).from(tasks).where(eq(tasks.id, taskId)).get() as
    | { missionId: string }
    | undefined;
  if (!row) throw new Error(`task ${taskId} missing`);
  return row.missionId;
}

function attachmentRows(taskId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskAttachments).where(eq(taskAttachments.taskId, taskId)).all()),
  );
}

function rowById(id: string) {
  const all = JSON.parse(
    JSON.stringify(getDb().select().from(taskAttachments).where(eq(taskAttachments.id, id)).all()),
  );
  return all[0];
}

function taskEventsForTask(taskId: string): number {
  const row = getDb().select({ c: sql<number>`count(*)` }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).get();
  return row?.c ?? 0;
}

function deliveryCount(): number {
  const row = getDb().select({ c: sql<number>`count(*)` }).from(notificationDeliveries).get();
  return row?.c ?? 0;
}

/** Stored-file inventory as name -> sha256 of the bytes actually on disk. */
function fileInventory(): Record<string, string> {
  if (!existsSync(env.uploadDir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(env.uploadDir)) {
    const full = join(env.uploadDir, name);
    if (statSync(full).isDirectory()) continue;
    out[name] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return out;
}

function fileBytesInventory(): Record<string, Buffer> {
  if (!existsSync(env.uploadDir)) return {};
  const out: Record<string, Buffer> = {};
  for (const name of readdirSync(env.uploadDir)) {
    const full = join(env.uploadDir, name);
    if (statSync(full).isDirectory()) continue;
    out[name] = readFileSync(full);
  }
  return out;
}

/** Restores a captured byte inventory exactly, removing whatever the case left. */
function restoreFileBytes(saved: Record<string, Buffer>): void {
  rmSync(env.uploadDir, { recursive: true, force: true });
  mkdirSync(env.uploadDir, { recursive: true });
  for (const [name, bytes] of Object.entries(saved)) {
    writeFileSync(join(env.uploadDir, name), bytes);
  }
}

/** Everything a rejected request must leave untouched. */
function worldSnapshot(taskId: string) {
  return {
    rows: attachmentRows(taskId),
    files: fileInventory(),
    taskEvents: taskEventsForTask(taskId),
    deliveries: deliveryCount(),
  };
}

/**
 * A snapshot is only evidence if it captured a live world: with FK
 * enforcement on and a freshly made fixture the rows/files are nonempty, so
 * a later `toEqual(before)` cannot pass vacuously. (No audit-events table
 * exists in this API's schema; task events and notification deliveries are
 * the observable event surfaces here.)
 */
function expectLiveSnapshot(before: ReturnType<typeof worldSnapshot>): void {
  expect(before.rows.length).toBeGreaterThan(0);
  expect(Object.keys(before.files).length).toBeGreaterThan(0);
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  badAgentKey?: string;
}
function authHeaders(opts: WireOpts): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers['x-agent-api-key'] = opts.agentKey;
  if (opts.remoteKey) headers['x-orcy-remote-key'] = opts.remoteKey;
  if (opts.badAgentKey) headers['x-agent-api-key'] = opts.badAgentKey;
  return headers;
}

async function readWire(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  let body: any = null;
  try {
    body = JSON.parse(buf.toString('utf-8'));
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, bytes: buf, text: buf.toString('utf-8'), headers: res.headers };
}

interface Made {
  id: string;
  filename: string;
  bytes: Buffer;
  originalName: string;
}

/**
 * Creates a real stored file plus its real row. Every ALLOWED delete case uses
 * its own fresh target so no case can pass against a row another case removed.
 */
function makeAttachment(
  taskId: string,
  opts: {
    uploadedBy: string | null;
    originalName?: string;
    mimeType?: string;
    bytes?: Buffer;
    storedAs?: string;
    /** Skip the file write: for a row whose stored name is a DIRECTORY. */
    skipWrite?: boolean;
  },
): Made {
  const originalName = opts.originalName ?? 'aar-fixture.txt';
  const bytes = opts.bytes ?? Buffer.from(`aar-bytes-${randomUUID()}`, 'utf-8');
  const filename = opts.storedAs ?? `${randomUUID()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  if (!opts.skipWrite) writeFileSync(join(env.uploadDir, filename), bytes);
  const id = attachmentRepo.createAttachment({
    taskId,
    filename,
    originalName,
    mimeType: opts.mimeType ?? 'text/plain',
    sizeBytes: bytes.length,
    uploadedBy: opts.uploadedBy,
  }).id;
  return { id, filename, bytes, originalName };
}

async function download(prefix: string, attachmentId: string, opts: WireOpts = {}, query = '') {
  const res = await fetch(`${baseUrl}${prefix}/attachments/${attachmentId}/download${query}`, {
    method: 'GET',
    headers: authHeaders(opts),
  });
  return readWire(res);
}

async function del(prefix: string, attachmentId: string, opts: WireOpts = {}, body?: unknown) {
  const headers: Record<string, string> = { ...authHeaders(opts) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${prefix}/attachments/${attachmentId}`, {
    method: 'DELETE',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readWire(res);
}

/** Raw HTTP/1.1 over a real socket, for the GET-with-body spoof proof. */
function rawRequest(raw: string): Promise<{ status: number | null; raw: string }> {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve({ status: parseStatus(buf), raw: buf });
    };
    sock.on('error', done);
    sock.on('data', (d) => {
      buf += d.toString('binary');
    });
    sock.on('close', () => done());
    sock.connect(port, '127.0.0.1', () => sock.write(raw));
    setTimeout(() => done(), 8000).unref?.();
  });
}

function parseStatus(buf: string): number | null {
  const m = /HTTP\/1\.1 (\d{3})/.exec(buf);
  return m ? Number(m[1]) : null;
}

// ---- suite -----------------------------------------------------------------
beforeAll(async () => {
  mkdirSync(env.uploadDir, { recursive: true });
  await initTestDb();
  // Normal fixtures run with FK enforcement ON. Only the corrupt-ancestry
  // fixtures disable it, each inside a finally that restores and re-asserts it.
  setFk(true);

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  port = await freePort();
  await app.listen({ port, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${port}`;

  // Call-through wrappers: real bytes still hit disk, real rows still land.
  const originalReadFile = fileStorage.readFile;
  readFileSpy = vi.spyOn(fileStorage, 'readFile').mockImplementation((name: string) => {
    readFileNames.push(name);
    return originalReadFile(name);
  });
  const originalDeleteFile = fileStorage.deleteFile;
  deleteFileSpy = vi.spyOn(fileStorage, 'deleteFile').mockImplementation((name: string) => {
    deleteFileNames.push(name);
    return originalDeleteFile(name);
  });
  deleteAttachmentSpy = vi.spyOn(attachmentRepo, 'deleteAttachment');
  ensureDirSpy = vi.spyOn(fileStorage, 'ensureUploadDir');

  const org = organizationRepo.createOrganization({ name: 'aar-org', slug: `aar-org-${Date.now()}` });
  teamId = teamRepo.createTeam({ organizationId: org.id, name: 'aar-team', slug: `aar-team-${Date.now()}` }).id;
  teamHabitatId = habitatRepo.createHabitat({ name: 'aar-team-habitat', teamId }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: 'aar-personal-habitat' }).id;

  // Real user rows BEFORE membership: with FK ON, team_members.user_id
  // references users.id, so the ordering is load-bearing, not cosmetic.
  const now = new Date().toISOString();
  for (const [userId, role] of [
    ['aar-member-admin', 'admin'],
    ['aar-member-editor', 'editor'],
    ['aar-member-viewer', 'viewer'],
    ['aar-member-owner', 'viewer'],
    ['aar-nonmember-admin', 'admin'],
    ['aar-nonmember-editor', 'editor'],
    ['aar-nonmember-viewer', 'viewer'],
    ['aar-personal-admin', 'admin'],
    [CROSS_TYPE_USER_ID, 'viewer'],
  ] as const) {
    userRepo.createUser({
      id: userId,
      username: `aar-${userId}`,
      passwordHash: 'aar-unused-hash',
      role,
      createdAt: now,
      updatedAt: now,
    });
  }
  teamMemberRepo.addMember({ teamId, userId: 'aar-member-admin', role: 'member' });
  teamMemberRepo.addMember({ teamId, userId: 'aar-member-editor', role: 'member' });
  teamMemberRepo.addMember({ teamId, userId: 'aar-member-viewer', role: 'member' });
  teamMemberRepo.addMember({ teamId, userId: 'aar-member-owner', role: 'owner' });
  // The cross-type user IS a team member: the scalar-equality cell must isolate
  // the stored-uploader comparison, not the parent membership check.
  teamMemberRepo.addMember({ teamId, userId: CROSS_TYPE_USER_ID, role: 'member' });
  // Fixture ownership asserted before any proof runs: the nonmembers
  // deliberately have NO membership row.
  expect(teamMemberRepo.listMembers(teamId).length).toBe(5);
  expect(teamMemberRepo.listMembers(teamId).some((m: any) => m.userId === 'aar-nonmember-admin')).toBe(false);

  memberAdminJwt = mint('aar-member-admin', 'admin');
  memberEditorJwt = mint('aar-member-editor', 'editor');
  memberViewerJwt = mint('aar-member-viewer', 'viewer');
  // Team role owner, JWT role viewer: the two must stay distinguishable.
  memberOwnerViewerJwt = mint('aar-member-owner', 'viewer');
  nonmemberAdminJwt = mint('aar-nonmember-admin', 'admin');
  nonmemberEditorJwt = mint('aar-nonmember-editor', 'editor');
  nonmemberViewerJwt = mint('aar-nonmember-viewer', 'viewer');
  personalAdminJwt = mint('aar-personal-admin', 'admin');
  crossTypeJwt = mint(CROSS_TYPE_USER_ID, 'viewer');

  const mkAgent = (name: string) =>
    agentRepo.createAgent({ name, type: 'claude-code', domain: 'fullstack', capabilities: [] });

  const assigned = mkAgent('aar-assigned-agent');
  assignedAgentId = assigned.agent.id;
  assignedAgentKey = assigned.plainApiKey;

  const uploader = mkAgent('aar-uploader-agent');
  uploaderAgentId = uploader.agent.id;
  uploaderAgentKey = uploader.plainApiKey;

  const elsewhere = mkAgent('aar-elsewhere-agent');
  elsewhereAgentId = elsewhere.agent.id;
  elsewhereAgentKey = elsewhere.plainApiKey;

  const bound = mkAgent('aar-bound-agent');
  boundAgentId = bound.agent.id;
  boundAgentKey = bound.plainApiKey;
  const unbound = mkAgent('aar-unbound-agent');
  unboundAgentId = unbound.agent.id;
  unboundAgentKey = unbound.plainApiKey;

  // GENUINE cross-kind collision, not a JWT-only fiction: a REAL agent row
  // whose id equals the human user's id. createAgent mints its own uuid, so
  // the primary key is retargeted by a direct update; the row keeps a real
  // unique name. The human row with the same id is a real FK-backed team
  // member, so CROSS_TYPE_USER_ID names BOTH a member human and an agent,
  // and the stored untyped uploadedBy scalar cannot distinguish them.
  const crossKindAgent = mkAgent('aar-cross-type-agent');
  getDb().update(agents).set({ id: CROSS_TYPE_USER_ID }).where(eq(agents.id, crossKindAgent.agent.id)).run();
  expect(agentRepo.getAgentById(CROSS_TYPE_USER_ID)?.id).toBe(CROSS_TYPE_USER_ID);

  teamTaskId = makeTask(teamHabitatId, 'aar-team-task', 'aar-seed');
  otherTeamTaskId = makeTask(teamHabitatId, 'aar-other-team-task', 'aar-seed');
  personalTaskId = makeTask(personalHabitatId, 'aar-personal-task', 'aar-seed');

  assign(assignedAgentId, teamTaskId);
  assign(elsewhereAgentId, otherTeamTaskId);
  // Bound to the personal-Habitat Task, NOT assigned to it: heartbeat presence
  // is not the read predicate.
  agentRepo.heartbeat(boundAgentId, personalTaskId);
  expect(assignedAgentOf(personalTaskId)).toBeNull();

  expect(assignedAgentOf(teamTaskId)).toBe(assignedAgentId);
  expect(assignedAgentOf(otherTeamTaskId)).toBe(elsewhereAgentId);

  // The upload-admission slice's own download control must still pass: the
  // assigned agent reads its own Task's bytes through the unchanged route.
  const control = makeAttachment(teamTaskId, {
    uploadedBy: assignedAgentId,
    originalName: 'assigned.txt',
    bytes: Buffer.from('aar-assigned-download-bytes', 'utf-8'),
  });
  expect(control.id).toBeTruthy();

  // Fully VALID remote credential: still 401 under local_actor.
  const pod = remotePodRepo.createRemotePod({ habitatId: teamHabitatId, name: 'aar-remote-pod' });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: 'remote_orcy',
    displayName: 'aar-remote-orcy',
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: 'api',
    label: 'aar-remote-cred',
  }).plaintextSecret;
}, 180_000);

afterAll(async () => {
  readFileSpy?.mockRestore();
  deleteFileSpy?.mockRestore();
  deleteAttachmentSpy?.mockRestore();
  ensureDirSpy?.mockRestore();
  await app.close();
  closeDb();
  rmSync(env.uploadDir, { recursive: true, force: true });
  if (env.priorUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = env.priorUploadDir;
});

afterEach(() => {
  // Every fixture leaves FK enforcement ON.
  setFk(true);
});

// ===========================================================================
describe('download - actor x operation matrix on both prefixes', () => {
  it('serves exact bytes to the assigned agent and to member humans of every JWT role', async () => {
    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ['assigned-agent', { agentKey: assignedAgentKey }],
        ['member-admin', { token: memberAdminJwt }],
        ['member-editor', { token: memberEditorJwt }],
        ['member-viewer', { token: memberViewerJwt }],
        ['owner-standing-viewer-jwt', { token: memberOwnerViewerJwt }],
      ] as const) {
        const bytes = Buffer.concat([Buffer.from('head'), Buffer.from([0, 1, 2, 253, 254, 255]), Buffer.from('tail')]);
        const a = makeAttachment(teamTaskId, {
          uploadedBy: 'aar-member-admin',
          originalName: `matrix-${label}.bin`,
          mimeType: 'application/octet-stream',
          bytes,
        });
        const res = await download(prefix, a.id, opts);
        expect(res.status, `${label} download ${prefix}`).toBe(200);
        // Byte equality including the null and high bytes.
        expect(res.bytes.equals(bytes), `${label} bytes ${prefix}`).toBe(true);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        // Positive control: the call-through observation is live, not vacuous.
        expect(readFileSpy).toHaveBeenCalled();
        expect(readFileNames).toContain(a.filename);
      }
    }
  });

  it('admits any authenticated human to a personal-Habitat attachment regardless of team membership', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(personalTaskId, {
        uploadedBy: 'aar-personal-admin',
        originalName: 'personal.txt',
        bytes: Buffer.from('aar-personal-bytes', 'utf-8'),
      });
      for (const [label, token] of [
        ['personal-admin', personalAdminJwt],
        // A nonmember of the TEAM is admitted: a personal Habitat has no teamId.
        ['team-nonmember-admin', nonmemberAdminJwt],
      ] as const) {
        const res = await download(prefix, a.id, { token });
        expect(res.status, `${label} personal download ${prefix}`).toBe(200);
        expect(res.bytes.equals(a.bytes)).toBe(true);
      }
    }
  });

  it('403s the uploader agent when it is NOT assigned: uploader never grants read', async () => {
    // The mutant this kills: a broad-helper-only or uploader-read route.
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: uploaderAgentId,
        originalName: 'uploader-read.txt',
        bytes: Buffer.from('AAR-UPLOADER-BYTES', 'utf-8'),
      });
      expect(assignedAgentOf(teamTaskId)).toBe(assignedAgentId);
      const before = worldSnapshot(teamTaskId);
      expectLiveSnapshot(before);

      const res = await download(prefix, a.id, { agentKey: uploaderAgentKey });
      expect(res.status, `uploader-agent read ${prefix}`).toBe(403);
      expect(res.body.error).toBe('Agent not assigned to this task');
      // Zero open, zero row/file/event/delivery change, no bytes returned.
      expect(readFileSpy, 'denied read must not open stored bytes').not.toHaveBeenCalled();
      expect(res.text).not.toContain('AAR-UPLOADER-BYTES');
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
  });

  it('403s every non-assigned agent shape on read, uploader or not', async () => {
    for (const prefix of PREFIXES) {
      // Non-uploader, assigned to a DIFFERENT team Task.
      const other = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'elsewhere.txt',
        bytes: Buffer.from('AAR-ELSEWHERE', 'utf-8'),
      });
      const elsewhereRes = await download(prefix, other.id, { agentKey: elsewhereAgentKey });
      expect(elsewhereRes.status, `elsewhere-assigned agent read ${prefix}`).toBe(403);
      expect(elsewhereRes.body.error).toBe('Agent not assigned to this task');

      // Heartbeat-bound elsewhere, non-uploader.
      const boundTarget = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'bound.txt',
        bytes: Buffer.from('AAR-BOUND', 'utf-8'),
      });
      const boundRes = await download(prefix, boundTarget.id, { agentKey: boundAgentKey });
      expect(boundRes.status, `bound agent read ${prefix}`).toBe(403);
      expect(boundRes.body.error).toBe('Agent not assigned to this task');

      // Unbound, non-uploader.
      const unboundTarget = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'unbound.txt',
        bytes: Buffer.from('AAR-UNBOUND', 'utf-8'),
      });
      const unboundRes = await download(prefix, unboundTarget.id, { agentKey: unboundAgentKey });
      expect(unboundRes.status, `unbound agent read ${prefix}`).toBe(403);
      expect(unboundRes.body.error).toBe('Agent not assigned to this task');

      expect(readFileSpy).not.toHaveBeenCalled();
    }
  });

  it('403s BOARD_ACCESS_DENIED for a team nonmember before the action predicate, for every JWT role', async () => {
    for (const prefix of PREFIXES) {
      for (const [label, token] of [
        ['nonmember-admin', nonmemberAdminJwt],
        ['nonmember-editor', nonmemberEditorJwt],
        ['nonmember-viewer', nonmemberViewerJwt],
      ] as const) {
        // The nonmember is NOT the uploader, so without the parent guard the
        // human-read branch alone would allow this. Membership is the delta.
        const a = makeAttachment(teamTaskId, {
          uploadedBy: 'aar-member-admin',
          originalName: `nonmember-${label}.txt`,
          bytes: Buffer.from(`AAR-NONMEMBER-BYTES-${label}`, 'utf-8'),
        });
        const before = worldSnapshot(teamTaskId);

        const res = await download(prefix, a.id, { token });
        expect(res.status, `${label} read ${prefix}`).toBe(403);
        expect(res.body.code).toBe('BOARD_ACCESS_DENIED');
        expect(res.body.error).toBe('You do not have access to this habitat');
        expect(res.text).not.toContain('AAR-NONMEMBER-BYTES');
        expectLiveSnapshot(before);
        expect(readFileSpy).not.toHaveBeenCalled();
        expect(worldSnapshot(teamTaskId)).toEqual(before);
      }
    }
  });

  it('gives a team nonmember NO bypass as the stored uploader', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-nonmember-admin',
        originalName: 'nonmember-uploader.txt',
        bytes: Buffer.from('AAR-NONMEMBER-UPLOADER', 'utf-8'),
      });
      const res = await download(prefix, a.id, { token: nonmemberAdminJwt });
      expect(res.status, `nonmember uploader read ${prefix}`).toBe(403);
      expect(res.body.code).toBe('BOARD_ACCESS_DENIED');
      expect(readFileSpy).not.toHaveBeenCalled();
    }
  });

  it('reproduces the stored MIME and the existing RFC5987 Content-Disposition for a Unicode/quoted name', async () => {
    for (const prefix of PREFIXES) {
      // Parentheses AND a double quote: both must survive the RFC5987
      // extended parameter and be sanitized out of the ASCII fallback.
      const originalName = 'ドキュメント (1) "final".pdf';
      const bytes = Buffer.from('aar-unicode-bytes', 'utf-8');
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName,
        mimeType: 'application/pdf',
        bytes,
      });
      const res = await fetch(`${baseUrl}${prefix}/attachments/${a.id}/download`, {
        method: 'GET',
        headers: authHeaders({ token: memberAdminJwt }),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      expect(res.status, `unicode download ${prefix}`).toBe(200);
      expect(buf.equals(bytes)).toBe(true);
      expect(res.headers.get('content-type')).toBe('application/pdf');

      const cd = res.headers.get('content-disposition');
      expect(cd, `content-disposition ${prefix}`).toBeTruthy();
      // Structure asserted independently of the helper's implementation.
      const fallback = /filename="([^"]*)"/.exec(cd!);
      const extended = /filename\*=UTF-8''([^;]+)/.exec(cd!);
      expect(fallback, `ascii fallback ${prefix}`).toBeTruthy();
      expect(extended, `filename* ${prefix}`).toBeTruthy();
      // The ASCII fallback never carries a separator or a non-ASCII byte.
      expect(fallback![1]).toMatch(/^[a-zA-Z0-9._-]*$/);
      expect(decodeURIComponent(extended![1])).toBe(originalName);
    }
  });
});

// ===========================================================================
describe('delete - actor x operation matrix on both prefixes', () => {
  it('204s for the stored uploader agent even when it is not assigned, removing exactly that row and file', async () => {
    for (const prefix of PREFIXES) {
      // Baseline the cumulative name log per iteration: without this the
      // second prefix's toEqual([a.filename]) sees both prefixes' deletes.
      deleteFileNames.length = 0;
      const a = makeAttachment(teamTaskId, {
        uploadedBy: uploaderAgentId,
        originalName: 'uploader-delete.txt',
        bytes: Buffer.from('aar-uploader-delete-bytes', 'utf-8'),
      });
      const sibling = makeAttachment(teamTaskId, {
        uploadedBy: uploaderAgentId,
        originalName: 'sibling.txt',
        bytes: Buffer.from('aar-sibling-bytes', 'utf-8'),
      });

      const res = await del(prefix, a.id, { agentKey: uploaderAgentKey });
      expect(res.status, `uploader-agent delete ${prefix}`).toBe(204);
      expect(res.text).toBe('');

      // Exact row and file gone; the sibling row and file survive.
      expect(rowById(a.id)).toBeUndefined();
      expect(existsSync(join(env.uploadDir, a.filename))).toBe(false);
      expect(rowById(sibling.id)).toBeTruthy();
      expect(existsSync(join(env.uploadDir, sibling.filename))).toBe(true);
      expect(deleteFileNames).toEqual([a.filename]);
    }
  });

  it('204s for the assigned agent even when it is not the uploader', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'assigned-delete.txt',
        bytes: Buffer.from('aar-assigned-delete-bytes', 'utf-8'),
      });
      const res = await del(prefix, a.id, { agentKey: assignedAgentKey });
      expect(res.status, `assigned-agent delete ${prefix}`).toBe(204);
      expect(rowById(a.id)).toBeUndefined();
      expect(existsSync(join(env.uploadDir, a.filename))).toBe(false);
    }
  });

  it('403s the action predicate for a non-assigned, non-uploader agent', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'agent-denied.txt',
        bytes: Buffer.from('AAR-AGENT-DENIED', 'utf-8'),
      });
      const before = worldSnapshot(teamTaskId);

      const res = await del(prefix, a.id, { agentKey: unboundAgentKey });
      expect(res.status, `unbound-agent delete ${prefix}`).toBe(403);
      expect(res.body.error).toBe('Not authorized to delete this attachment');
      // Zero unlink, zero row delete.
      expectLiveSnapshot(before);
      expect(deleteAttachmentSpy, 'denied delete must not reach the repository').not.toHaveBeenCalled();
      expect(deleteFileSpy, 'denied delete must not unlink').not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
  });

  it('204s for member humans by JWT admin/editor role and 403s a member viewer who is not the uploader', async () => {
    for (const prefix of PREFIXES) {
      const forAdmin = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-viewer',
        originalName: 'admin-role.txt',
        bytes: Buffer.from('aar-admin-role', 'utf-8'),
      });
      const adminRes = await del(prefix, forAdmin.id, { token: memberAdminJwt });
      expect(adminRes.status, `member admin delete ${prefix}`).toBe(204);
      expect(rowById(forAdmin.id)).toBeUndefined();

      const forEditor = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-viewer',
        originalName: 'editor-role.txt',
        bytes: Buffer.from('aar-editor-role', 'utf-8'),
      });
      const editorRes = await del(prefix, forEditor.id, { token: memberEditorJwt });
      expect(editorRes.status, `member editor delete ${prefix}`).toBe(204);
      expect(rowById(forEditor.id)).toBeUndefined();

      // The mutant this kills: membership as delete authority.
      const forViewer = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'viewer-denied.txt',
        bytes: Buffer.from('AAR-VIEWER-DENIED', 'utf-8'),
      });
      const before = worldSnapshot(teamTaskId);
      expectLiveSnapshot(before);
      // Baseline the cumulative repository spy: two successful deletes ran
      // above in this same test, so "not called" must mean "not called since
      // this baseline", never since test start.
      deleteAttachmentSpy.mockClear();
      const viewerRes = await del(prefix, forViewer.id, { token: memberViewerJwt });
      expect(viewerRes.status, `member viewer delete ${prefix}`).toBe(403);
      expect(viewerRes.body.error).toBe('Not authorized to delete this attachment');
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);

      // A member viewer WHO IS the uploader still deletes: the existing scalar
      // comparison is retained unchanged.
      const viewerUploader = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-viewer',
        originalName: 'viewer-uploader.txt',
        bytes: Buffer.from('aar-viewer-uploader', 'utf-8'),
      });
      const viewerUploaderRes = await del(prefix, viewerUploader.id, { token: memberViewerJwt });
      expect(viewerUploaderRes.status, `member viewer uploader delete ${prefix}`).toBe(204);
      expect(rowById(viewerUploader.id)).toBeUndefined();
    }
  });

  it('does not let TEAM standing substitute for the JWT role: an owner-standing viewer JWT stays 403', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'owner-standing.txt',
        bytes: Buffer.from('AAR-OWNER-STANDING', 'utf-8'),
      });
      const before = worldSnapshot(teamTaskId);
      const res = await del(prefix, a.id, { token: memberOwnerViewerJwt });
      expect(res.status, `owner-standing viewer delete ${prefix}`).toBe(403);
      expect(res.body.error).toBe('Not authorized to delete this attachment');
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
  });

  it('403s BOARD_ACCESS_DENIED for a team nonmember BEFORE the action denial, even as uploader', async () => {
    for (const prefix of PREFIXES) {
      // Nonmember non-uploader: without the parent guard this is the action 403.
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'nonmember-denied.txt',
        bytes: Buffer.from('AAR-NONMEMBER-DENIED', 'utf-8'),
      });
      const before = worldSnapshot(teamTaskId);
      const res = await del(prefix, a.id, { token: nonmemberAdminJwt });
      expect(res.status, `nonmember delete ${prefix}`).toBe(403);
      // Precedence: the MEMBERSHIP code, not the action reason.
      expect(res.body.code).toBe('BOARD_ACCESS_DENIED');
      expect(res.body.error).toBe('You do not have access to this habitat');
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);

      // Nonmember AS the uploader: scalar equality must not survive the guard.
      const asUploader = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-nonmember-admin',
        originalName: 'nonmember-uploader.txt',
        bytes: Buffer.from('AAR-NONMEMBER-UPLOADER-DEL', 'utf-8'),
      });
      const up = await del(prefix, asUploader.id, { token: nonmemberAdminJwt });
      expect(up.status, `nonmember uploader delete ${prefix}`).toBe(403);
      expect(up.body.code).toBe('BOARD_ACCESS_DENIED');
      expect(rowById(asUploader.id)).toBeTruthy();
    }
  });

  it('keeps cross-type scalar equality: a HUMAN whose id equals a stored agent-shaped id may delete', async () => {
    // `uploadedBy` is a nullable UNTYPED scalar. The predicate compares ID text
    // with no principal.type condition, so a human whose id happens to equal an
    // agent id matches. This is a STORAGE limitation, pinned not repaired; no
    // schema migration and no typed-authorship change is in scope.
    // A REAL agent row with this exact id is seeded in beforeAll
    // (aar-cross-type-agent) and the human with the same id is a real
    // FK-backed team member: the stored scalar genuinely cannot distinguish
    // the two kinds, on both route prefixes.
    for (const prefix of PREFIXES) {
      const stored = makeAttachment(teamTaskId, {
        uploadedBy: CROSS_TYPE_USER_ID,
        originalName: 'cross-type.txt',
        bytes: Buffer.from('aar-cross-type', 'utf-8'),
      });
      // The row records neither a type nor a provenance: that IS the limitation.
      expect(rowById(stored.id).uploadedBy).toBe(CROSS_TYPE_USER_ID);

      const allowed = await del(prefix, stored.id, { token: crossTypeJwt });
      expect(allowed.status, `cross-type delete ${prefix}`).toBe(204);
      expect(rowById(stored.id)).toBeUndefined();

      // A different human id does not match, proving the grant is by id text.
      const stranger = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-viewer',
        originalName: 'cross-type-stranger.txt',
        bytes: Buffer.from('aar-cross-type-stranger', 'utf-8'),
      });
      const denied = await del(prefix, stranger.id, { token: crossTypeJwt });
      expect(denied.status, `cross-type stranger denial ${prefix}`).toBe(403);
      expect(denied.body.error).toBe('Not authorized to delete this attachment');
    }
  });

  it('204s personal-Habitat delete for any human admin/editor and 403s a viewer non-uploader', async () => {
    for (const prefix of PREFIXES) {
      // A personal Habitat has no teamId, so ancestry admits ANY human; the
      // unchanged action predicate alone decides delete authority.
      const own = makeAttachment(personalTaskId, {
        uploadedBy: 'aar-personal-admin',
        originalName: 'personal-del.txt',
        bytes: Buffer.from('AAR-PERSONAL-DEL', 'utf-8'),
      });
      const asOwner = await del(prefix, own.id, { token: personalAdminJwt });
      expect(asOwner.status, `personal owner delete ${prefix}`).toBe(204);
      expect(rowById(own.id)).toBeUndefined();

      // A TEAM nonmember admin is still admitted on a personal Habitat.
      const outsider = makeAttachment(personalTaskId, {
        uploadedBy: 'aar-personal-admin',
        originalName: 'personal-outsider.txt',
        bytes: Buffer.from('AAR-PERSONAL-OUTSIDER', 'utf-8'),
      });
      const asOutsider = await del(prefix, outsider.id, { token: nonmemberAdminJwt });
      expect(asOutsider.status, `personal outsider delete ${prefix}`).toBe(204);
      expect(rowById(outsider.id)).toBeUndefined();

      // Viewer JWT, non-uploader: ancestry admits, the predicate denies.
      // Baseline the cumulative spies first: two successful deletes ran above
      // in this same iteration.
      deleteAttachmentSpy.mockClear();
      deleteFileSpy.mockClear();
      const viewerTarget = makeAttachment(personalTaskId, {
        uploadedBy: 'aar-personal-admin',
        originalName: 'personal-viewer.txt',
        bytes: Buffer.from('AAR-PERSONAL-VIEWER', 'utf-8'),
      });
      const asViewer = await del(prefix, viewerTarget.id, { token: memberViewerJwt });
      expect(asViewer.status, `personal viewer delete ${prefix}`).toBe(403);
      expect(asViewer.body.error).toBe('Not authorized to delete this attachment');
      expect(rowById(viewerTarget.id)).toBeTruthy();
      expect(deleteFileSpy).not.toHaveBeenCalled();
    }
  });

  it('403s a bound non-uploader agent and 204s the uploader agent on personal-Habitat operations', async () => {
    for (const prefix of PREFIXES) {
      // Baseline the cumulative spies per iteration: the previous iteration's
      // successful uploader delete must not count against this one's denials.
      readFileSpy.mockClear();
      deleteAttachmentSpy.mockClear();
      deleteFileSpy.mockClear();
      deleteFileNames.length = 0;
      const target = makeAttachment(personalTaskId, {
        uploadedBy: 'aar-personal-admin',
        originalName: 'personal-agent.txt',
        bytes: Buffer.from('AAR-PERSONAL-AGENT', 'utf-8'),
      });
      // Heartbeat-bound is not assigned: no read, no delete.
      const boundRead = await download(prefix, target.id, { agentKey: boundAgentKey });
      expect(boundRead.status, `bound agent personal read ${prefix}`).toBe(403);
      expect(boundRead.body.error).toBe('Agent not assigned to this task');
      expect(readFileSpy).not.toHaveBeenCalled();

      const boundDelete = await del(prefix, target.id, { agentKey: boundAgentKey });
      expect(boundDelete.status, `bound agent personal delete ${prefix}`).toBe(403);
      expect(boundDelete.body.error).toBe('Not authorized to delete this attachment');
      expect(rowById(target.id)).toBeTruthy();
      expect(deleteFileSpy).not.toHaveBeenCalled();

      // The uploader scalar survives on a personal Habitat: the unassigned
      // uploader agent deletes ITS OWN row, and uploader never grants read.
      const owned = makeAttachment(personalTaskId, {
        uploadedBy: uploaderAgentId,
        originalName: 'personal-uploader-owned.txt',
        bytes: Buffer.from('AAR-PERSONAL-UPLOADER-OWNED', 'utf-8'),
      });
      const uploaderRead = await download(prefix, owned.id, { agentKey: uploaderAgentKey });
      expect(uploaderRead.status, `uploader agent personal read ${prefix}`).toBe(403);
      expect(uploaderRead.body.error).toBe('Agent not assigned to this task');

      const uploaderDelete = await del(prefix, owned.id, { agentKey: uploaderAgentKey });
      expect(uploaderDelete.status, `uploader agent personal delete ${prefix}`).toBe(204);
      expect(rowById(owned.id)).toBeUndefined();
    }
  });

  it('403s elsewhere-assigned and bound agents on team-Habitat delete with the action reason', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'agent-shapes-del.txt',
        bytes: Buffer.from('AAR-AGENT-SHAPES-DEL', 'utf-8'),
      });
      const before = worldSnapshot(teamTaskId);
      expectLiveSnapshot(before);
      const elsewhereRes = await del(prefix, a.id, { agentKey: elsewhereAgentKey });
      expect(elsewhereRes.status, `elsewhere agent delete ${prefix}`).toBe(403);
      expect(elsewhereRes.body.error).toBe('Not authorized to delete this attachment');
      const boundRes = await del(prefix, a.id, { agentKey: boundAgentKey });
      expect(boundRes.status, `bound agent delete ${prefix}`).toBe(403);
      expect(boundRes.body.error).toBe('Not authorized to delete this attachment');
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
  });

  it('does not match a null uploadedBy to any authenticated principal', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: null,
        originalName: 'null-uploader.txt',
        bytes: Buffer.from('AAR-NULL-UPLOADER', 'utf-8'),
      });
      expect(rowById(a.id).uploadedBy).toBeNull();
      const asViewer = await del(prefix, a.id, { token: memberViewerJwt });
      expect(asViewer.status, `null uploader viewer ${prefix}`).toBe(403);
      expect(rowById(a.id)).toBeTruthy();
      // The assigned agent is not the uploader either, but assignment allows.
      const asAgent = await del(prefix, a.id, { agentKey: assignedAgentKey });
      expect(asAgent.status, `null uploader assigned agent ${prefix}`).toBe(204);
    }
  });
});

// ===========================================================================
describe('credential precedence - 401 precedes every row lookup', () => {
  it('401s anonymous, invalid local key and a fully valid remote-only credential for both operations', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'cred.txt',
        bytes: Buffer.from('AAR-CRED', 'utf-8'),
      });
      for (const opts of [{}, { badAgentKey: 'aar-not-a-real-key' }, { remoteKey: validRemoteKey }]) {
        const before = worldSnapshot(teamTaskId);
        const get = await download(prefix, a.id, opts as WireOpts);
        expect(get.status, `401 download ${prefix}`).toBe(401);
        expect(readFileSpy).not.toHaveBeenCalled();
        const remove = await del(prefix, a.id, opts as WireOpts);
        expect(remove.status, `401 delete ${prefix}`).toBe(401);
        expect(deleteAttachmentSpy).not.toHaveBeenCalled();
        expect(worldSnapshot(teamTaskId)).toEqual(before);
      }
    }
  });

  it('keeps 401 ahead of the resource 404, so a failed credential never becomes an existence oracle', async () => {
    for (const prefix of PREFIXES) {
      const known = await download(prefix, 'aar-definitely-not-an-id', { agentKey: assignedAgentKey });
      expect(known.status, `unknown id, valid credential ${prefix}`).toBe(404);
      expect(known.body.error).toBe('Attachment not found');
      const unknownCred = await download(prefix, 'aar-definitely-not-an-id', { remoteKey: validRemoteKey });
      expect(unknownCred.status, `unknown id, remote-only ${prefix}`).toBe(401);
    }
  });

  it('401s an invalid local key supplied alongside a VALID human JWT', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'mixed.txt',
        bytes: Buffer.from('AAR-MIXED', 'utf-8'),
      });
      const res = await download(prefix, a.id, { badAgentKey: 'aar-not-a-real-key', token: memberAdminJwt });
      expect(res.status, `invalid key + valid JWT ${prefix}`).toBe(401);
      expect(res.body.code).toBe('INVALID_API_KEY');
      expect(readFileSpy).not.toHaveBeenCalled();
    }
  });

  it('gives a valid local key precedence over human and remote headers', async () => {
    for (const prefix of PREFIXES) {
      // The assigned agent key wins: a nonmember human header cannot deny it.
      const a = makeAttachment(teamTaskId, {
        uploadedBy: assignedAgentId,
        originalName: 'precedence.txt',
        bytes: Buffer.from('AAR-PRECEDENCE', 'utf-8'),
      });
      const asAgent = await download(prefix, a.id, {
        agentKey: assignedAgentKey,
        token: nonmemberAdminJwt,
        remoteKey: validRemoteKey,
      });
      expect(asAgent.status, `agent key wins ${prefix}`).toBe(200);
      expect(asAgent.bytes.equals(a.bytes)).toBe(true);
    }
  });
});

// ===========================================================================
describe('error precedence - resource, ancestry, membership, action, disk', () => {
  it('404s an unknown attachment id FIRST, even for a team nonmember admin', async () => {
    for (const prefix of PREFIXES) {
      const res = await download(prefix, 'aar-no-such-attachment', { token: nonmemberAdminJwt });
      expect(res.status, `unknown attachment download ${prefix}`).toBe(404);
      expect(res.body.error).toBe('Attachment not found');
      // The ancestry check never ran, so no parent read happened at all.
      expect(readFileSpy).not.toHaveBeenCalled();
      const remove = await del(prefix, 'aar-no-such-attachment', { token: nonmemberAdminJwt });
      expect(remove.status, `unknown attachment delete ${prefix}`).toBe(404);
      expect(remove.body.error).toBe('Attachment not found');
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
    }
  });

  it('404s a known attachment whose Task is missing - the explicit 403 to 404 delta', async () => {
    // On the BASE implementation the predicate returned
    // {allowed:false, reason:'Task not found'} and the route mapped 403.
    // Ancestry admission now runs first, so the answer is 404.
    setFk(false);
    try {
      const name = `${randomUUID()}-orphan-task.txt`;
      const bytes = Buffer.from('AAR-ORPHAN-TASK', 'utf-8');
      writeFileSync(join(env.uploadDir, name), bytes);
      const id = getDb()
        .insert(taskAttachments)
        .values({
          id: randomUUID(),
          taskId: 'aar-orphan-task',
          filename: name,
          originalName: 'orphan-task.txt',
          mimeType: 'text/plain',
          sizeBytes: bytes.length,
          uploadedBy: 'aar-member-admin',
        })
        .returning({ id: taskAttachments.id })
        .get()!.id;
      const filesBefore = fileInventory();

      for (const prefix of PREFIXES) {
        const get = await download(prefix, id, { token: memberAdminJwt });
        expect(get.status, `missing task download ${prefix}`).toBe(404);
        expect(get.body.error).toBe('Task not found');
        const remove = await del(prefix, id, { token: memberAdminJwt });
        expect(remove.status, `missing task delete ${prefix}`).toBe(404);
        expect(remove.body.error).toBe('Task not found');
        // Every failed-credential shape stays 401 on this orphan row too:
        // the credential precedes any ancestry or row lookup.
        for (const badOpts of [{}, { badAgentKey: 'aar-not-a-real-key' }, { remoteKey: validRemoteKey }]) {
          const badGet = await download(prefix, id, badOpts as WireOpts);
          expect(badGet.status, `orphan 401 download ${prefix}`).toBe(401);
          const badDel = await del(prefix, id, badOpts as WireOpts);
          expect(badDel.status, `orphan 401 delete ${prefix}`).toBe(401);
        }
      }
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(fileInventory()).toEqual(filesBefore);
      expect(rowById(id)).toBeTruthy();
    } finally {
      setFk(true);
    }
  });

  it('404s a missing Mission and a missing Habitat, with zero effects', async () => {
    const missionId = missionIdForTask(teamTaskId);
    setFk(false);
    try {
      getDb().update(tasks).set({ missionId: 'aar-no-such-mission' }).where(eq(tasks.id, teamTaskId)).run();
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'no-mission.txt',
        bytes: Buffer.from('AAR-NO-MISSION', 'utf-8'),
      });
      const filesBefore = fileInventory();
      for (const prefix of PREFIXES) {
        const get = await download(prefix, a.id, { token: memberAdminJwt });
        expect(get.status, `missing mission download ${prefix}`).toBe(404);
        expect(get.body.error).toBe('Mission not found');
        const remove = await del(prefix, a.id, { token: memberAdminJwt });
        expect(remove.status, `missing mission delete ${prefix}`).toBe(404);
        expect(remove.body.error).toBe('Mission not found');
      }
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(fileInventory()).toEqual(filesBefore);
      expect(rowById(a.id)).toBeTruthy();
    } finally {
      getDb().update(tasks).set({ missionId }).where(eq(tasks.id, teamTaskId)).run();
      setFk(true);
    }

    setFk(false);
    try {
      getDb().update(missions).set({ habitatId: 'aar-no-such-habitat' }).where(eq(missions.id, missionId)).run();
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'no-habitat.txt',
        bytes: Buffer.from('AAR-NO-HABITAT', 'utf-8'),
      });
      const filesBefore = fileInventory();
      for (const prefix of PREFIXES) {
        const get = await download(prefix, a.id, { token: memberAdminJwt });
        expect(get.status, `missing habitat download ${prefix}`).toBe(404);
        expect(get.body.error).toBe('Habitat not found');
        const remove = await del(prefix, a.id, { token: memberAdminJwt });
        expect(remove.status, `missing habitat delete ${prefix}`).toBe(404);
        expect(remove.body.error).toBe('Habitat not found');
      }
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(fileInventory()).toEqual(filesBefore);
    } finally {
      getDb().update(missions).set({ habitatId: teamHabitatId }).where(eq(missions.id, missionId)).run();
      setFk(true);
    }
  });

  it('orders membership 403 ahead of the action denial and ahead of a missing-file 404', async () => {
    for (const prefix of PREFIXES) {
      // A KNOWN attachment whose stored file is ABSENT.
      const absent = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'missing-file.txt',
        bytes: Buffer.from('AAR-MISSING-FILE', 'utf-8'),
      });
      rmSync(join(env.uploadDir, absent.filename), { force: true });

      // Admitted member human read of an absent file: 404, row retained.
      const admitted = await download(prefix, absent.id, { token: memberAdminJwt });
      expect(admitted.status, `admitted read of missing file ${prefix}`).toBe(404);
      expect(admitted.body.error).toBe('File not found on disk');
      expect(rowById(absent.id)).toBeTruthy();

      // Nonmember: 403, never the 404 - no existence oracle across teams.
      const denied = await download(prefix, absent.id, { token: nonmemberAdminJwt });
      expect(denied.status, `nonmember read of missing file ${prefix}`).toBe(403);
      expect(denied.body.code).toBe('BOARD_ACCESS_DENIED');

      // Nonmember delete of the same absent-file row is 403 before any disk work.
      const deniedDelete = await del(prefix, absent.id, { token: nonmemberViewerJwt });
      expect(deniedDelete.status, `nonmember delete of missing file ${prefix}`).toBe(403);
      expect(deniedDelete.body.code).toBe('BOARD_ACCESS_DENIED');
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(rowById(absent.id)).toBeTruthy();
    }
  });

  it('204s an allowed delete of a row whose stored file is already absent, removing the row', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'delete-missing-file.txt',
        bytes: Buffer.from('aar-delete-missing-file', 'utf-8'),
      });
      rmSync(join(env.uploadDir, a.filename), { force: true });
      const res = await del(prefix, a.id, { token: memberAdminJwt });
      expect(res.status, `delete missing file ${prefix}`).toBe(204);
      expect(rowById(a.id)).toBeUndefined();
    }
  });

  it('404s a repeat delete of an already removed target, never a false 204', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'repeat.txt',
        bytes: Buffer.from('aar-repeat', 'utf-8'),
      });
      expect((await del(prefix, a.id, { token: memberAdminJwt })).status, `first delete ${prefix}`).toBe(204);
      const again = await del(prefix, a.id, { token: memberAdminJwt });
      expect(again.status, `repeat delete ${prefix}`).toBe(404);
      expect(again.body.error).toBe('Attachment not found');
    }
  });

  it('keeps parent absence ahead of resource privilege, and membership ahead of the action reason', async () => {
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'order.txt',
      bytes: Buffer.from('AAR-ORDER', 'utf-8'),
    });
    const nonmember = await del('/api/v1', a.id, { token: nonmemberViewerJwt });
    expect(nonmember.status).toBe(403);
    expect(nonmember.body.code).toBe('BOARD_ACCESS_DENIED');
    expect(nonmember.body.error).not.toBe('Not authorized to delete this attachment');

    // Nonmember + a KNOWN row whose Task is gone: 404 ancestry, not 403.
    setFk(false);
    try {
      const name = `${randomUUID()}-orphan-2.txt`;
      const bytes = Buffer.from('AAR-ORPHAN-2', 'utf-8');
      writeFileSync(join(env.uploadDir, name), bytes);
      const id = getDb()
        .insert(taskAttachments)
        .values({
          id: randomUUID(),
          taskId: 'aar-orphan-task-2',
          filename: name,
          originalName: 'orphan-2.txt',
          mimeType: 'text/plain',
          sizeBytes: bytes.length,
          uploadedBy: 'aar-member-admin',
        })
        .returning({ id: taskAttachments.id })
        .get()!.id;
      const res = await del('/api/v1', id, { token: nonmemberAdminJwt });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Task not found');
    } finally {
      setFk(true);
    }
  });
});

// ===========================================================================
describe('denial is inert - no open, no unlink, no row, file, event or delivery change', () => {
  it('leaves an ABSENT upload directory absent across every denial, and creates it only when admitted', async () => {
    const saved = fileBytesInventory();
    try {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'nodir.txt',
        bytes: Buffer.from('AAR-NODIR', 'utf-8'),
      });

      rmSync(env.uploadDir, { recursive: true, force: true });
      expect(existsSync(env.uploadDir)).toBe(false);
      ensureDirSpy.mockClear();
      readFileSpy.mockClear();
      deleteFileSpy.mockClear();

      const deniedRead = await download(prefix, a.id, { token: nonmemberAdminJwt });
      expect(deniedRead.status, `denied read, no dir ${prefix}`).toBe(403);
      expect(existsSync(env.uploadDir), 'denied read must not create the upload dir').toBe(false);
      expect(readFileSpy).not.toHaveBeenCalled();

      const deniedDelete = await del(prefix, a.id, { token: nonmemberAdminJwt });
      expect(deniedDelete.status, `denied delete, no dir ${prefix}`).toBe(403);
      expect(existsSync(env.uploadDir), 'denied delete must not create the upload dir').toBe(false);
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(rowById(a.id)).toBeTruthy();

      // Positive control: the SAME fixture with an admitted actor DOES create
      // the directory, so the absence above is caused by the guard and not by
      // an unreachable fixture.
      const admitted = await download(prefix, a.id, { token: memberAdminJwt });
      // The stored bytes were removed WITH the directory, so the actual wire
      // outcome for an admitted read is the missing-file 404 - and the
      // directory existing again proves admission really reached storage
      // (getFilePath created it), which is the positive control.
      expect(admitted.status, `admitted read, no dir ${prefix}`).toBe(404);
      expect(admitted.body.error).toBe('File not found on disk');
      expect(existsSync(env.uploadDir), 'admitted read must create the upload dir').toBe(true);
    }
    } finally {
      // Assertion failures inside the loop must still restore the fixtures.
      restoreFileBytes(saved);
    }
  });

  it('never returns stored bytes or changes any world state for an action-predicate denial', async () => {
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'marker.txt',
      bytes: Buffer.from('AAR-DENIED-MARKER-MUST-NOT-LEAK'),
    });
    const before = worldSnapshot(teamTaskId);
    for (const prefix of PREFIXES) {
      const res = await download(prefix, a.id, { agentKey: elsewhereAgentKey });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain('AAR-DENIED-MARKER');
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
    expectLiveSnapshot(before);
    expect(readFileNames).not.toContain(a.filename);
  });
});

// ===========================================================================
describe('query and body spoof cannot redirect authority', () => {
  it('ignores query taskId, filename, uploader and role on download', async () => {
    const target = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'spoof-target.txt',
      bytes: Buffer.from('AAR-SPOOF-TARGET', 'utf-8'),
    });
    const secret = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'spoof-secret.txt',
      bytes: Buffer.from('AAR-SECRET-BYTES'),
    });
    const other = makeAttachment(otherTeamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'spoof-other.txt',
      bytes: Buffer.from('AAR-OTHER-TASK-BYTES'),
    });
    const query =
      `?taskId=${otherTeamTaskId}&filename=${secret.filename}` +
      `&uploadedBy=aar-member-viewer&role=admin&assignedAgentId=${assignedAgentId}`;

    // A nonmember naming an admin role, another Task, another filename and
    // another uploader in the query is still denied.
    const denied = await download('/api/v1', target.id, { token: nonmemberAdminJwt }, query);
    expect(denied.status, 'spoofed query must not grant a nonmember read').toBe(403);
    expect(denied.body.code).toBe('BOARD_ACCESS_DENIED');
    expect(denied.text).not.toContain('AAR-SPOOF-TARGET');
    expect(denied.text).not.toContain('AAR-SECRET-BYTES');

    // The query never redirects WHICH attachment is read: the real target's
    // bytes come back, never the secret's.
    const okRes = await fetch(
      `${baseUrl}/api/v1/attachments/${target.id}/download?taskId=${other.id}&filename=${secret.filename}`,
      { method: 'GET', headers: authHeaders({ token: memberAdminJwt }) },
    );
    const got = Buffer.from(await okRes.arrayBuffer());
    expect(got.toString('utf-8')).toBe('AAR-SPOOF-TARGET');
    expect(got.toString('utf-8')).not.toContain('AAR-SECRET-BYTES');

    // And it never redirects the acting identity: an agent named in the query
    // does not turn an unbound agent into the assignee.
    const asUnbound = await download('/api/v1', target.id, { agentKey: unboundAgentKey }, query);
    expect(asUnbound.status, 'query must not grant an unbound agent read').toBe(403);
    expect(asUnbound.body.error).toBe('Agent not assigned to this task');
  });

  it('ignores a body on a GET download - proven over a raw socket', async () => {
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'raw-body.txt',
      bytes: Buffer.from('AAR-RAW-BODY', 'utf-8'),
    });
    const payload = JSON.stringify({ taskId: otherTeamTaskId, uploadedBy: 'aar-member-viewer', role: 'admin' });
    const raw = [
      `GET /api/v1/attachments/${a.id}/download HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${nonmemberAdminJwt}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      'Connection: close',
      '',
      payload,
    ].join('\r\n');

    const res = await rawRequest(raw);
    expect(res.status).toBe(403);
    expect(res.raw).toContain('BOARD_ACCESS_DENIED');
    expect(res.raw).not.toContain('AAR-RAW-BODY');
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('ignores body taskId, uploadedBy and role on delete', async () => {
    for (const prefix of PREFIXES) {
      const a = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'body-spoof.txt',
        bytes: Buffer.from('AAR-BODY-SPOOF', 'utf-8'),
      });
      const before = worldSnapshot(teamTaskId);
      const res = await del(prefix, a.id, { token: nonmemberViewerJwt }, {
        taskId: teamTaskId,
        uploadedBy: 'aar-nonmember-viewer',
        role: 'admin',
        assignedAgentId: assignedAgentId,
      });
      expect(res.status, `body spoof ${prefix}`).toBe(403);
      expect(res.body.code).toBe('BOARD_ACCESS_DENIED');
      expect(worldSnapshot(teamTaskId)).toEqual(before);

      // A member viewer naming role=admin and a matching uploadedBy in the body
      // is still denied: the JWT role and the STORED uploader decide, not the body.
      const b = makeAttachment(teamTaskId, {
        uploadedBy: 'aar-member-admin',
        originalName: 'body-role.txt',
        bytes: Buffer.from('AAR-BODY-ROLE', 'utf-8'),
      });
      const viewerRes = await del(
        prefix,
        b.id,
        { token: memberViewerJwt },
        { role: 'admin', uploadedBy: 'aar-member-viewer', taskId: otherTeamTaskId },
      );
      expect(viewerRes.status, `body role spoof ${prefix}`).toBe(403);
      expect(viewerRes.body.error).toBe('Not authorized to delete this attachment');
      expect(rowById(b.id)).toBeTruthy();
    }
  });
});

// ===========================================================================
describe('existing stream and file behaviour is characterized, not repaired', () => {
  it('proves FK enforcement is genuinely ON for normal fixtures: parent deletion cascades rows', () => {
    setFk(true);
    const doomed = makeTask(teamHabitatId, 'aar-cascade-task', 'aar-seed');
    const a = makeAttachment(doomed, {
      uploadedBy: 'aar-member-admin',
      originalName: 'cascade.txt',
      bytes: Buffer.from('AAR-CASCADE', 'utf-8'),
    });
    expect(attachmentRows(doomed).length).toBe(1);
    getDb().delete(tasks).where(eq(tasks.id, doomed)).run();
    expect(attachmentRows(doomed).length).toBe(0);
    // The stored bytes survive the cascade: known orphan-file residual, NOT
    // repaired by this slice and not claimed as a guarantee.
    expect(existsSync(join(env.uploadDir, a.filename))).toBe(true);
  });

  it('surfaces a real EISDIR read fault on an admitted read, leaving row and path unchanged', async () => {
    // existsSync passes for a directory, so the guard does not 404; the Node
    // read stream then fails with EISDIR. This is an ordinary filesystem error
    // and the real root handler owns the outcome, which is measured, not assumed.
    const dirName = `${randomUUID()}-eisdir.bin`;
    mkdirSync(join(env.uploadDir, dirName), { recursive: true });
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'eisdir.txt',
      bytes: Buffer.from('AAR-EISDIR', 'utf-8'),
      // skipWrite: the stored name IS the directory; writing fixture bytes
      // into it would raise EISDIR during SETUP, before any HTTP request.
      storedAs: dirName,
      skipWrite: true,
    });
    const before = fileInventory();

    const res = await download('/api/v1', a.id, { token: memberAdminJwt });
    // MEASURED wire outcome (observed on this stack, pinned exactly): the
    // EISDIR stream failure surfaces BEFORE any data through Fastify's reply
    // payload handling, producing a clean pre-header 500 whose code is
    // FST_ERR_REP_INVALID_PAYLOAD_TYPE - not the root handler's
    // INTERNAL_ERROR, and never a 200 or a post-data JSON 500. This is the
    // actual transport truth for a directory-at-stored-path read fault.
    expect(res.status, 'EISDIR read must be the pre-data 500').toBe(500);
    expect(res.body.code).toBe('FST_ERR_REP_INVALID_PAYLOAD_TYPE');
    // Row and stored path are untouched by a read fault.
    expect(rowById(a.id)).toBeTruthy();
    expect(statSync(join(env.uploadDir, dirName)).isDirectory()).toBe(true);
    expect(fileInventory()).toEqual(before);

    // Positive control: repair the fixture and the SAME route serves bytes.
    rmSync(join(env.uploadDir, dirName), { recursive: true, force: true });
    writeFileSync(join(env.uploadDir, dirName), Buffer.from('AAR-EISDIR-REPAIRED', 'utf-8'));
    const repaired = await download('/api/v1', a.id, { token: memberAdminJwt });
    expect(repaired.status).toBe(200);
    expect(repaired.bytes.toString('utf-8')).toBe('AAR-EISDIR-REPAIRED');
  });

  it('aborts the response after observed headers and a chunk when the stream fails post-header', async () => {
    // LABELLED CALL-THROUGH SEAM. The bytes on disk are real and the route is
    // real, but the returned handle is a wrapper that destroys the underlying
    // REAL stream with a test fault immediately after forwarding the FIRST
    // chunk. This is synthetic late-error injection at a named seam, NOT proof
    // of a natural platform fault, and it is labeled as such.
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'posthdr.txt',
      bytes: Buffer.alloc(512 * 1024, 0x41),
    });
    const original = readFileSpy.getMockImplementation()!;
    readFileSpy.mockImplementation((name: string) => {
      const stream = (original as any)(name);
      let seen = false;
      const killer = new Transform({
        transform(chunk: Buffer, _enc: string, cb: (e?: Error | null, d?: Buffer) => void) {
          cb(null, chunk);
          if (!seen) {
            seen = true;
            // Deterministic: destroy on the same tick the first chunk is
            // handed downstream, so headers plus some data are committed and
            // the failure is terminal - no timer race.
            (killer as any).destroy(new Error('aar-synthetic-late-stream-fault'));
          }
        },
      });
      stream.on('error', () => {});
      return stream.pipe(killer);
    });

    try {
      const res = await fetch(`${baseUrl}/api/v1/attachments/${a.id}/download`, {
        method: 'GET',
        headers: authHeaders({ token: memberAdminJwt }),
      });
      // Observed SUCCESSFUL headers first...
      expect(res.status, 'headers must already be committed').toBe(200);
      const reader = res.body!.getReader();
      // ...then at least one real chunk received on the socket...
      const first = await reader.read();
      expect(first.done, 'a first chunk must be delivered before the fault').toBe(false);
      expect(first.value!.length).toBeGreaterThan(0);
      let received = first.value!.length;
      let terminal: 'aborted' | 'done' | 'unsettled' = 'unsettled';
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) {
            terminal = 'done';
            break;
          }
          received += r.value!.length;
        }
      } catch {
        // The transport aborted mid-body: the expected terminal failure.
        terminal = 'aborted';
      }
      // ...then the terminal outcome: never a clean end, never the full body.
      // Assertions live OUTSIDE the abort-catching try: a failing expectation
      // must fail the test, never masquerade as a socket abort.
      expect(terminal, 'the stream must terminate by failure, not by clean end').toBe('aborted');
      expect(received).toBeGreaterThan(0);
      expect(received, 'the body must be truncated').toBeLessThan(512 * 1024);
    } finally {
      readFileSpy.mockImplementation(original as any);
    }
    // A read fault never mutates the row or the stored bytes.
    expect(rowById(a.id)).toBeTruthy();
    expect(readFileSync(join(env.uploadDir, a.filename)).length).toBe(512 * 1024);
  });
});

// ===========================================================================
describe('existing destructive faults - characterization only, NOT follow-up B criteria', () => {
  it('500s postcommit EISDIR with the row already ABSENT, leaving the stored directory intact', async () => {
    // DB-first: the transaction commits the winning deletion first, then the
    // unchanged unlink runs outside the SQL catch. A stored path that exists
    // as a directory reaches unlinkSync and raises EISDIR — a real propagated
    // filesystem error is 500 INTERNAL_ERROR with the row already gone.
    const dirName = `${randomUUID()}-undir.bin`;
    mkdirSync(join(env.uploadDir, dirName), { recursive: true });
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'unlink-dir.txt',
      bytes: Buffer.from('AAR-UNLINK-DIR', 'utf-8'),
      storedAs: dirName,
      // skipWrite: same setup-EISDIR hazard as the read fault above.
      skipWrite: true,
    });
    const res = await del('/api/v1', a.id, { token: memberAdminJwt });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    // The row removal COMMITTED before the unlink attempt: row absent,
    // directory intact (unlink cannot remove a directory), replay is 404
    // and never cleans the stored path. Orphan-directory outcome, documented.
    expect(rowById(a.id)).toBeUndefined();
    expect(statSync(join(env.uploadDir, dirName)).isDirectory()).toBe(true);
    expect(deleteFileNames).toContain(dirName);

    const replay = await del('/api/v1', a.id, { token: memberAdminJwt });
    expect(replay.status).toBe(404);
    expect(deleteFileNames.filter((name: string) => name === dirName).length).toBe(1);
    expect(statSync(join(env.uploadDir, dirName)).isDirectory()).toBe(true);

    // Fixture repair only: the stored directory was this test's own fixture.
    rmSync(join(env.uploadDir, dirName), { recursive: true, force: true });
  });

  it('500s REPOSITORY_ERROR with the bytes PRESERVED when the SQL statement aborts (DB-first)', async () => {
    // The transaction owns the whole command: a BEFORE DELETE RAISE(ABORT)
    // throws inside the immediate transaction, which rolls back with zero
    // filesystem effect, and the real failure wraps as REPOSITORY_ERROR.
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'abort-delete.txt',
      bytes: Buffer.from('AAR-ABORT-DELETE-BYTES', 'utf-8'),
    });
    expect(existsSync(join(env.uploadDir, a.filename))).toBe(true);
    getDb().run(
      sql`CREATE TRIGGER aar_block_delete BEFORE DELETE ON task_attachments
          BEGIN SELECT RAISE(ABORT, 'aar-blocked-delete'); END`,
    );
    try {
      const res = await del('/api/v1', a.id, { token: memberAdminJwt });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('REPOSITORY_ERROR');
      expect(res.body.error).toBe('Failed to delete attachment');
      // DB-first: the statement aborted BEFORE any filesystem effect. The row
      // survives and the bytes are untouched — the old byte loss is repaired.
      expect(existsSync(join(env.uploadDir, a.filename))).toBe(true);
      expect(rowById(a.id)).toBeTruthy();
      expect(rowById(a.id).filename).toBe(a.filename);
      expect(deleteFileSpy).not.toHaveBeenCalled();
    } finally {
      getDb().run(sql`DROP TRIGGER IF EXISTS aar_block_delete`);
    }

    // Replay after dropping the trigger: the surviving row is still deletable.
    expect((await del('/api/v1', a.id, { token: memberAdminJwt })).status).toBe(204);
    expect(rowById(a.id)).toBeUndefined();
  });

  it('409s with row and bytes intact when RAISE(IGNORE) makes the DELETE return zero rows', async () => {
    // The conditional DELETE is verified through RETURNING: RAISE(IGNORE)
    // removes nothing, the statement returns zero rows, and the command
    // throws 409 CONFLICT inside the transaction — never a false 204.
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'zero-row.txt',
      bytes: Buffer.from('AAR-ZERO-ROW-BYTES', 'utf-8'),
    });
    getDb().run(
      sql`CREATE TRIGGER aar_ignore_delete BEFORE DELETE ON task_attachments
          BEGIN SELECT RAISE(IGNORE); END`,
    );
    try {
      const res = await del('/api/v1', a.id, { token: memberAdminJwt });
      // Zero matched rows is a truthful 409 with full rollback and zero
      // filesystem effect: row present, bytes present, no unlink attempted.
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(res.body.error).toBe('Attachment changed');
      expect(rowById(a.id)).toBeTruthy();
      expect(existsSync(join(env.uploadDir, a.filename))).toBe(true);
      expect(deleteFileSpy).not.toHaveBeenCalled();
    } finally {
      getDb().run(sql`DROP TRIGGER IF EXISTS aar_ignore_delete`);
    }

    // Positive control after dropping the trigger: the same target deletes.
    expect((await del('/api/v1', a.id, { token: memberAdminJwt })).status).toBe(204);
    expect(rowById(a.id)).toBeUndefined();
    expect(existsSync(join(env.uploadDir, a.filename))).toBe(false);
  });
});

// ===========================================================================
describe('initial-lookup snapshot drift - labelled fault-seam characterization', () => {
  // The out-of-band writer below runs INSIDE the route's attachment-lookup
  // spy, i.e. at the INITIAL lookup, BEFORE ancestry admission completes.
  // The route still admits and authorizes the STALE snapshot it already
  // holds; these are loaded-snapshot drift characterizations at that exact
  // seam, NOT proofs about the admission-await interval itself.
  it('serves the SNAPSHOT filename after an out-of-band taskId and filename change', async () => {
    // LABELLED OUT-OF-BAND STORAGE-WRITER SEAM. No served attachment edit,
    // reparent or filename-replacement route exists; this is a direct
    // out-of-band writer invoked from a call-through spy, and it is NOT a proof
    // of natural concurrency. It characterizes the documented ceiling: the
    // route authorizes and reads from its own snapshot, not a locked row.
    const a = makeAttachment(personalTaskId, {
      uploadedBy: 'aar-personal-admin',
      originalName: 'drift.txt',
      bytes: Buffer.from('AAR-DRIFT-SNAPSHOT-BYTES', 'utf-8'),
    });
    const replacementName = `${randomUUID()}-drift-replacement.bin`;
    writeFileSync(join(env.uploadDir, replacementName), Buffer.from('AAR-DRIFT-REPLACEMENT-BYTES', 'utf-8'));

    const realGet = attachmentRepo.getAttachmentById.bind(attachmentRepo);
    const seam = vi.spyOn(attachmentRepo, 'getAttachmentById').mockImplementation((id: string) => {
      const snapshot = realGet(id);
      if (id === a.id && snapshot) {
        getDb()
          .update(taskAttachments)
          .set({ taskId: otherTeamTaskId, filename: replacementName, uploadedBy: 'aar-member-admin' })
          .where(eq(taskAttachments.id, a.id))
          .run();
      }
      return snapshot;
    });

    try {
      const res = await download('/api/v1', a.id, { token: personalAdminJwt });
      expect(res.status).toBe(200);
      // The SNAPSHOT bytes came back, even though the row now names a
      // different file under a different, nonmember-owned Task. This is the
      // documented request-time ceiling, not a guarantee.
      expect(res.bytes.toString('utf-8')).toBe('AAR-DRIFT-SNAPSHOT-BYTES');
      // The replacement file the row now names is untouched by a read.
      expect(existsSync(join(env.uploadDir, replacementName))).toBe(true);
    } finally {
      seam.mockRestore();
      getDb()
        .update(taskAttachments)
        .set({ taskId: personalTaskId, filename: a.filename, uploadedBy: 'aar-personal-admin' })
        .where(eq(taskAttachments.id, a.id))
        .run();
    }
  });

  it('409s with NO unlink when the current row drifted from the admitted preimage', async () => {
    // Same labelled seam, destructive direction. The route admitted and
    // authorized the SNAPSHOT (personal Habitat, admin human), but the
    // DB-first command re-reads the CURRENT row inside its transaction: the
    // filename drifted (the row stays in the still-admitted personal Habitat,
    // so authority holds), and the full-identity comparison throws 409 before
    // the conditional DELETE and before any filesystem effect. A reparent that
    // REMOVES current admission is 403 by precedence, proven in the new suite.
    const a = makeAttachment(personalTaskId, {
      uploadedBy: 'aar-personal-admin',
      originalName: 'drift-delete.txt',
      bytes: Buffer.from('AAR-DRIFT-SNAPSHOT-BYTES', 'utf-8'),
    });
    const replacementName = `${randomUUID()}-drift-delete-replacement.bin`;
    writeFileSync(join(env.uploadDir, replacementName), Buffer.from('AAR-DRIFT-REPLACEMENT-BYTES', 'utf-8'));

    const realGet = attachmentRepo.getAttachmentById.bind(attachmentRepo);
    const seam = vi.spyOn(attachmentRepo, 'getAttachmentById').mockImplementation((id: string) => {
      const snapshot = realGet(id);
      if (id === a.id && snapshot) {
        getDb()
          .update(taskAttachments)
          .set({ filename: replacementName })
          .where(eq(taskAttachments.id, a.id))
          .run();
      }
      return snapshot;
    });

    try {
      const res = await del('/api/v1', a.id, { token: personalAdminJwt });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(res.body.error).toBe('Attachment changed');
      // Still authorized, but drifted: NEITHER file is touched and the row
      // (still carrying the seam's competing write) survives intact.
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(deleteFileNames).not.toContain(replacementName);
      expect(deleteFileNames).not.toContain(a.filename);
      expect(existsSync(join(env.uploadDir, replacementName))).toBe(true);
      expect(existsSync(join(env.uploadDir, a.filename))).toBe(true);
      expect(rowById(a.id)).toBeTruthy();
      expect(rowById(a.id).filename).toBe(replacementName);
    } finally {
      seam.mockRestore();
      // Restore the row the seam mutated: the competing write was test-owned.
      getDb()
        .update(taskAttachments)
        .set({ filename: a.filename })
        .where(eq(taskAttachments.id, a.id))
        .run();
    }
  });

  it('404s an allowed delete whose repository refetch no longer finds the attachment', async () => {
    // The command's same-transaction current-row read. The labelled seam
    // below deletes the REAL row from the database right after the route's
    // lookup consumed it: the command's in-transaction SELECT then genuinely
    // observes absence and answers the same 404.
    const a = makeAttachment(teamTaskId, {
      uploadedBy: 'aar-member-admin',
      originalName: 'vanish.txt',
      bytes: Buffer.from('AAR-VANISH', 'utf-8'),
    });
    const realGet = attachmentRepo.getAttachmentById.bind(attachmentRepo);
    let routeLookupServed = false;
    const seam = vi.spyOn(attachmentRepo, 'getAttachmentById').mockImplementation((id: string) => {
      const snapshot = realGet(id);
      // Hand the ROUTE its snapshot, then remove the real row. This deletion
      // is the seam's OWN write (a test-owned out-of-band writer), not an
      // effect of the delete operation under test.
      if (id === a.id && snapshot && !routeLookupServed) {
        routeLookupServed = true;
        getDb().delete(taskAttachments).where(eq(taskAttachments.id, a.id)).run();
      }
      return snapshot;
    });
    try {
      const res = await del('/api/v1', a.id, { token: memberAdminJwt });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Attachment not found');
      // The repository WAS asked, and chose not to unlink anything...
      expect(deleteAttachmentSpy).toHaveBeenCalledTimes(1);
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(deleteFileNames).not.toContain(a.filename);
      // ...while the stored bytes survive the vanished row.
      expect(rowById(a.id), 'the seam itself removed the row').toBeUndefined();
      expect(existsSync(join(env.uploadDir, a.filename))).toBe(true);
    } finally {
      seam.mockRestore();
    }
  });
});
