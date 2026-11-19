import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const TeleportHostSchema = z.object({
  id: z.string(),
  label: z.string(),
  sshTarget: z.string(),
  remoteHome: z.string().optional(),
  remoteServerId: z.string().optional(),
  source: z.enum(["ssh_config", "custom"]),
  isDefault: z.boolean().optional(),
});

export type TeleportHost = z.infer<typeof TeleportHostSchema>;

export const TeleportHistoryEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  direction: z.enum(["push", "pull"]),
  sshTarget: z.string(),
  scope: z.string(),
  projectsSynced: z.number(),
  workspacesSynced: z.number(),
  sessionsSynced: z.number(),
  codeSynced: z.boolean(),
  durationMs: z.number(),
  success: z.boolean(),
  message: z.string(),
});

export type TeleportHistoryEntry = z.infer<typeof TeleportHistoryEntrySchema>;

export const listTeleportStateRpc = defineRpc({
  name: "teleport.state.list",
  input: z.object({}),
  output: z.object({
    localHostname: z.string(),
    localHome: z.string(),
    localServerId: z.string(),
    localProjectCount: z.number(),
    localWorkspaceCount: z.number(),
    localSessionCount: z.number(),
    hosts: z.array(TeleportHostSchema),
    excludes: z.array(z.string()),
    history: z.array(TeleportHistoryEntrySchema),
  }),
});

export const probeTeleportHostRpc = defineRpc({
  name: "teleport.host.probe",
  input: z.object({
    sshTarget: z.string().trim().min(1),
  }),
  output: z.object({
    reachable: z.boolean(),
    remoteHostname: z.string().optional(),
    remoteHome: z.string().optional(),
    remoteServerId: z.string().optional(),
    hasRsync: z.boolean().optional(),
    hasPaseo: z.boolean().optional(),
    remoteSessionCount: z.number().optional(),
    latencyMs: z.number(),
    error: z.string().optional(),
  }),
});

export const saveTeleportConfigRpc = defineRpc({
  name: "teleport.config.save",
  input: z.object({
    action: z.enum(["add_host", "remove_host", "set_default_host", "set_excludes"]),
    host: z
      .object({
        label: z.string().trim().min(1),
        sshTarget: z.string().trim().min(1),
        remoteHome: z.string().trim().optional(),
      })
      .optional(),
    hostId: z.string().optional(),
    excludes: z.array(z.string()).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    hosts: z.array(TeleportHostSchema),
    excludes: z.array(z.string()),
  }),
});

export const runTeleportSyncRpc = defineRpc({
  name: "teleport.sync.run",
  input: z.object({
    direction: z.enum(["push", "pull"]),
    sshTarget: z.string().trim().min(1),
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
    workspaceCwd: z.string().optional(),
    includeCode: z.boolean().default(true),
    includeSessions: z.boolean().default(true),
    restartRemoteDaemon: z.boolean().default(true),
  }),
  output: z.object({
    ok: z.boolean(),
    direction: z.enum(["push", "pull"]),
    sshTarget: z.string(),
    remoteHome: z.string(),
    projectsSynced: z.number(),
    workspacesSynced: z.number(),
    sessionsSynced: z.number(),
    contextFilesSynced: z.number(),
    codeDirsSynced: z.array(z.string()),
    durationMs: z.number(),
    summary: z.string(),
  }),
});

export const TeleportReceiptTimelineSchema = z.object({
  direction: z.enum(["push", "pull"]),
  sshTarget: z.string(),
  remoteHome: z.string(),
  codeDirsSynced: z.array(z.string()),
  sessionsSynced: z.number(),
  durationMs: z.number(),
  timestamp: z.string(),
});

export type TeleportReceiptTimelineData = z.infer<typeof TeleportReceiptTimelineSchema>;
