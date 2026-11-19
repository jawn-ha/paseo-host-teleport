import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  type TeleportHistoryEntry,
  type TeleportHost,
  type probeTeleportHostRpc,
  type runTeleportSyncRpc,
  type saveTeleportConfigRpc,
} from "../shared/contracts";

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".DS_Store",
  ".next",
  "dist",
  "target",
  ".venv",
  "__pycache__",
];

const IGNORED_SSH_HOSTS = new Set([
  "*",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com",
]);

const REMOTE_ENV_PREFIX =
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ' +
  'if [ -d "$HOME/.nvm/versions/node" ]; then ' +
  'NVM_BIN="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -n 1)"; ' +
  '[ -n "$NVM_BIN" ] && export PATH="$NVM_BIN:$PATH"; ' +
  "fi; ";

interface TeleportSavedConfig {
  customHosts: TeleportHost[];
  defaultHostId?: string;
  excludes: string[];
  history: TeleportHistoryEntry[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execFileAsync(
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeout ?? 30000,
        maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

function getPaseoHome(): string {
  return process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

function getConfigPath(): string {
  return path.join(getPaseoHome(), "teleport-config.json");
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function loadSavedConfig(): TeleportSavedConfig {
  const raw = readJsonSafe<Partial<TeleportSavedConfig>>(getConfigPath(), {});
  return {
    customHosts: Array.isArray(raw.customHosts) ? raw.customHosts : [],
    defaultHostId: typeof raw.defaultHostId === "string" ? raw.defaultHostId : undefined,
    excludes:
      Array.isArray(raw.excludes) && raw.excludes.length > 0 ? raw.excludes : DEFAULT_EXCLUDES,
    history: Array.isArray(raw.history) ? raw.history.slice(0, 25) : [],
  };
}

function saveConfig(config: TeleportSavedConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

function discoverSshConfigHosts(): TeleportHost[] {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(sshConfigPath)) return [];
  const text = fs.readFileSync(sshConfigPath, "utf8");
  const hosts: TeleportHost[] = [];
  const seen = new Set<string>();

  let currentAliases: string[] = [];
  let currentHostName = "";
  let currentUser = "";

  const flush = () => {
    for (const alias of currentAliases) {
      if (!alias || alias.includes("*") || alias.includes("?") || IGNORED_SSH_HOSTS.has(alias)) {
        continue;
      }
      if (seen.has(alias)) continue;
      seen.add(alias);
      const hint = currentHostName
        ? `${currentUser ? `${currentUser}@` : ""}${currentHostName}`
        : alias;
      hosts.push({
        id: `ssh:${alias}`,
        label: hint !== alias ? `${alias} (${hint})` : alias,
        sshTarget: alias,
        source: "ssh_config",
      });
    }
    currentAliases = [];
    currentHostName = "";
    currentUser = "";
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "host") {
      flush();
      currentAliases = val.split(/\s+/);
    } else if (key === "hostname") {
      currentHostName = val;
    } else if (key === "user") {
      currentUser = val;
    }
  }
  flush();
  return hosts;
}

function getAllHosts(saved: TeleportSavedConfig): TeleportHost[] {
  const discovered = discoverSshConfigHosts();
  const map = new Map<string, TeleportHost>();
  for (const h of discovered) map.set(h.sshTarget, h);
  for (const c of saved.customHosts) map.set(c.sshTarget, c);
  const all = Array.from(map.values());
  const defaultId = saved.defaultHostId || all[0]?.id;
  return all.map((h) => ({
    ...h,
    isDefault: h.id === defaultId || h.sshTarget === defaultId,
  }));
}

function getLocalServerId(): string {
  const idFile = path.join(getPaseoHome(), "server-id");
  try {
    return fs.readFileSync(idFile, "utf8").trim() || "local";
  } catch {
    return "local";
  }
}

function sanitizeCwdDirName(cwdPath: string): string {
  return cwdPath.replace(/^\/+/, "").replace(/[\/\\:]+/g, "-");
}

function countLocalSessions(): number {
  const agentsRoot = path.join(getPaseoHome(), "agents");
  if (!fs.existsSync(agentsRoot)) return 0;
  let total = 0;
  for (const dir of fs.readdirSync(agentsRoot)) {
    const full = path.join(agentsRoot, dir);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      total += fs.readdirSync(full).filter((f) => f.endsWith(".json")).length;
    } catch {}
  }
  return total;
}

export function listTeleportState() {
  const saved = loadSavedConfig();
  const paseoHome = getPaseoHome();
  const projects = readJsonSafe<unknown[]>(path.join(paseoHome, "projects/projects.json"), []);
  const workspaces = readJsonSafe<unknown[]>(path.join(paseoHome, "projects/workspaces.json"), []);

  return {
    localHostname: os.hostname(),
    localHome: os.homedir(),
    localServerId: getLocalServerId(),
    localProjectCount: projects.length,
    localWorkspaceCount: workspaces.length,
    localSessionCount: countLocalSessions(),
    hosts: getAllHosts(saved),
    excludes: saved.excludes,
    history: saved.history,
  };
}

function validateSshTarget(target: string): void {
  if (!/^[a-zA-Z0-9._@-]+(?::\d+)?$/.test(target)) {
    throw new Error(`Invalid SSH target format: ${target}`);
  }
}

function splitSshTarget(target: string): { hostSpec: string; port?: string } {
  validateSshTarget(target);
  const idx = target.lastIndexOf(":");
  if (idx > 0) {
    return { hostSpec: target.slice(0, idx), port: target.slice(idx + 1) };
  }
  return { hostSpec: target };
}

export async function probeTeleportHost({ sshTarget }: RpcInput<typeof probeTeleportHostRpc>) {
  const start = Date.now();
  try {
    const { hostSpec, port } = splitSshTarget(sshTarget);
    const sshArgs = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=6",
      ...(port ? ["-p", port] : []),
      hostSpec,
      REMOTE_ENV_PREFIX +
        'echo "HOST=$(hostname)"; ' +
        'echo "HOME=$HOME"; ' +
        'echo "SRVID=$(cat ~/.paseo/server-id 2>/dev/null || echo unknown)"; ' +
        'echo "RSYNC=$(command -v rsync >/dev/null 2>&1 && echo 1 || echo 0)"; ' +
        'echo "PASEO=$(command -v paseo >/dev/null 2>&1 && echo 1 || echo 0)"; ' +
        'echo "SESSIONS=$(find ~/.paseo/agents -name "*.json" 2>/dev/null | wc -l | tr -d " ")"',
    ];
    const out = await execFileAsync("ssh", sshArgs, { timeout: 10000 });
    const kv = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return {
      reachable: true,
      remoteHostname: kv.get("HOST") || hostSpec,
      remoteHome: kv.get("HOME") || "",
      remoteServerId: kv.get("SRVID") || "unknown",
      hasRsync: kv.get("RSYNC") === "1",
      hasPaseo: kv.get("PASEO") === "1",
      remoteSessionCount: Number(kv.get("SESSIONS") || "0"),
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function saveTeleportConfig(input: RpcInput<typeof saveTeleportConfigRpc>) {
  const saved = loadSavedConfig();
  if (input.action === "add_host" && input.host) {
    validateSshTarget(input.host.sshTarget);
    const id = `custom:${input.host.sshTarget}`;
    saved.customHosts = saved.customHosts.filter((h) => h.sshTarget !== input.host?.sshTarget);
    saved.customHosts.push({
      id,
      label: input.host.label,
      sshTarget: input.host.sshTarget,
      remoteHome: input.host.remoteHome || undefined,
      source: "custom",
    });
    if (!saved.defaultHostId) saved.defaultHostId = id;
  } else if (input.action === "remove_host" && input.hostId) {
    saved.customHosts = saved.customHosts.filter(
      (h) => h.id !== input.hostId && h.sshTarget !== input.hostId,
    );
    if (saved.defaultHostId === input.hostId) saved.defaultHostId = undefined;
  } else if (input.action === "set_default_host" && input.hostId) {
    saved.defaultHostId = input.hostId;
  } else if (input.action === "set_excludes" && input.excludes) {
    saved.excludes = input.excludes.map((s) => s.trim()).filter(Boolean);
  }
  saveConfig(saved);
  return {
    ok: true,
    hosts: getAllHosts(saved),
    excludes: saved.excludes,
  };
}

function findMatchingFiles(dir: string, matchIds: Set<string>, out: string[] = []): string[] {
  if (!fs.existsSync(dir) || matchIds.size === 0) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMatchingFiles(p, matchIds, out);
    } else if (entry.name.endsWith(".jsonl")) {
      for (const id of matchIds) {
        if (entry.name.includes(id)) {
          out.push(p);
          break;
        }
      }
    }
  }
  return out;
}

function getJsonUpdatedAt(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { updatedAt?: string };
    return parsed.updatedAt ? new Date(parsed.updatedAt).getTime() : 0;
  } catch {
    return 0;
  }
}

export async function runTeleportSync(input: RpcInput<typeof runTeleportSyncRpc>) {
  const start = Date.now();
  const saved = loadSavedConfig();
  const { hostSpec, port } = splitSshTarget(input.sshTarget);
  const probe = await probeTeleportHost({ sshTarget: input.sshTarget });
  if (!probe.reachable || !probe.remoteHome) {
    throw new Error(
      `Cannot reach SSH host "${input.sshTarget}": ${probe.error || "Failed to detect remote $HOME"}`,
    );
  }
  if (input.includeCode && !probe.hasRsync) {
    throw new Error(`Remote host "${input.sshTarget}" does not have rsync installed.`);
  }

  const localHome = os.homedir();
  const remoteHome = probe.remoteHome;
  const localServerId = getLocalServerId();
  const remoteServerId =
    probe.remoteServerId && probe.remoteServerId !== "unknown"
      ? probe.remoteServerId
      : localServerId;

  const paseoHome = getPaseoHome();
  const excludeArgs = saved.excludes.flatMap((ex) => ["--exclude", ex]);
  const sshTransport = port ? `ssh -p ${port}` : "ssh";
  const sshPortArgs = port ? ["-p", port] : [];

  const codeDirsSynced: string[] = [];
  let projectsSynced = 0;
  let workspacesSynced = 0;
  let sessionsSynced = 0;
  let contextFilesSynced = 0;

  if (input.direction === "push") {
    const allProjects = readJsonSafe<Array<Record<string, any>>>(
      path.join(paseoHome, "projects/projects.json"),
      [],
    );
    const allWorkspaces = readJsonSafe<Array<Record<string, any>>>(
      path.join(paseoHome, "projects/workspaces.json"),
      [],
    );

    const targetWorkspaces = input.workspaceId
      ? allWorkspaces.filter((w) => w.workspaceId === input.workspaceId)
      : input.workspaceCwd
        ? allWorkspaces.filter((w) => w.cwd === input.workspaceCwd)
        : allWorkspaces;

    const targetProjectIds = new Set(targetWorkspaces.map((w) => w.projectId));
    const targetProjects =
      targetProjectIds.size > 0
        ? allProjects.filter((p) => targetProjectIds.has(p.projectId))
        : allProjects;

    // 1. Sync workspace code via rsync
    if (input.includeCode) {
      const dirsToSync = new Set<string>();
      if (input.workspaceCwd && fs.existsSync(input.workspaceCwd)) {
        dirsToSync.add(input.workspaceCwd);
      } else {
        for (const p of targetProjects) {
          if (!p.archivedAt && typeof p.rootPath === "string" && fs.existsSync(p.rootPath)) {
            dirsToSync.add(p.rootPath);
          }
        }
      }

      for (const localDir of dirsToSync) {
        const remoteDir = localDir.startsWith(localHome)
          ? remoteHome + localDir.slice(localHome.length)
          : localDir;
        await execFileAsync(
          "ssh",
          [...sshPortArgs, hostSpec, `mkdir -p ${shellQuote(remoteDir)}`],
          { timeout: 15000 },
        );
        await execFileAsync(
          "rsync",
          [
            "-azs",
            "-e",
            sshTransport,
            ...excludeArgs,
            `${localDir}/`,
            `${hostSpec}:${remoteDir}/`,
          ],
          { timeout: 300000 },
        );
        codeDirsSynced.push(localDir);
      }
    }

    // 2. Sync Paseo projects, workspaces, and agent sessions
    if (input.includeSessions) {
      const mappedProjects = targetProjects.map((p) => ({
        ...p,
        rootPath: String(p.rootPath || "").replaceAll(localHome, remoteHome),
        projectKey: String(p.projectKey || "")
          .replace(/host:srv_[^:]+:/, `host:${remoteServerId}:`)
          .replaceAll(localHome, remoteHome),
      }));

      const mappedWorkspaces = targetWorkspaces.map((w) => ({
        ...w,
        cwd: String(w.cwd || "").replaceAll(localHome, remoteHome),
        worktreeRoot: w.worktreeRoot ? String(w.worktreeRoot).replaceAll(localHome, remoteHome) : null,
        mainRepoRoot: w.mainRepoRoot ? String(w.mainRepoRoot).replaceAll(localHome, remoteHome) : null,
      }));

      const agentsRoot = path.join(paseoHome, "agents");
      const filesToPush: Array<{ relPath: string; content: string }> = [];
      const nativeSessionIds = new Set<string>();

      const localSanitizedPrefix = sanitizeCwdDirName(localHome);
      const remoteSanitizedPrefix = sanitizeCwdDirName(remoteHome);

      if (fs.existsSync(agentsRoot)) {
        for (const dir of fs.readdirSync(agentsRoot)) {
          const fullDir = path.join(agentsRoot, dir);
          if (!fs.statSync(fullDir).isDirectory()) continue;
          const remoteDirName = dir.startsWith(localSanitizedPrefix)
            ? remoteSanitizedPrefix + dir.slice(localSanitizedPrefix.length)
            : dir;

          for (const f of fs.readdirSync(fullDir)) {
            if (!f.endsWith(".json")) continue;
            const raw = fs.readFileSync(path.join(fullDir, f), "utf8");
            try {
              const parsed = JSON.parse(raw);
              if (input.agentId && parsed.id !== input.agentId) continue;
              if (
                input.workspaceId &&
                !input.agentId &&
                parsed.workspaceId !== input.workspaceId
              ) {
                continue;
              }
              if (parsed.runtimeInfo?.sessionId) {
                nativeSessionIds.add(String(parsed.runtimeInfo.sessionId));
              }
            } catch {}
            filesToPush.push({
              relPath: `.paseo/agents/${remoteDirName}/${f}`,
              content: raw.replaceAll(localHome, remoteHome),
            });
            sessionsSynced++;
          }
        }
      }

      // Sync native Codex & Claude Code session files
      for (const storeRel of [".codex/sessions", ".claude/projects"]) {
        const matched = findMatchingFiles(path.join(localHome, storeRel), nativeSessionIds);
        for (const mf of matched) {
          const rel = mf.slice(localHome.length + 1).replaceAll(localSanitizedPrefix, remoteSanitizedPrefix);
          filesToPush.push({
            relPath: rel,
            content: fs.readFileSync(mf, "utf8").replaceAll(localHome, remoteHome),
          });
          contextFilesSynced++;
        }
      }

      const remoteApplyScript = `
const fs = require("fs");
const path = require("path");
const os = require("os");
const bundle = JSON.parse(fs.readFileSync(0, "utf8"));
const home = os.homedir();

function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; }
}
function mergeById(oldArr, newArr, key) {
  const m = new Map(oldArr.map(x => [x[key], x]));
  for (const item of newArr) m.set(item[key], item);
  return Array.from(m.values());
}

const projDir = path.join(home, ".paseo/projects");
fs.mkdirSync(projDir, { recursive: true });
const curProj = readJson(path.join(projDir, "projects.json"), []);
const curWks = readJson(path.join(projDir, "workspaces.json"), []);
fs.writeFileSync(path.join(projDir, "projects.json"), JSON.stringify(mergeById(curProj, bundle.projects, "projectId"), null, 2));
fs.writeFileSync(path.join(projDir, "workspaces.json"), JSON.stringify(mergeById(curWks, bundle.workspaces, "workspaceId"), null, 2));

for (const f of bundle.files) {
  const target = path.join(home, f.relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, f.content);
}
`;
      const restartCmd = input.restartRemoteDaemon
        ? " && (paseo daemon restart >/dev/null 2>&1 || true)"
        : "";

      await execFileAsync(
        "ssh",
        [
          ...sshPortArgs,
          hostSpec,
          `${REMOTE_ENV_PREFIX}node -e ${shellQuote(remoteApplyScript)}${restartCmd}`,
        ],
        {
          input: JSON.stringify({
            projects: mappedProjects,
            workspaces: mappedWorkspaces,
            files: filesToPush,
          }),
          timeout: 60000,
        },
      );

      projectsSynced = mappedProjects.length;
      workspacesSynced = mappedWorkspaces.length;
    }
  } else {
    // PULL: Remote -> Local
    if (input.includeSessions) {
      const remoteFetchScript = `
const fs = require("fs");
const path = require("path");
const os = require("os");
const home = os.homedir();
function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; }
}
const projects = readJson(path.join(home, ".paseo/projects/projects.json"), []);
const workspaces = readJson(path.join(home, ".paseo/projects/workspaces.json"), []);
const agentsRoot = path.join(home, ".paseo/agents");
const agentFiles = [];
const nativeIds = new Set();

if (fs.existsSync(agentsRoot)) {
  for (const dir of fs.readdirSync(agentsRoot)) {
    const fullDir = path.join(agentsRoot, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    for (const f of fs.readdirSync(fullDir)) {
      if (!f.endsWith(".json")) continue;
      const raw = fs.readFileSync(path.join(fullDir, f), "utf8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed.runtimeInfo?.sessionId) nativeIds.add(String(parsed.runtimeInfo.sessionId));
      } catch {}
      agentFiles.push({ dir, name: f, content: raw });
    }
  }
}

function findFiles(dir, matchIds, out = []) {
  if (!fs.existsSync(dir) || matchIds.size === 0) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(p, matchIds, out);
    else if (entry.name.endsWith(".jsonl")) {
      for (const id of matchIds) {
        if (entry.name.includes(id)) { out.push(p); break; }
      }
    }
  }
  return out;
}

const contextFiles = [];
for (const storeRel of [".codex/sessions", ".claude/projects"]) {
  for (const cf of findFiles(path.join(home, storeRel), nativeIds)) {
    contextFiles.push({ relPath: cf.slice(home.length + 1), content: fs.readFileSync(cf, "utf8") });
  }
}
process.stdout.write(JSON.stringify({ projects, workspaces, agentFiles, contextFiles }));
`;

      const rawOut = await execFileAsync(
        "ssh",
        [...sshPortArgs, hostSpec, `${REMOTE_ENV_PREFIX}node -e ${shellQuote(remoteFetchScript)}`],
        { maxBuffer: 100 * 1024 * 1024, timeout: 60000 },
      );
      const bundle = JSON.parse(rawOut);

      const mappedProjects = (bundle.projects || []).map((p: Record<string, any>) => ({
        ...p,
        rootPath: String(p.rootPath || "").replaceAll(remoteHome, localHome),
        projectKey: String(p.projectKey || "")
          .replace(/host:srv_[^:]+:/, `host:${localServerId}:`)
          .replaceAll(remoteHome, localHome),
      }));

      const mappedWorkspaces = (bundle.workspaces || []).map((w: Record<string, any>) => ({
        ...w,
        cwd: String(w.cwd || "").replaceAll(remoteHome, localHome),
        worktreeRoot: w.worktreeRoot ? String(w.worktreeRoot).replaceAll(remoteHome, localHome) : null,
        mainRepoRoot: w.mainRepoRoot ? String(w.mainRepoRoot).replaceAll(remoteHome, localHome) : null,
      }));

      const localProjPath = path.join(paseoHome, "projects/projects.json");
      const localWksPath = path.join(paseoHome, "projects/workspaces.json");
      const curProj = readJsonSafe<Array<Record<string, any>>>(localProjPath, []);
      const curWks = readJsonSafe<Array<Record<string, any>>>(localWksPath, []);

      const mergeById = (oldArr: Array<Record<string, any>>, newArr: Array<Record<string, any>>, key: string) => {
        const m = new Map(oldArr.map((x) => [x[key], x]));
        for (const item of newArr) {
          const ex = m.get(item[key]);
          if (!ex || new Date(item.updatedAt || 0) >= new Date(ex.updatedAt || 0)) {
            m.set(item[key], item);
          }
        }
        return Array.from(m.values());
      };

      fs.mkdirSync(path.join(paseoHome, "projects"), { recursive: true });
      fs.writeFileSync(localProjPath, JSON.stringify(mergeById(curProj, mappedProjects, "projectId"), null, 2));
      fs.writeFileSync(localWksPath, JSON.stringify(mergeById(curWks, mappedWorkspaces, "workspaceId"), null, 2));

      const localSanitizedPrefix = sanitizeCwdDirName(localHome);
      const remoteSanitizedPrefix = sanitizeCwdDirName(remoteHome);

      for (const af of bundle.agentFiles || []) {
        const localDir = String(af.dir).startsWith(remoteSanitizedPrefix)
          ? localSanitizedPrefix + String(af.dir).slice(remoteSanitizedPrefix.length)
          : String(af.dir);
        const target = path.join(paseoHome, "agents", localDir, af.name);
        const incoming = String(af.content).replaceAll(remoteHome, localHome);
        if (fs.existsSync(target)) {
          const localUpdatedAt = getJsonUpdatedAt(fs.readFileSync(target, "utf8"));
          const remoteUpdatedAt = getJsonUpdatedAt(incoming);
          if (localUpdatedAt > remoteUpdatedAt && remoteUpdatedAt > 0) {
            continue;
          }
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, incoming);
        sessionsSynced++;
      }

      for (const cf of bundle.contextFiles || []) {
        const rel = String(cf.relPath).replaceAll(remoteSanitizedPrefix, localSanitizedPrefix);
        const target = path.join(localHome, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(cf.content).replaceAll(remoteHome, localHome));
        contextFilesSynced++;
      }

      projectsSynced = mappedProjects.length;
      workspacesSynced = mappedWorkspaces.length;
    }

    if (input.includeCode) {
      const localProjects = readJsonSafe<Array<Record<string, any>>>(
        path.join(paseoHome, "projects/projects.json"),
        [],
      );
      const dirsToPull = new Set<string>();
      if (input.workspaceCwd) {
        dirsToPull.add(input.workspaceCwd);
      } else {
        for (const p of localProjects) {
          if (!p.archivedAt && typeof p.rootPath === "string") dirsToPull.add(p.rootPath);
        }
      }
      for (const localDir of dirsToPull) {
        const remoteDir = localDir.startsWith(localHome)
          ? remoteHome + localDir.slice(localHome.length)
          : localDir;
        const existsCheck = await execFileAsync(
          "ssh",
          [...sshPortArgs, hostSpec, `[ -d ${shellQuote(remoteDir)} ] && echo 1 || echo 0`],
          { timeout: 15000 },
        );
        if (existsCheck.trim() !== "1") continue;

        fs.mkdirSync(localDir, { recursive: true });
        await execFileAsync(
          "rsync",
          [
            "-azs",
            "-e",
            sshTransport,
            ...excludeArgs,
            `${hostSpec}:${remoteDir}/`,
            `${localDir}/`,
          ],
          { timeout: 300000 },
        );
        codeDirsSynced.push(localDir);
      }
    }
  }

  const durationMs = Date.now() - start;
  const summary =
    input.direction === "push"
      ? `Pushed ${sessionsSynced} session(s) and ${codeDirsSynced.length} workspace folder(s) to ${input.sshTarget} in ${(durationMs / 1000).toFixed(1)}s`
      : `Pulled ${sessionsSynced} session(s) and ${codeDirsSynced.length} workspace folder(s) from ${input.sshTarget} in ${(durationMs / 1000).toFixed(1)}s`;

  saved.history = [
    {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      direction: input.direction,
      sshTarget: input.sshTarget,
      scope: input.workspaceCwd ? path.basename(input.workspaceCwd) : "All active workspaces",
      projectsSynced,
      workspacesSynced,
      sessionsSynced,
      codeSynced: codeDirsSynced.length > 0,
      durationMs,
      success: true,
      message: summary,
    },
    ...saved.history,
  ].slice(0, 25);
  saveConfig(saved);

  return {
    ok: true,
    direction: input.direction,
    sshTarget: input.sshTarget,
    remoteHome,
    projectsSynced,
    workspacesSynced,
    sessionsSynced,
    contextFilesSynced,
    codeDirsSynced,
    durationMs,
    summary,
  };
}
