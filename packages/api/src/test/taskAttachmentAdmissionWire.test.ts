/**
 * Task attachment parent admission - real assembled HTTP/multipart wire proof.
 *
 * No middleware mocks. Every request crosses a real socket into the real
 * application built by `createHttpApplication`; the root error plugin, the
 * multipart plugin, the repositories, SQLite and the filesystem are all real.
 *
 * The only instrumentation is CALL-THROUGH boundary observation: spies that
 * keep the original implementations, so real bytes still reach disk and real
 * rows still reach the database.
 *
 *   - `fileStorage.saveFile` is the ONLY consumer of the buffer that
 *     `data.toBuffer()` materializes, and in this handler it is reached
 *     unconditionally on the admitted path. So "saveFile was never called"
 *     implies neither toBuffer nor request.file ran. The buffers it did
 *     receive are captured so the admitted path proves the observation is
 *     live rather than vacuous.
 *   - `fileStorage.ensureUploadDir` proves no directory creation happened.
 *     An existing directory alone would prove nothing, so the denial cases
 *     also assert the directory was never created at all.
 *   - `attachmentRepo.getAttachmentsByTaskId` proves no list query happened.
 *
 * `createHttpApplication` returns a handle with no `addHook`, and Fastify v5
 * exposes neither the Request prototype nor a decorate seam for the
 * plugin-decorated `request.file`, so the bare invocation of `request.file()`
 * is not observable. The implication above is what carries that claim, and it
 * is stated rather than faked.
 *
 * Module-load constants are captured at import time, so UPLOAD_DIR and
 * MAX_UPLOAD_SIZE_MB are set in `vi.hoisted`, which vitest lifts above the
 * imports - before any module reads them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { readFileSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { tasks, missions, taskAttachments, taskEvents, notificationDeliveries } from '../db/schema/index.js';
import { getJwtSecret } from '../middleware/jwt-verification.js';
import * as pluginManager from '../plugins/pluginManager.js';

const env = vi.hoisted(() => {
  const priorUploadDir = process.env.UPLOAD_DIR;
  const priorMax = process.env.MAX_UPLOAD_SIZE_MB;
  const dir = `${process.env.TMPDIR || '/tmp'}/orcy-attachment-adm-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.MAX_UPLOAD_SIZE_MB = '1';
  return { uploadDir: dir, limitBytes: 1 * 1024 * 1024, priorUploadDir, priorMax };
});

const PREFIXES = ['/api/v1', '/api'] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;

let teamId: string;
let teamHabitatId: string;
let personalHabitatId: string;

let memberOwnerJwt: string;
let memberAdminJwt: string;
let memberViewerJwt: string;
let memberEditorJwt: string;
let nonmemberAdminJwt: string;
let personalAdminJwt: string;
let personalViewerJwt: string;

/** Never assigned to any Task: the "unassigned local agent" positive. */
let unassignedAgentId: string;
let unassignedAgentKey: string;
/** Heartbeat-bound to a personal-habitat task: the "bound" positive. */
let boundAgentId: string;
let boundAgentKey: string;
/** Explicitly assigned to a dedicated team-habitat task. */
let assignedAgentId: string;
let assignedAgentKey: string;
let assignedTaskId: string;

let validRemoteKey: string;

let teamTaskId: string;
let emptyTeamTaskId: string;
let personalTaskId: string;
let seededFileName: string;
let seededFileBytes: Buffer;
let assignedFileName: string;
let assignedFileBytes: Buffer;
let assignedAttachmentId: string;

// ---- call-through boundary observation -------------------------------------
let saveFileSpy: any;
let ensureDirSpy: any;
let listQuerySpy: any;
/** Buffers actually handed to saveFile, so the observation is provably live. */
let saveFileBuffers: Buffer[] = [];

beforeEach(() => {
  saveFileBuffers = [];
});

// ---- helpers ---------------------------------------------------------------
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function mint(userId: string, role: string): string {
  return jwt.sign({ sub: userId, username: `aaw-${userId}`, role }, getJwtSecret(), {
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
    name: `aaw-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({ habitatId, columnId: column.id, title: `aaw-mission-${title}`, createdBy });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}

function missionIdForTask(taskId: string): string {
  const row = getDb().select({ missionId: tasks.missionId }).from(tasks).where(eq(tasks.id, taskId)).get() as
    | { missionId: string }
    | undefined;
  if (!row) throw new Error(`task ${taskId} missing`);
  return row.missionId;
}

function assignedAgentOf(taskId: string): string | null {
  const row = getDb().select({ a: tasks.assignedAgentId }).from(tasks).where(eq(tasks.id, taskId)).get() as
    | { a: string | null }
    | undefined;
  return row?.a ?? null;
}

function attachmentRows(taskId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskAttachments).where(eq(taskAttachments.taskId, taskId)).all()),
  );
}

function taskEventCount(taskId: string): number {
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
    out[name] = createHash('sha256').update(readFileSync(join(env.uploadDir, name))).digest('hex');
  }
  return out;
}

/** Raw bytes of every stored file, so a destructive case can restore exactly. */
function fileBytesInventory(): Record<string, Buffer> {
  if (!existsSync(env.uploadDir)) return {};
  const out: Record<string, Buffer> = {};
  for (const name of readdirSync(env.uploadDir)) {
    out[name] = readFileSync(join(env.uploadDir, name));
  }
  return out;
}

/** Restores a captured byte inventory, removing whatever the case left behind. */
function restoreFileBytes(saved: Record<string, Buffer>): void {
  rmSync(env.uploadDir, { recursive: true, force: true });
  mkdirSync(env.uploadDir, { recursive: true });
  for (const [name, bytes] of Object.entries(saved)) {
    writeFileSync(join(env.uploadDir, name), bytes);
  }
}

/** Everything a denied request must leave untouched. */
function worldSnapshot(taskId: string) {
  return {
    rows: attachmentRows(taskId),
    files: fileInventory(),
    taskEvents: taskEventCount(taskId),
    deliveries: deliveryCount(),
  };
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
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text };
}

async function listAttachments(prefix: string, taskId: string, opts: WireOpts = {}) {
  const res = await fetch(`${baseUrl}${prefix}/tasks/${taskId}/attachments`, {
    method: 'GET',
    headers: authHeaders(opts),
  });
  return readWire(res);
}

interface FilePart {
  name: string;
  bytes: Buffer;
  type?: string;
}
interface UploadOpts extends WireOpts {
  file?: FilePart;
  /** Part name. The route takes the FIRST yielded file regardless of fieldname. */
  fieldname?: string;
  /** Ordinary multipart text fields - must never move parent or uploader. */
  fields?: Record<string, string>;
}
async function upload(prefix: string, taskId: string, opts: UploadOpts = {}) {
  const form = new FormData();
  if (opts.file) {
    form.append(
      opts.fieldname ?? 'file',
      new Blob([new Uint8Array(opts.file.bytes)], { type: opts.file.type ?? 'text/plain' }),
      opts.file.name,
    );
  }
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  const res = await fetch(`${baseUrl}${prefix}/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: authHeaders(opts),
    body: form,
  });
  return readWire(res);
}

