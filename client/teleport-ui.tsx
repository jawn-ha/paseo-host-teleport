import type {
  PluginButtonContentProps,
  PluginScreenProps,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  type TeleportReceiptTimelineData,
  listTeleportStateRpc,
  probeTeleportHostRpc,
  runTeleportSyncRpc,
  saveTeleportConfigRpc,
} from "../shared/contracts";

export function TeleportReceiptRenderer({
  item,
  theme,
}: PluginTimelineItemProps<TeleportReceiptTimelineData>) {
  const { data } = item;
  const isPush = data.direction === "push";
  return (
    <View
      style={{
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 4,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
        {isPush ? "🚀 Teleported to Remote Host" : "📥 Pulled from Remote Host"} · {data.sshTarget}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Synced {data.sessionsSynced} session(s) & {data.codeDirsSynced.length} workspace folder(s){" "}
        {isPush ? `→ ${data.remoteHome}` : `← ${data.remoteHome}`} in{" "}
        {(data.durationMs / 1000).toFixed(1)}s
      </Text>
    </View>
  );
}

export function TeleportComposerPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return (
    <TeleportQuickPanel
      agentId={props.agentId}
      workspaceId={props.workspaceId}
      theme={props.theme}
      close={props.close}
    />
  );
}

function TeleportQuickPanel({
  agentId,
  workspaceId,
  theme,
  close,
}: {
  agentId: string;
  workspaceId: string;
  theme: PluginButtonContentProps["theme"];
  close(): void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const listState = useRpc(listTeleportStateRpc);
  const runSync = useRpc(runTeleportSyncRpc);

  const agentInfo = useAgent(agentId, (a) => ({
    cwd: a.cwd,
    title: a.title,
  }));

  const stateQuery = useQuery({
    queryKey: ["paseo-host-teleport", "state"],
    queryFn: () => listState({}),
  });

  const [selectedTarget, setSelectedTarget] = useState<string>("");
  const [includeCode, setIncludeCode] = useState(true);

  useEffect(() => {
    if (!selectedTarget && stateQuery.data?.hosts.length) {
      const def = stateQuery.data.hosts.find((h) => h.isDefault) ?? stateQuery.data.hosts[0];
      if (def) setSelectedTarget(def.sshTarget);
    }
  }, [selectedTarget, stateQuery.data]);

  const syncMutation = useMutation({
    mutationFn: (direction: "push" | "pull") =>
      runSync({
        direction,
        sshTarget: selectedTarget,
        agentId,
        workspaceId,
        workspaceCwd: agentInfo?.cwd,
        includeCode,
        includeSessions: true,
        restartRemoteDaemon: true,
      }),
    onSuccess(res) {
      toast.show(res.summary, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["paseo-host-teleport"] });
      close();
    },
    onError(err) {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const hosts = stateQuery.data?.hosts ?? [];

  return (
    <View
      style={{
        width: 340,
        padding: 14,
        gap: 10,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 15 }}>
        ⚡ Host Teleport
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        Workspace: {agentInfo?.cwd ?? "Current workspace"}
      </Text>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
        Target SSH Host (~/.ssh/config or custom):
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {hosts.map((h) => {
          const active = h.sshTarget === selectedTarget;
          return (
            <Pressable
              key={h.id}
              accessibilityRole="button"
              onPress={() => setSelectedTarget(h.sshTarget)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1,
              }}
            >
              <Text
                style={{
                  color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                  fontSize: 12,
                  fontWeight: active ? "600" : "400",
                }}
              >
                {h.sshTarget}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        accessibilityRole="checkbox"
        onPress={() => setIncludeCode((v) => !v)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 4,
        }}
      >
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: includeCode ? theme.colors.accent : theme.colors.surface1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {includeCode ? (
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>✓</Text>
          ) : null}
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
          Sync uncommitted code via rsync
        </Text>
      </Pressable>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        <Pressable
          accessibilityRole="button"
          disabled={!selectedTarget || syncMutation.isPending}
          onPress={() => syncMutation.mutate("push")}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: theme.colors.accent,
            alignItems: "center",
            opacity: !selectedTarget || syncMutation.isPending ? 0.6 : 1,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", fontSize: 12 }}>
            {syncMutation.isPending ? "Teleporting..." : "🚀 Push to Remote"}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={!selectedTarget || syncMutation.isPending}
          onPress={() => syncMutation.mutate("pull")}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            alignItems: "center",
            opacity: !selectedTarget || syncMutation.isPending ? 0.6 : 1,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 12 }}>
            📥 Pull to Local
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function TeleportStudioScreen({ theme, layout }: PluginScreenProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const listState = useRpc(listTeleportStateRpc);
  const probeHost = useRpc(probeTeleportHostRpc);
  const saveConfig = useRpc(saveTeleportConfigRpc);
  const runSync = useRpc(runTeleportSyncRpc);

  const stateQuery = useQuery({
    queryKey: ["paseo-host-teleport", "state"],
    queryFn: () => listState({}),
  });

  const [selectedTarget, setSelectedTarget] = useState<string>("");
  const [newLabel, setNewLabel] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [includeCode, setIncludeCode] = useState(true);
  const [includeSessions, setIncludeSessions] = useState(true);

  useEffect(() => {
    if (!selectedTarget && stateQuery.data?.hosts.length) {
      const def = stateQuery.data.hosts.find((h) => h.isDefault) ?? stateQuery.data.hosts[0];
      if (def) setSelectedTarget(def.sshTarget);
    }
  }, [selectedTarget, stateQuery.data]);

  const probeMutation = useMutation({
    mutationFn: (sshTarget: string) => probeHost({ sshTarget }),
    onSuccess(res) {
      if (res.reachable) {
        toast.show(
          `Connected to ${res.remoteHostname} (${res.remoteHome}) in ${res.latencyMs}ms`,
          { variant: "success" },
        );
      } else {
        toast.error(`SSH Probe Failed: ${res.error}`);
      }
    },
  });

  const addHostMutation = useMutation({
    mutationFn: () =>
      saveConfig({
        action: "add_host",
        host: {
          label: newLabel.trim() || newTarget.trim(),
          sshTarget: newTarget.trim(),
        },
      }),
    onSuccess() {
      setSelectedTarget(newTarget.trim());
      setNewLabel("");
      setNewTarget("");
      void queryClient.invalidateQueries({ queryKey: ["paseo-host-teleport"] });
      toast.show("Saved SSH host target", { variant: "success" });
    },
    onError(err) {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const setDefaultHostMutation = useMutation({
    mutationFn: (hostId: string) => saveConfig({ action: "set_default_host", hostId }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["paseo-host-teleport"] });
      toast.show("Updated default SSH host", { variant: "success" });
    },
    onError(err) {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const removeHostMutation = useMutation({
    mutationFn: (hostId: string) => saveConfig({ action: "remove_host", hostId }),
    onSuccess(res) {
      if (!res.hosts.some((h) => h.sshTarget === selectedTarget)) {
        setSelectedTarget(res.hosts[0]?.sshTarget ?? "");
      }
      void queryClient.invalidateQueries({ queryKey: ["paseo-host-teleport"] });
      toast.show("Removed custom SSH host", { variant: "success" });
    },
    onError(err) {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const syncMutation = useMutation({
    mutationFn: (direction: "push" | "pull") =>
      runSync({
        direction,
        sshTarget: selectedTarget,
        includeCode,
        includeSessions,
        restartRemoteDaemon: true,
      }),
    onSuccess(res) {
      toast.show(res.summary, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["paseo-host-teleport"] });
    },
    onError(err) {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const data = stateQuery.data;
  const pad = layout.compact ? 14 : 24;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: pad, gap: 16 }}
    >
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
          ⚡ Host Teleport Studio
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          Seamlessly hand off uncommitted code edits, workspaces, and live AI agent sessions across SSH hosts.
        </Text>
      </View>

      {/* Local Host Summary Card */}
      <View
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 6,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>
          💻 Current Daemon Host: {data?.localHostname ?? "..."}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Home: {data?.localHome} · Server ID: {data?.localServerId}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Active Projects: {data?.localProjectCount ?? 0} · Workspaces: {data?.localWorkspaceCount ?? 0} · Agent Sessions: {data?.localSessionCount ?? 0}
        </Text>
      </View>

      {/* Target SSH Host Picker */}
      <View
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 10,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>
          🎯 Target SSH Host (Auto-discovered from ~/.ssh/config & Custom)
        </Text>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(data?.hosts ?? []).length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              No SSH hosts found in ~/.ssh/config yet. Add a custom target below.
            </Text>
          ) : null}
          {(data?.hosts ?? []).map((h) => {
            const active = h.sshTarget === selectedTarget;
            return (
              <View
                key={h.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : theme.colors.border,
                  backgroundColor: active ? theme.colors.surface2 : theme.colors.surface0,
                  overflow: "hidden",
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSelectedTarget(h.sshTarget)}
                  style={{ paddingHorizontal: 10, paddingVertical: 8 }}
                >
                  <Text
                    style={{
                      color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                      fontWeight: active ? "600" : "400",
                      fontSize: 13,
                    }}
                  >
                    {h.isDefault ? `★ ${h.label}` : h.label}
                  </Text>
                </Pressable>
                {!h.isDefault ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setDefaultHostMutation.mutate(h.id)}
                    style={{ paddingHorizontal: 6, paddingVertical: 8 }}
                  >
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>☆</Text>
                  </Pressable>
                ) : null}
                {h.source === "custom" ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => removeHostMutation.mutate(h.id)}
                    style={{ paddingHorizontal: 8, paddingVertical: 8 }}
                  >
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>

        {selectedTarget ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => probeMutation.mutate(selectedTarget)}
              disabled={probeMutation.isPending}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {probeMutation.isPending ? "Probing SSH..." : `🔍 Probe SSH (${selectedTarget})`}
              </Text>
            </Pressable>

            {probeMutation.data?.reachable ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                🟢 {probeMutation.data.remoteHostname} ({probeMutation.data.remoteHome}) ·{" "}
                {probeMutation.data.remoteSessionCount} sessions · {probeMutation.data.latencyMs}ms
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Add Custom Host Row */}
        <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 8, marginTop: 4 }}>
          <TextInput
            value={newTarget}
            onChangeText={setNewTarget}
            placeholder="Add SSH target (e.g. user@10.0.0.1 or ssh-alias)"
            style={{
              flex: 2,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
              color: theme.colors.foreground,
              fontSize: 12,
            }}
          />
          <TextInput
            value={newLabel}
            onChangeText={setNewLabel}
            placeholder="Label (optional)"
            style={{
              flex: 1,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
              color: theme.colors.foreground,
              fontSize: 12,
            }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!newTarget.trim() || addHostMutation.isPending}
            onPress={() => addHostMutation.mutate()}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              + Add Host
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Teleport Action Controls */}
      <View
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 12,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>
          🔄 Bidirectional Workspace & Session Handoff
        </Text>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <Pressable
            accessibilityRole="checkbox"
            onPress={() => setIncludeCode((v) => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: includeCode ? theme.colors.accent : theme.colors.surface0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {includeCode ? (
                <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>✓</Text>
              ) : null}
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              Sync Workspace Code & Uncommitted Diffs (rsync)
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="checkbox"
            onPress={() => setIncludeSessions((v) => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: includeSessions ? theme.colors.accent : theme.colors.surface0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {includeSessions ? (
                <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>✓</Text>
              ) : null}
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              Sync Paseo Timeline & Native Agent Context (Codex / Claude)
            </Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            disabled={!selectedTarget || syncMutation.isPending}
            onPress={() => syncMutation.mutate("push")}
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: 10,
              backgroundColor: theme.colors.accent,
              alignItems: "center",
              opacity: !selectedTarget || syncMutation.isPending ? 0.6 : 1,
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontWeight: "700", fontSize: 14 }}>
              {syncMutation.isPending
                ? "Teleporting..."
                : `🚀 Push Local → Remote (${selectedTarget || "select host"})`}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={!selectedTarget || syncMutation.isPending}
            onPress={() => syncMutation.mutate("pull")}
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
              alignItems: "center",
              opacity: !selectedTarget || syncMutation.isPending ? 0.6 : 1,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 14 }}>
              {syncMutation.isPending
                ? "Pulling..."
                : `📥 Pull Remote (${selectedTarget || "select host"}) → Local`}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* History Log */}
      <View
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 8,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>
          📜 Recent Teleport Activity
        </Text>
        {(data?.history ?? []).length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            No teleport transfers recorded yet.
          </Text>
        ) : (
          (data?.history ?? []).map((entry) => (
            <View
              key={entry.id}
              style={{
                paddingVertical: 6,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border,
                gap: 2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {entry.direction === "push" ? "🚀 PUSH" : "📥 PULL"} · {entry.sshTarget} · {entry.scope}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {entry.message} · {new Date(entry.timestamp).toLocaleTimeString()}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}
