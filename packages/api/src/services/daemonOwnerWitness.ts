import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";

interface OwnerWitness {
  version: 1;
  nonce: string;
  pid: number;
  uid: number;
  boot: string;
  namespace: string;
  startTicks: string;
}

const PREFIX = "owner-v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A witness is issued only when this process can identify its Linux PID namespace. */
function currentIdentity(): Omit<OwnerWitness, "version" | "nonce"> | null {
  if (process.platform !== "linux" || typeof process.getuid !== "function") return null;
  try {
    if (readlinkSync("/proc/self") !== String(process.pid)) return null;
    const namespace = readlinkSync("/proc/self/ns/pid");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync("/proc/self/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const startTicks = close < 0 ? "" : stat.slice(close + 2).split(" ")[19];
    if (!/^pid:\[\d+\]$/.test(namespace) || !/^[0-9a-f-]{36}$/i.test(boot) || !/^\d+$/.test(startTicks ?? "")) return null;
    return { pid: process.pid, uid: process.getuid(), boot, namespace, startTicks };
  } catch {
    return null;
  }
}

function parseIntent(intent: string | null): OwnerWitness | null {
  if (!intent?.startsWith(PREFIX) || intent.length > 2048) return null;
  try {
    const value = JSON.parse(Buffer.from(intent.slice(PREFIX.length), "base64url").toString("utf8")) as Partial<OwnerWitness>;
    if (value.version !== 1 || typeof value.nonce !== "string" || !UUID.test(value.nonce) ||
      !Number.isSafeInteger(value.pid) || value.pid! < 1 || value.pid! > 2147483647 ||
      !Number.isSafeInteger(value.uid) || value.uid! < 0 ||
      typeof value.boot !== "string" || !/^[0-9a-f-]{36}$/i.test(value.boot) ||
      typeof value.namespace !== "string" || !/^pid:\[\d+\]$/.test(value.namespace) ||
      typeof value.startTicks !== "string" || !/^\d+$/.test(value.startTicks)) return null;
    return value as OwnerWitness;
  } catch {
    return null;
  }
}

/** Ownerless fallback preserves Stop on unsupported platforms, without granting recovery. */
export function createDaemonStopIntent(): string {
  const identity = currentIdentity();
  if (!identity) return randomUUID();
  return PREFIX + Buffer.from(JSON.stringify({ version: 1, nonce: randomUUID(), ...identity })).toString("base64url");
}

/** Non-secret, opaque reference for binding an admin request to its observed intent. */
export function daemonStopIntentRef(intent: string | null): string | null {
  return parseIntent(intent)?.nonce ?? null;
}

/** Only absence in the same boot, PID namespace and UID is accepted as proof. */
export function isDaemonStopOwnerTerminated(intent: string): boolean {
  const owner = parseIntent(intent);
  const current = currentIdentity();
  if (!owner || !current || owner.boot !== current.boot || owner.namespace !== current.namespace || owner.uid !== current.uid || owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false; // live, reused, or a zombie: never infer death from age.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    // Do not accept a contradictory or inaccessible proc observation as proof.
    try {
      readFileSync(`/proc/${owner.pid}/stat`, "utf8");
      return false;
    } catch (procError) {
      return (procError as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}