/** Byte-exact body with a hand-written Content-Type, for parser characterization. */
async function rawUpload(prefix: string, taskId: string, opts: WireOpts & { contentType: string; body: string }) {
  const res = await fetch(`${baseUrl}${prefix}/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: { ...authHeaders(opts), 'Content-Type': opts.contentType },
    body: opts.body,
  });
  return readWire(res);
}

async function download(prefix: string, attachmentId: string, opts: WireOpts = {}) {
  const res = await fetch(`${baseUrl}${prefix}/attachments/${attachmentId}/download`, {
    method: 'GET',
    headers: authHeaders(opts),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes };
}

const RAW_ROW_KEYS = [
  'createdAt',
  'filename',
  'id',
  'mimeType',
  'originalName',
  'sizeBytes',
  'taskId',
  'uploadedBy',
];

// ---- suite -----------------------------------------------------------------
beforeAll(async () => {
  mkdirSync(env.uploadDir, { recursive: true });
  await initTestDb();
  // Normal fixtures run with FK enforcement ON (asserted by read-back). Only the
  // corrupt-ancestry fixtures disable it, each inside a finally that restores
  // and re-asserts it.
  setFk(true);

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${port}`;

  // Wrap the captured original: call-through, so real bytes still hit disk.
  const originalSaveFile = fileStorage.saveFile;
  saveFileSpy = vi.spyOn(fileStorage, 'saveFile').mockImplementation((id: string, filename: string, buffer: Buffer) => {
    saveFileBuffers.push(buffer);
    return originalSaveFile(id, filename, buffer);
  });
  ensureDirSpy = vi.spyOn(fileStorage, 'ensureUploadDir');
  listQuerySpy = vi.spyOn(attachmentRepo, 'getAttachmentsByTaskId');

  const org = organizationRepo.createOrganization({ name: 'aaw-org', slug: `aaw-org-${Date.now()}` });
  teamId = teamRepo.createTeam({ organizationId: org.id, name: 'aaw-team', slug: `aaw-team-${Date.now()}` }).id;
  teamHabitatId = habitatRepo.createHabitat({ name: 'aaw-team-habitat', teamId }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: 'aaw-personal-habitat' }).id;

  // Real user rows: with FK ON, team_members.user_id references users.id, so
  // users must exist before the membership fixtures.
  const now = new Date().toISOString();
  for (const [userId, role] of [
    ['aaw-member-owner', 'viewer'],
    ['aaw-member-admin', 'admin'],
    ['aaw-member-viewer', 'viewer'],
    ['aaw-member-editor', 'editor'],
    ['aaw-nonmember-admin', 'admin'],
    ['aaw-personal-admin', 'admin'],
    ['aaw-personal-viewer', 'viewer'],
  ] as const) {
    userRepo.createUser({
      id: userId,
      username: `aaw-${userId}`,
      passwordHash: 'aaw-unused-hash',
      role,
      createdAt: now,
      updatedAt: now,
    });
  }
  teamMemberRepo.addMember({ teamId, userId: 'aaw-member-owner', role: 'owner' });
  teamMemberRepo.addMember({ teamId, userId: 'aaw-member-admin', role: 'member' });
  teamMemberRepo.addMember({ teamId, userId: 'aaw-member-viewer', role: 'member' });
  teamMemberRepo.addMember({ teamId, userId: 'aaw-member-editor', role: 'member' });
  // Fixture ownership asserted before any proof runs: every admitted human
  // below has a membership row, and the nonmember deliberately does not.
  expect(teamMemberRepo.listMembers(teamId).length).toBeGreaterThanOrEqual(4);

  memberOwnerJwt = mint('aaw-member-owner', 'viewer');
  memberAdminJwt = mint('aaw-member-admin', 'admin');
  memberViewerJwt = mint('aaw-member-viewer', 'viewer');
  memberEditorJwt = mint('aaw-member-editor', 'editor');
  nonmemberAdminJwt = mint('aaw-nonmember-admin', 'admin');
  personalAdminJwt = mint('aaw-personal-admin', 'admin');
  personalViewerJwt = mint('aaw-personal-viewer', 'viewer');

  const unassigned = agentRepo.createAgent({
    name: 'aaw-unassigned-agent',
    type: 'claude-code',
    domain: 'fullstack',
    capabilities: [],
  });
  unassignedAgentId = unassigned.agent.id;
  unassignedAgentKey = unassigned.plainApiKey;

  const bound = agentRepo.createAgent({
    name: 'aaw-bound-agent',
    type: 'claude-code',
    domain: 'fullstack',
    capabilities: [],
  });
  boundAgentId = bound.agent.id;
  boundAgentKey = bound.plainApiKey;
  const anchor = makeTask(personalHabitatId, 'aaw-bound-anchor', 'aaw-seed');
  agentRepo.heartbeat(boundAgentId, anchor);

  const assignable = agentRepo.createAgent({
    name: 'aaw-assigned-agent',
    type: 'claude-code',
    domain: 'fullstack',
    capabilities: [],
  });
  assignedAgentId = assignable.agent.id;
  assignedAgentKey = assignable.plainApiKey;
  assignedTaskId = makeTask(teamHabitatId, 'aaw-assigned-task', 'aaw-seed');
  getDb().update(tasks).set({ assignedAgentId }).where(eq(tasks.id, assignedTaskId)).run();
  expect(assignedAgentOf(assignedTaskId)).toBe(assignedAgentId);

  // Fully VALID remote credential - must still 401 under local_actor.
  const pod = remotePodRepo.createRemotePod({ habitatId: teamHabitatId, name: 'aaw-remote-pod' });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: 'remote_orcy',
    displayName: 'aaw-remote-orcy',
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: 'api',
    label: 'aaw-remote-cred',
  }).plaintextSecret;

  teamTaskId = makeTask(teamHabitatId, 'aaw-team-task', 'aaw-seed');
  emptyTeamTaskId = makeTask(teamHabitatId, 'aaw-empty-task', 'aaw-seed');
  personalTaskId = makeTask(personalHabitatId, 'aaw-personal-task', 'aaw-seed');

  // Seed two rows with DISTINCT createdAt values plus real stored bytes, so
  // the descending-order assertion never relies on unspecified tie order.
  seededFileBytes = Buffer.from('aaw-seed-bytes-for-download-control', 'utf-8');
  seededFileName = `${randomUUID()}-seeded.txt`;
  writeFileSync(join(env.uploadDir, seededFileName), seededFileBytes);
  const older = attachmentRepo.createAttachment({
    taskId: teamTaskId,
    filename: seededFileName,
    originalName: 'seeded.txt',
    mimeType: 'text/plain',
    sizeBytes: seededFileBytes.length,
    uploadedBy: 'aaw-member-admin',
  });
  expect(older.id).toBeTruthy();

  const newerFile = `${randomUUID()}-newer.txt`;
  const newerBytes = Buffer.from('aaw-newer', 'utf-8');
  writeFileSync(join(env.uploadDir, newerFile), newerBytes);
  getDb()
    .insert(taskAttachments)
    .values({
      id: randomUUID(),
      taskId: teamTaskId,
      filename: newerFile,
      originalName: 'newer.txt',
      mimeType: 'text/plain',
      sizeBytes: newerBytes.length,
      uploadedBy: 'aaw-member-admin',
      createdAt: '2999-01-01T00:00:00.000Z',
    })
    .run();
  expect(attachmentRows(teamTaskId).length).toBe(2);
  // R6 consumer ripple: persisted createdAt is nullable in storage, so the
  // honest repository type is `string | null`. This fixture always writes a
  // value - narrow with a runtime check, never a cast.
  if (typeof older.createdAt !== 'string') {
    throw new Error('fixture invariant broken: seeded attachment createdAt is null');
  }
  expect(new Date(older.createdAt).getTime()).toBeLessThan(new Date('2999-01-01T00:00:00.000Z').getTime());

  // A second stored file on the ASSIGNED task, so the download positive
  // control has an attachment that agent may actually read. This is a
  // positive control through the UNCHANGED route, not new resource protection.
  assignedFileBytes = Buffer.from('aaw-assigned-download-bytes', 'utf-8');
  assignedFileName = `${randomUUID()}-assigned.txt`;
  writeFileSync(join(env.uploadDir, assignedFileName), assignedFileBytes);
  assignedAttachmentId = attachmentRepo.createAttachment({
    taskId: assignedTaskId,
    filename: assignedFileName,
    originalName: 'assigned.txt',
    mimeType: 'text/plain',
    sizeBytes: assignedFileBytes.length,
    uploadedBy: assignedAgentId,
  }).id;
}, 180_000);

