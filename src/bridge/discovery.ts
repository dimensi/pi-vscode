import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Discovery-файл активных мостов: позволяет внешним pi-процессам (запущенным не
 * расширением) найти URL и токен моста живого окна VS Code — по аналогии с
 * lock-файлами ~/.claude/ide в Claude Code.
 */

export interface BridgeEntry {
  /** PID процесса extension host окна VS Code. */
  pid: number;
  url: string;
  token: string;
  workspaceFolders: string[];
  ts: number;
}

interface DiscoveryFile {
  bridges: BridgeEntry[];
}

const DISCOVERY_DIR = join(homedir(), ".pi", "agent");
const DISCOVERY_PATH = join(DISCOVERY_DIR, "vscode-bridges.json");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: процесс существует, но принадлежит не нам.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isBridgeEntry(value: unknown): value is BridgeEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.pid === "number" &&
    typeof entry.url === "string" &&
    typeof entry.token === "string" &&
    Array.isArray(entry.workspaceFolders) &&
    entry.workspaceFolders.every((folder) => typeof folder === "string")
  );
}

function readDiscovery(): DiscoveryFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(DISCOVERY_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { bridges: [] };
    const bridges = (parsed as Record<string, unknown>).bridges;
    if (!Array.isArray(bridges)) return { bridges: [] };
    return { bridges: bridges.filter(isBridgeEntry) };
  } catch {
    return { bridges: [] };
  }
}

function writeDiscovery(file: DiscoveryFile): void {
  mkdirSync(DISCOVERY_DIR, { recursive: true });
  const tmpPath = `${DISCOVERY_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(file), { mode: 0o600 });
  renameSync(tmpPath, DISCOVERY_PATH);
}

/** Записать (или обновить) запись моста этого окна, вычистив мёртвые PID. */
export function publishBridgeEntry(entry: Omit<BridgeEntry, "ts">): void {
  try {
    const file = readDiscovery();
    file.bridges = file.bridges.filter((other) => other.pid !== entry.pid && isAlive(other.pid));
    file.bridges.push({ ...entry, ts: Date.now() });
    writeDiscovery(file);
  } catch {
    // discovery опционален: не ломаем активацию из-за проблем с файлом
  }
}

/** Убрать запись моста этого окна; удалить файл, когда записей не осталось. */
export function removeBridgeEntry(pid: number): void {
  try {
    const file = readDiscovery();
    file.bridges = file.bridges.filter((other) => other.pid !== pid);
    if (file.bridges.length === 0) {
      rmSync(DISCOVERY_PATH, { force: true });
      return;
    }
    writeDiscovery(file);
  } catch {
    // аналогично: удаление best-effort
  }
}
