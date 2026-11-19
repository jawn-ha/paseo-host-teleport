import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  listTeleportState,
  probeTeleportHost,
  runTeleportSync,
  saveTeleportConfig,
} from "./server/teleport";
import {
  listTeleportStateRpc,
  probeTeleportHostRpc,
  runTeleportSyncRpc,
  saveTeleportConfigRpc,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(listTeleportStateRpc, () => listTeleportState());
  server.handle(probeTeleportHostRpc, (input) => probeTeleportHost(input));
  server.handle(saveTeleportConfigRpc, (input) => saveTeleportConfig(input));
  server.handle(runTeleportSyncRpc, async (input, { paseo }) => {
    const result = await runTeleportSync(input);
    if (input.agentId) {
      try {
        await paseo.agents.ref(input.agentId).timeline.append({
          type: "plugin",
          id: `teleport-${Date.now()}`,
          kind: "teleport-receipt",
          version: 1,
          data: {
            direction: result.direction,
            sshTarget: result.sshTarget,
            remoteHome: result.remoteHome,
            codeDirsSynced: result.codeDirsSynced,
            sessionsSynced: result.sessionsSynced,
            durationMs: result.durationMs,
            timestamp: new Date().toISOString(),
          },
        });
      } catch {}
    }
    return result;
  });
  return () => {};
}