afterAll(async () => {
  saveFileSpy?.mockRestore();
  ensureDirSpy?.mockRestore();
  listQuerySpy?.mockRestore();
  await app.close();
  closeDb();
  rmSync(env.uploadDir, { recursive: true, force: true });
  if (env.priorUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = env.priorUploadDir;
  if (env.priorMax === undefined) delete process.env.MAX_UPLOAD_SIZE_MB;
  else process.env.MAX_UPLOAD_SIZE_MB = env.priorMax;
});

afterEach(() => {
  // Every fixture leaves FK enforcement ON.
  setFk(true);
});

describe('upload/list parent admission - actor matrix on both prefixes', () => {
  it('admits every team-member shape, personal human, and assigned/bound/unassigned local agent', async () => {
    for (const prefix of PREFIXES) {
      for (const [label, token] of [
        ['member-owner', memberOwnerJwt],
        ['member-admin', memberAdminJwt],
        ['member-viewer', memberViewerJwt],
        ['member-editor', memberEditorJwt],
      ] as const) {
        const res = await upload(prefix, teamTaskId, {
          token,
          file: { name: `aaw-${label}.txt`, bytes: Buffer.from(`bytes-${label}-${prefix}`, 'utf-8') },
        });
        expect(res.status, `${label} upload ${prefix}`).toBe(201);
        expect(res.body.attachment.taskId).toBe(teamTaskId);
        expect(res.body.attachment.uploadedBy).toMatch(/^aaw-member-/);
        // Raw stored row only: no url / contentType / size / description.
        expect(Object.keys(res.body.attachment).toSorted()).toEqual(RAW_ROW_KEYS);
      }

      for (const [label, token] of [
        ['personal-admin', personalAdminJwt],
        ['personal-viewer', personalViewerJwt],
      ] as const) {
        const res = await upload(prefix, personalTaskId, {
          token,
          file: { name: `aaw-${label}.txt`, bytes: Buffer.from(`bytes-${label}`, 'utf-8') },
        });
        expect(res.status, `${label} upload ${prefix}`).toBe(201);
        expect(res.body.attachment.taskId).toBe(personalTaskId);
      }

      // Assigned, bound and unassigned agents alike.
      for (const [label, key, task] of [
        ['assigned-agent', assignedAgentKey, assignedTaskId],
        ['bound-agent', boundAgentKey, teamTaskId],
        ['unassigned-agent', unassignedAgentKey, teamTaskId],
      ] as const) {
        const res = await upload(prefix, task, {
          agentKey: key,
          file: { name: `aaw-${label}.txt`, bytes: Buffer.from(`bytes-${label}`, 'utf-8') },
        });
        expect(res.status, `${label} upload ${prefix}`).toBe(201);
        expect(res.body.attachment.taskId).toBe(task);
        expect(res.body.attachment.uploadedBy).toBeTruthy();
      }

      // List is admitted for the same shapes; assignment is NOT a list predicate.
      for (const opts of [
        { token: memberViewerJwt },
        { agentKey: assignedAgentKey },
        { agentKey: unassignedAgentKey },
      ]) {
        const res = await listAttachments(prefix, teamTaskId, opts);
        expect(res.status, `list ${prefix}`).toBe(200);
        expect(Array.isArray(res.body.attachments)).toBe(true);
        expect(res.body.attachments.length).toBeGreaterThan(0);
      }
    }
  });

  it('denies a team nonmember (including a global admin JWT role) 403 BOARD_ACCESS_DENIED with zero effects', async () => {
    for (const prefix of PREFIXES) {
      const before = worldSnapshot(teamTaskId);
      saveFileSpy.mockClear();
      listQuerySpy.mockClear();

      const res = await upload(prefix, teamTaskId, {
        token: nonmemberAdminJwt,
        file: { name: 'aaw-intruder.txt', bytes: Buffer.from('aaw-intruder-bytes', 'utf-8') },
      });
      expect(res.status, `nonmember upload ${prefix}`).toBe(403);
      expect(res.body.code).toBe('BOARD_ACCESS_DENIED');
      // saveFile is the sole consumer of the toBuffer() result, so zero calls
      // proves no buffering and no storage write happened.
      expect(saveFileSpy, 'denied upload must not reach storage').not.toHaveBeenCalled();
      expect(saveFileBuffers).toEqual([]);
      expect(worldSnapshot(teamTaskId)).toEqual(before);

      const list = await listAttachments(prefix, teamTaskId, { token: nonmemberAdminJwt });
      expect(list.status).toBe(403);
      expect(list.body.code).toBe('BOARD_ACCESS_DENIED');
      expect(listQuerySpy, 'denied list must not reach the repository').not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
  });

  it('rejects anonymous, invalid local key and a fully valid remote-only credential with 401', async () => {
    for (const prefix of PREFIXES) {
      for (const opts of [{}, { badAgentKey: 'aaw-not-a-real-key' }, { remoteKey: validRemoteKey }]) {
        saveFileSpy.mockClear();
        listQuerySpy.mockClear();
        const up = await upload(prefix, teamTaskId, {
          ...opts,
          file: { name: 'aaw-401.txt', bytes: Buffer.from('aaw-401-bytes', 'utf-8') },
        });
        expect(up.status, `401 upload ${prefix}`).toBe(401);
        expect(saveFileSpy).not.toHaveBeenCalled();
        expect(listQuerySpy).not.toHaveBeenCalled();

        const listed = await listAttachments(prefix, teamTaskId, opts as WireOpts);
        expect(listed.status, `401 list ${prefix}`).toBe(401);
        expect(listQuerySpy).not.toHaveBeenCalled();
      }
      // An invalid local key alongside a VALID human JWT is still 401.
      const both = await upload(prefix, teamTaskId, {
        badAgentKey: 'aaw-not-a-real-key',
        token: memberAdminJwt,
        file: { name: 'aaw-both.txt', bytes: Buffer.from('aaw-both', 'utf-8') },
      });
      expect(both.status).toBe(401);
      expect(both.body.code).toBe('INVALID_API_KEY');
    }
  });

  it('gives a valid local key precedence over human and remote headers for admission and attribution', async () => {
    for (const prefix of PREFIXES) {
      const res = await upload(prefix, teamTaskId, {
        agentKey: boundAgentKey,
        token: nonmemberAdminJwt,
        remoteKey: validRemoteKey,
        file: { name: 'aaw-precedence.txt', bytes: Buffer.from('aaw-precedence', 'utf-8') },
      });
      // Local-agent admission wins: the nonmember human header cannot deny it.
      expect(res.status).toBe(201);
      expect(res.body.attachment.uploadedBy).toBe(boundAgentId);
    }
  });

  it('keeps an empty Task list at 200 {attachments:[]} and preserves descending order on distinct timestamps', async () => {
    for (const prefix of PREFIXES) {
      const empty = await listAttachments(prefix, emptyTeamTaskId, { agentKey: unassignedAgentKey });
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ attachments: [] });

      const listed = await listAttachments(prefix, teamTaskId, { agentKey: unassignedAgentKey });
      expect(listed.status).toBe(200);
      const times: string[] = listed.body.attachments.map((a: any) => a.createdAt);
      expect(times.length).toBeGreaterThanOrEqual(2);
      // Distinct timestamps, so DESC is deterministic.
      expect([...times].sort().reverse()).toEqual(times);
      for (const a of listed.body.attachments) {
        expect(Object.keys(a).toSorted()).toEqual(RAW_ROW_KEYS);
      }
    }
  });
});

