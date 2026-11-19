import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import {
  TeleportComposerPopover,
  TeleportReceiptRenderer,
  TeleportStudioScreen,
} from "./client/teleport-ui";
import {
  TeleportReceiptTimelineSchema,
  listTeleportStateRpc,
  runTeleportSyncRpc,
} from "./shared/contracts";

function TeleportSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ArrowLeftRight"
      active={currentScreen?.screenId === "teleport-studio"}
      onPress={() => openScreen({ screenId: "teleport-studio" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "teleport-studio",
    title: "Host Teleport",
    Component: TeleportStudioScreen,
  });

  client.addSidebarHeaderItem({
    id: "teleport-studio",
    title: "Host Teleport",
    Component: TeleportSidebarItem,
  });

  client.addTimelineRenderer({
    kind: "teleport-receipt",
    version: 1,
    schema: TeleportReceiptTimelineSchema,
    Component: TeleportReceiptRenderer,
  });

  client.addCommandCenterItem({
    id: "open-teleport-studio",
    title: "Host Teleport: Open Studio",
    icon: "ArrowLeftRight",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "teleport-studio" });
    },
  });

  client.addSlashCommand({
    name: "teleport",
    description: "Push or pull current workspace & session across SSH hosts",
    argumentHint: "[push|pull] [ssh-host]",
    context: "agent",
    async onSubmit({ args, agent, workspace, rpc, openScreen }) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const dirArg = parts[0]?.toLowerCase();
      if (dirArg !== "push" && dirArg !== "pull") {
        openScreen({ screenId: "teleport-studio" });
        return;
      }
      let target = parts[1];
      if (!target) {
        const state = await rpc(listTeleportStateRpc, {});
        const def = state.hosts.find((h) => h.isDefault) ?? state.hosts[0];
        target = def?.sshTarget;
      }
      if (!target) {
        openScreen({ screenId: "teleport-studio" });
        return;
      }
      await rpc(runTeleportSyncRpc, {
        direction: dirArg,
        sshTarget: target,
        agentId: agent.id,
        workspaceId: workspace.id,
        workspaceCwd: agent.cwd,
        includeCode: true,
        includeSessions: true,
        restartRemoteDaemon: true,
      });
    },
  });

  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  const registerPill = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "host-teleport",
        workspaceId,
        agentId,
        button: {
          title: "Teleport session & code to/from remote SSH host",
          icon: "ArrowLeftRight",
          label: "Teleport",
          behavior: {
            kind: "popover",
            Content: TeleportComposerPopover,
          },
        },
      }),
    );
  };

  const removeAllPills = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAllPills();
          for (const { agent } of entries) registerPill(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return registerPill(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch(() => {});

  return () => {
    lifetime.abort();
    removeAllPills();
  };
}
