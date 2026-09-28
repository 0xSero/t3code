import { useAtomValue } from "@effect/atom-react";
import type { HarnessInfo } from "@local-studio/contracts/client";
import {
  OMP_DRIVER_KIND,
  PI_DRIVER_KIND,
  type LocalStudioDriverKind,
} from "@local-studio/t3-providers";
import {
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../../hooks/useSettings";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../../state/server";
import { TextCell } from "../shared/TextCell";

const T3_AGENTS: ReadonlyArray<{
  readonly kind: LocalStudioDriverKind;
  readonly label: string;
  readonly harness: HarnessInfo["harness"];
}> = [
  { kind: PI_DRIVER_KIND, label: "pi", harness: "pi" },
  { kind: OMP_DRIVER_KIND, label: "omp", harness: "omp" },
];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function EnableInT3({
  environmentId,
  harnesses,
}: {
  readonly environmentId: EnvironmentId;
  readonly harnesses: ReadonlyArray<HarnessInfo>;
}) {
  const instances = useEnvironmentSettings(environmentId, (settings) => settings.providerInstances);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const [error, setError] = useState<string | null>(null);

  const enable = (kind: LocalStudioDriverKind, label: string) => {
    setError(null);
    const id = ProviderInstanceId.make(kind);
    const existing = instances?.[id];
    const next: ProviderInstanceConfig = existing
      ? { ...existing, enabled: true }
      : { driver: ProviderDriverKind.make(kind), displayName: label, enabled: true };
    try {
      updateSettings({ providerInstances: { ...instances, [id]: next } });
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="local-ai-enable-in-t3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>On this machine</TableHead>
            <TableHead>T3 provider</TableHead>
            <TableHead className="text-right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {T3_AGENTS.map((agent) => {
            const id = ProviderInstanceId.make(agent.kind);
            const configured = Object.entries(instances ?? {}).find(
              ([key, value]) => key === id || value.driver === agent.kind,
            );
            const enabled = configured !== undefined && configured[1].enabled !== false;
            const provider = providers.find(
              (item) => item.instanceId === (configured?.[0] ?? id) || item.driver === agent.kind,
            );
            const harness = harnesses.find((item) => item.harness === agent.harness);
            return (
              <TableRow
                key={agent.kind}
                data-testid="local-ai-t3-agent"
                data-kind={agent.kind}
                data-enabled={enabled ? "true" : "false"}
                data-listed={provider ? "true" : "false"}
              >
                <TextCell className="text-foreground">{agent.label}</TextCell>
                <TextCell className="text-muted-foreground">
                  {harness
                    ? harness.installed
                      ? (harness.version ?? "installed")
                      : "not installed"
                    : "–"}
                </TextCell>
                <TableCell>
                  {provider ? (
                    <span className="flex items-center gap-2">
                      <Badge variant={provider.enabled ? "success" : "secondary"}>
                        {provider.enabled ? "In the provider list" : "Listed, disabled"}
                      </Badge>
                      <span className="truncate text-xs text-muted-foreground">
                        {provider.status}
                      </span>
                    </span>
                  ) : enabled ? (
                    <Badge variant="warning">Enabled, waiting for the server</Badge>
                  ) : (
                    <Badge variant="outline">Off</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {enabled ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      render={
                        <Link
                          to="/settings/providers"
                          search={{ instanceId: ProviderInstanceId.make(configured?.[0] ?? id) }}
                        />
                      }
                    >
                      Settings
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      onClick={() => enable(agent.kind, agent.label)}
                      data-testid="local-ai-enable-agent"
                    >
                      Enable in T3
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}