describe('upload/list parent admission - ancestry resolution', () => {
  it('404s a missing Task, Mission or Habitat on both operations and both prefixes', async () => {
    for (const prefix of PREFIXES) {
      // Missing Task: already 404 on the base implementation.
      const noTask = await upload(prefix, 'aaw-no-such-task', {
        agentKey: unassignedAgentKey,
        file: { name: 'aaw-x.txt', bytes: Buffer.from('x') },
      });
      expect(noTask.status).toBe(404);
      expect(noTask.body.error).toBe('Task not found');
      const noTaskList = await listAttachments(prefix, 'aaw-no-such-task', { agentKey: unassignedAgentKey });
      expect(noTaskList.status).toBe(404);
      expect(noTaskList.body.error).toBe('Task not found');

      // Missing Mission and missing Habitat are NEW denials. They require
      // corrupting real ancestry, so FK is disabled ONLY inside these blocks
      // and restored (and re-asserted) in finally.
      const missionId = missionIdForTask(teamTaskId);
      setFk(false);
      try {
        getDb().update(tasks).set({ missionId: 'aaw-no-such-mission' }).where(eq(tasks.id, teamTaskId)).run();
        saveFileSpy.mockClear();
        listQuerySpy.mockClear();
        const noMission = await upload(prefix, teamTaskId, {
          agentKey: unassignedAgentKey,
          file: { name: 'aaw-x.txt', bytes: Buffer.from('x') },
        });
        expect(noMission.status, `missing mission upload ${prefix}`).toBe(404);
        expect(noMission.body.error).toBe('Mission not found');
        const noMissionList = await listAttachments(prefix, teamTaskId, { agentKey: unassignedAgentKey });
        expect(noMissionList.status).toBe(404);
        expect(noMissionList.body.error).toBe('Mission not found');
        expect(saveFileSpy).not.toHaveBeenCalled();
        expect(listQuerySpy).not.toHaveBeenCalled();
      } finally {
        getDb().update(tasks).set({ missionId }).where(eq(tasks.id, teamTaskId)).run();
        setFk(true);
      }

      setFk(false);
      try {
        getDb().update(missions).set({ habitatId: 'aaw-no-such-habitat' }).where(eq(missions.id, missionId)).run();
        saveFileSpy.mockClear();
        listQuerySpy.mockClear();
        const noHabitat = await upload(prefix, teamTaskId, {
          agentKey: unassignedAgentKey,
          file: { name: 'aaw-x.txt', bytes: Buffer.from('x') },
        });
        expect(noHabitat.status, `missing habitat upload ${prefix}`).toBe(404);
        expect(noHabitat.body.error).toBe('Habitat not found');
        const noHabitatList = await listAttachments(prefix, teamTaskId, { agentKey: unassignedAgentKey });
        expect(noHabitatList.status).toBe(404);
        expect(noHabitatList.body.error).toBe('Habitat not found');
        expect(saveFileSpy).not.toHaveBeenCalled();
        expect(listQuerySpy).not.toHaveBeenCalled();
      } finally {
        getDb().update(missions).set({ habitatId: teamHabitatId }).where(eq(missions.id, missionId)).run();
        setFk(true);
      }
    }
  });

  it('keeps 401 ahead of every ancestry 404 when the credential fails first', async () => {
    for (const prefix of PREFIXES) {
      for (const taskId of ['aaw-no-such-task', teamTaskId]) {
        const up = await upload(prefix, taskId, { file: { name: 'a', bytes: Buffer.from('a') } });
        expect(up.status).toBe(401);
        expect((await listAttachments(prefix, taskId, {})).status).toBe(401);
        expect((await listAttachments(prefix, taskId, { remoteKey: validRemoteKey })).status).toBe(401);
      }
    }
  });

  it('proves FK enforcement is genuinely ON for normal fixtures: parent deletion cascades rows', () => {
    setFk(true);
    const doomed = makeTask(teamHabitatId, 'aaw-cascade-task', 'aaw-seed');
    const bytes = Buffer.from('aaw-cascade-bytes', 'utf-8');
    const name = `${randomUUID()}-cascade.txt`;
    writeFileSync(join(env.uploadDir, name), bytes);
    attachmentRepo.createAttachment({
      taskId: doomed,
      filename: name,
      originalName: 'cascade.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      uploadedBy: 'aaw-member-admin',
    });
    expect(attachmentRows(doomed).length).toBe(1);
    getDb().delete(tasks).where(eq(tasks.id, doomed)).run();
    // Cascade removed the row; the stored bytes are the known orphan-file
    // residual, explicitly not repaired by this slice.
    expect(attachmentRows(doomed).length).toBe(0);
    expect(existsSync(join(env.uploadDir, name))).toBe(true);
  });
});

describe('upload/list parent admission - denial is inert and precedes consumption', () => {
  it('denies before the upload directory is created at all', async () => {
    // The seeded stored bytes are needed by later cases, so this destructive
    // step is undone exactly at the end of the test.
    const saved = fileBytesInventory();
    for (const prefix of PREFIXES) {
      rmSync(env.uploadDir, { recursive: true, force: true });
      expect(existsSync(env.uploadDir)).toBe(false);
      ensureDirSpy.mockClear();
      saveFileSpy.mockClear();

      const denied = await upload(prefix, teamTaskId, {
        token: nonmemberAdminJwt,
        file: { name: 'aaw-nodir.txt', bytes: Buffer.from('aaw-nodir-bytes', 'utf-8') },
      });
      expect(denied.status).toBe(403);
      // An already-existing directory alone would prove nothing, so assert
      // both: the call never happened AND the directory was never created.
      expect(ensureDirSpy, 'denied upload must not create the upload dir').not.toHaveBeenCalled();
      expect(existsSync(env.uploadDir), 'denied upload must not create the upload dir').toBe(false);
      expect(saveFileSpy).not.toHaveBeenCalled();

      listQuerySpy.mockClear();
      const deniedList = await listAttachments(prefix, teamTaskId, { token: nonmemberAdminJwt });
      expect(deniedList.status).toBe(403);
      expect(existsSync(env.uploadDir)).toBe(false);
      expect(listQuerySpy).not.toHaveBeenCalled();

    }
    restoreFileBytes(saved);
  });

  it('denies a team nonmember 403 BEFORE the multipart parser can consume a limit+1 payload', async () => {
    // Wire discriminator for the pre-buffer guarantee. `request.file()` is lazy
    // and `toBuffer()` is the only thing that materializes the bytes, so with
    // the guard first this body is never parsed and the answer is 403. A guard
    // moved AFTER toBuffer but before saveFile would let the plugin raise
    // FST_REQ_FILE_TOO_LARGE and the shared root handler would answer
    // 500 INTERNAL_ERROR instead, so this assertion is what separates "denied
    // before buffering" from "denied after buffering". Zero saveFile on its own
    // cannot prove that. The ADMITTED over-limit 500 baseline is pinned
    // separately and is deliberately not folded in here.
    const oversize = Buffer.alloc(env.limitBytes + 1, 0x61);
    for (const prefix of PREFIXES) {
      const before = worldSnapshot(teamTaskId);
      saveFileSpy.mockClear();
      ensureDirSpy.mockClear();

      const res = await upload(prefix, teamTaskId, {
        token: nonmemberAdminJwt,
        file: { name: 'aaw-denied-oversize.txt', bytes: oversize, type: 'application/octet-stream' },
      });
      expect(res.status, `denied oversize upload ${prefix}`).toBe(403);
      expect(res.body.code).toBe('BOARD_ACCESS_DENIED');
      // No buffered bytes reached storage, no directory was created, and no
      // row, stored file, Task event or notification delivery changed.
      expect(saveFileSpy, 'denied oversize must not reach storage').not.toHaveBeenCalled();
      expect(ensureDirSpy, 'denied oversize must not create the upload dir').not.toHaveBeenCalled();
      expect(worldSnapshot(teamTaskId)).toEqual(before);
    }
  });

  it('orders admission ahead of the no-file 400 and ahead of credential 401', async () => {
    for (const prefix of PREFIXES) {
      // Denied target + well-formed multipart with NO file -> 403, not 400.
      const denied = await upload(prefix, teamTaskId, { token: nonmemberAdminJwt });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('BOARD_ACCESS_DENIED');

      // Denied target + missing ancestry + no file -> 404, not 400.
      const deniedMissing = await upload(prefix, 'aaw-no-such-task', { token: nonmemberAdminJwt });
      expect(deniedMissing.status).toBe(404);

      saveFileSpy.mockClear();
      // Admitted + no file -> 400 VALIDATION_ERROR.
      const admitted = await upload(prefix, teamTaskId, { agentKey: unassignedAgentKey });
      expect(admitted.status).toBe(400);
      expect(admitted.body.error).toBe('No file uploaded');
      expect(admitted.body.code).toBe('VALIDATION_ERROR');
      // The multipart consumer DID run here, which is what makes the zero
      // counters in the denial cases above meaningful rather than vacuous.
      expect(admitted.status).toBe(400);

      // Credential failure with a valid multipart file -> 401.
      saveFileSpy.mockClear();
      const badCred = await upload(prefix, teamTaskId, {
        badAgentKey: 'aaw-not-a-real-key',
        file: { name: 'aaw-x.txt', bytes: Buffer.from('x') },
      });
      expect(badCred.status).toBe(401);
      expect(saveFileSpy).not.toHaveBeenCalled();
    }
  });

  it('never lets multipart task/actor fields move the stored parent or uploader, and accepts an unknown fieldname', async () => {
    for (const prefix of PREFIXES) {
      const res = await upload(prefix, teamTaskId, {
        agentKey: boundAgentKey,
        fieldname: 'anything-at-all',
        fields: {
          taskId: 'aaw-spoofed-task',
          uploadedBy: 'aaw-spoofed-uploader',
          filename: 'aaw-spoofed.txt',
        },
        file: { name: 'aaw-real.txt', bytes: Buffer.from('aaw-real-bytes', 'utf-8') },
      });
      expect(res.status).toBe(201);
      expect(res.body.attachment.taskId).toBe(teamTaskId);
      expect(res.body.attachment.uploadedBy).toBe(boundAgentId);
      expect(res.body.attachment.originalName).toBe('aaw-real.txt');
      expect(attachmentRepo.getAttachmentById(res.body.attachment.id)?.taskId).toBe(teamTaskId);
    }
  });
});

describe('upload parent admission - success fidelity and preserved side effects', () => {
  it('stores the exact bytes and a raw row, with separately generated storage prefix and row id', async () => {
    const bytes = Buffer.concat([Buffer.from('A'), Buffer.from([0, 1, 2, 255]), Buffer.from('Z-tail')]);
    const before = worldSnapshot(teamTaskId);
    saveFileSpy.mockClear();

    const res = await upload('/api/v1', teamTaskId, {
      agentKey: boundAgentKey,
      file: { name: 'spaced (report) ñ.txt', bytes, type: 'application/octet-stream' },
    });
    expect(res.status).toBe(201);
    const a = res.body.attachment;
    expect(a.sizeBytes).toBe(bytes.length);
    expect(a.mimeType).toBe('application/octet-stream');
    expect(a.originalName).toBe('spaced (report) ñ.txt');
    expect(a.taskId).toBe(teamTaskId);
    expect(a.uploadedBy).toBe(boundAgentId);

    // Sanitized stored name under a fresh storage UUID prefix; the row id is a
    // separate allocation and must not be forced equal to it.
    const suffix = '-spaced__report___.txt';
    expect(a.filename.endsWith(suffix)).toBe(true);
    const prefix = a.filename.slice(0, a.filename.length - suffix.length);
    expect(prefix).toMatch(/^[0-9a-f-]{36}$/);
    expect(prefix).not.toBe(a.id);
    expect(readFileSync(join(env.uploadDir, a.filename)).equals(bytes)).toBe(true);

    // The buffer really was materialized and handed to storage, proving the
    // call-through observation is live.
    expect(saveFileSpy).toHaveBeenCalledTimes(1);
    expect(saveFileBuffers).toHaveLength(1);
    expect(saveFileBuffers[0]!.equals(bytes)).toBe(true);

    // Exactly one new row and one new file; zero new attachment/Task events.
    const after = worldSnapshot(teamTaskId);
    expect(after.rows.length).toBe(before.rows.length + 1);
    expect(Object.keys(after.files).length).toBe(Object.keys(before.files).length + 1);
    expect(after.taskEvents).toBe(before.taskEvents);
    expect(after.deliveries).toBe(before.deliveries);
  });

  it('preserves the real sanitizer output and the received originalName for dangerous and Unicode names', async () => {
    for (const name of [
      '../../../etc/passwd',
      'a/b\\c.txt',
      'ドキュメント.pdf',
      '..hidden..',
      'file name (1).txt',
    ]) {
      const res = await upload('/api/v1', teamTaskId, {
        agentKey: unassignedAgentKey,
        file: { name, bytes: Buffer.from('aaw-name-bytes', 'utf-8') },
      });
      expect(res.status).toBe(201);
      const a = res.body.attachment;
      // The HTTP client flattens path separators into the multipart
      // Content-Disposition filename, so a traversal attempt may never reach
      // the server intact. Whatever DID arrive is preserved verbatim as
      // originalName and never carries a separator.
      expect(a.originalName).not.toContain('/');
      expect(a.originalName).not.toContain('\\');
      // The stored name is exactly the real sanitizer applied to what
      // arrived, under a fresh UUID prefix: no new policy is introduced.
      const uuid = a.filename.slice(0, 36);
      expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(a.filename).toBe(`${uuid}-${fileStorage.sanitizeFilename(a.originalName)}`);
      expect(a.filename).not.toContain('..');
      expect(readFileSync(join(env.uploadDir, a.filename)).toString('utf-8')).toBe('aaw-name-bytes');
    }
  });

  it('does not let successful unassigned-agent upload/list imply download permission', async () => {
    // The unchanged resource route keeps its own predicate.
    const target = makeTask(teamHabitatId, 'aaw-unassigned-download', 'aaw-seed');
    expect(assignedAgentOf(target)).toBeNull();
    const up = await upload('/api/v1', target, {
      agentKey: unassignedAgentKey,
      file: { name: 'aaw-unassigned.txt', bytes: Buffer.from('aaw-unassigned-bytes', 'utf-8') },
    });
    expect(up.status).toBe(201);
    expect((await listAttachments('/api/v1', target, { agentKey: unassignedAgentKey })).status).toBe(200);

    // The uploader here IS unassignedAgentId, so use the OTHER never-assigned
    // agent for the read-denial control.
    const stranger = agentRepo.createAgent({
      name: 'aaw-stranger-agent',
      type: 'claude-code',
      domain: 'fullstack',
      capabilities: [],
    });
    const denied = await download('/api/v1', up.body.attachment.id, { agentKey: stranger.plainApiKey });
    expect(denied.status).toBe(403);
  });

  it('serves stored bytes through the unchanged download route for an assigned agent and a member human', async () => {
    const seedRow = attachmentRows(teamTaskId).find((r: any) => r.filename === seededFileName);
    expect(seedRow).toBeTruthy();

    const forAgent = await download('/api/v1', assignedAttachmentId, { agentKey: assignedAgentKey });
    expect(forAgent.status).toBe(200);
    // The assigned task's own stored bytes, not the team-habitat seeded row.
    expect(forAgent.bytes.equals(assignedFileBytes)).toBe(true);

    const forHuman = await download('/api', seedRow!.id, { token: memberAdminJwt });
    expect(forHuman.status).toBe(200);
    expect(forHuman.bytes.equals(seededFileBytes)).toBe(true);
  });
});

describe('upload - multipart, size and error-handler baseline characterization', () => {
  it('admits a payload at exactly the configured limit', async () => {
    const bytes = Buffer.alloc(env.limitBytes, 0x61);
    const res = await upload('/api/v1', teamTaskId, {
      agentKey: unassignedAgentKey,
      file: { name: 'aaw-exact-limit.txt', bytes, type: 'application/octet-stream' },
    });
    expect(res.status).toBe(201);
    expect(res.body.attachment.sizeBytes).toBe(env.limitBytes);
  });

  it('pins the retained wire outcome for limit+1 without repairing shared error handling', async () => {
    const bytes = Buffer.alloc(env.limitBytes + 1, 0x61);
    const res = await upload('/api/v1', teamTaskId, {
      agentKey: unassignedAgentKey,
      file: { name: 'aaw-over-limit.txt', bytes, type: 'application/octet-stream' },
    });
    // The plugin raises a plain FastifyError at the limit and the shared root
    // handler maps ordinary plugin errors to a generic 500. Pinned as-is.
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(
      attachmentRepo.getAttachmentsByTaskId(teamTaskId).some((r) => r.originalName === 'aaw-over-limit.txt'),
    ).toBe(false);
  });

  it('pins retained outcomes for malformed boundary and non-multipart bodies', async () => {
    // Valid credential and admitted ancestry, so these reach the parser.
    const bad = await rawUpload('/api/v1', teamTaskId, {
      agentKey: unassignedAgentKey,
      contentType: 'multipart/form-data; boundary=AAB',
      body: 'this body never contains the declared boundary',
    });
    expect([400, 406, 500]).toContain(bad.status);
    expect(
      attachmentRepo.getAttachmentsByTaskId(teamTaskId).some((r) => r.originalName === 'this body never'),
    ).toBe(false);

    const notMultipart = await rawUpload('/api/v1', teamTaskId, {
      agentKey: unassignedAgentKey,
      contentType: 'application/json',
      body: '{"hello":"world"}',
    });
    expect([406, 500]).toContain(notMultipart.status);
  });
});

describe('upload - real filesystem and DB faults for ADMITTED requests', () => {
  it('denies before storage when the destination is missing, and yields 500 with no row on a real ENOTDIR', async () => {
    // This case removes the upload directory on purpose; the seeded files are
    // restored exactly afterwards so later cases still have their bytes.
    const saved = fileBytesInventory();
    // Denied request with a missing destination: still denied before storage.
    rmSync(env.uploadDir, { recursive: true, force: true });
    ensureDirSpy.mockClear();
    saveFileSpy.mockClear();
    const denied = await upload('/api/v1', teamTaskId, {
      token: nonmemberAdminJwt,
      file: { name: 'aaw-missing-dest.txt', bytes: Buffer.from('aaw-missing-dest', 'utf-8') },
    });
    expect(denied.status).toBe(403);
    expect(existsSync(env.uploadDir)).toBe(false);
    expect(ensureDirSpy).not.toHaveBeenCalled();
    expect(saveFileSpy).not.toHaveBeenCalled();

    // Deterministic real ENOTDIR: the upload path itself is a regular file, so
    // ensureUploadDir sees it as existing and writeFileSync fails with ENOTDIR.
    // A permission-bit test would be bypassed by a privileged runner.
    mkdirSync(join(env.uploadDir, '..'), { recursive: true });
    writeFileSync(env.uploadDir, 'not-a-directory');
    const before = attachmentRows(teamTaskId).length;
    const faulted = await upload('/api/v1', teamTaskId, {
      agentKey: unassignedAgentKey,
      file: { name: 'aaw-enotdir.txt', bytes: Buffer.from('aaw-enotdir-bytes', 'utf-8') },
    });
    expect(faulted.status).toBe(500);
    expect(attachmentRows(teamTaskId).length).toBe(before);
    restoreFileBytes(saved);
  });

  it('characterizes the existing partial failure: a DB abort after a successful write leaves the file with no row', async () => {
    getDb().run(
      sql`CREATE TRIGGER aaw_block_insert BEFORE INSERT ON task_attachments BEGIN SELECT RAISE(ABORT, 'aaw-blocked'); END`,
    );
    try {
      const bytes = Buffer.from('aaw-trigger-bytes', 'utf-8');
      const res = await upload('/api/v1', teamTaskId, {
        agentKey: unassignedAgentKey,
        file: { name: 'aaw-trigger.txt', bytes, type: 'text/plain' },
      });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('REPOSITORY_ERROR');
      expect(res.body.error).toBe('Failed to create attachment');
      // No row from the failed statement, and the already-written bytes
      // survive: existing partial failure, not a cleanup guarantee.
      expect(
        attachmentRepo.getAttachmentsByTaskId(teamTaskId).some((r) => r.originalName === 'aaw-trigger.txt'),
      ).toBe(false);
      const orphan = readdirSync(env.uploadDir).find((n) => n.endsWith('-aaw-trigger.txt'));
      expect(orphan).toBeTruthy();
      expect(readFileSync(join(env.uploadDir, orphan!)).equals(bytes)).toBe(true);
    } finally {
      getDb().run(sql`DROP TRIGGER IF EXISTS aaw_block_insert`);
    }

    // Replay after dropping the trigger succeeds on the same target.
    const replay = await upload('/api/v1', teamTaskId, {
      agentKey: unassignedAgentKey,
      file: { name: 'aaw-trigger.txt', bytes: Buffer.from('aaw-trigger-bytes', 'utf-8'), type: 'text/plain' },
    });
    expect(replay.status).toBe(201);
  });
});
