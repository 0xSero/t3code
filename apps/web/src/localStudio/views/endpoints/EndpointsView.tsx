import {
  endpointUrl,
  gatewayUrlOf,
  isLoopbackBind,
  type MachineView,
  machines as machineViews,
  podWorker,
  rewriteLoopback,
} from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { controllerFetch } from "../../state/controllerClient";
import { TextCell } from "../shared/TextCell";
import { useLocalAiEnvironmentId } from "../../state/environment";
import { useLocalAi } from "../../state/localAiStore";

interface GatewayModelRow {
  readonly id: string;
  readonly owned_by?: string;
  readonly context_length?: number | null;
  readonly local_studio?: { readonly state?: string; readonly machineId?: string };
}

const MODELS_POLL_MS = 15_000;

function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: label });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Copy ${label}`}
            onClick={() => copyToClipboard(value, undefined)}
            data-testid="local-ai-copy"
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{isCopied ? "Copied" : `Copy ${label}`}</TooltipPopup>
    </Tooltip>
  );
}

function UrlLine({ url, label }: { readonly url: string; readonly label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code
        className="min-w-0 truncate font-mono text-xs text-foreground"
        data-testid="local-ai-endpoint-url"
      >
        {url}
      </code>
      <CopyButton value={url} label={label} />
    </span>
  );
}

function useGatewayModels(environmentId: EnvironmentId | null) {
  const [models, setModels] = useState<ReadonlyArray<GatewayModelRow> | null>(null);
  useEffect(() => {
    if (environmentId === null) return;
    let active = true;
    const load = () =>
      controllerFetch<{ data?: GatewayModelRow[] }>(environmentId, "/v1/models").then(
        (body) => {
          if (active) setModels(Array.isArray(body?.data) ? body.data : []);
        },
        () => {
          if (active) setModels((current) => current ?? []);
        },
      );
    void load();
    const timer = setInterval(() => void load(), MODELS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [environmentId]);
  return models;
}

function GatewayRow({
  machine,
  ready,
}: {
  readonly machine: MachineView;
  readonly ready: ReadonlyArray<GatewayModelRow>;
}) {
  const url = gatewayUrlOf(machine);
  return (
    <TableRow data-testid="local-ai-gateway" data-machine={machine.name}>
      <TableCell className="align-top">
        <span className="flex items-center gap-2">
          <span className="text-foreground">{machine.name}</span>
          {machine.self ? <Badge variant="outline">This controller</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="align-top">
        {url ? (
          <UrlLine url={url} label="gateway URL" />
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TextCell className="text-muted-foreground">
        {ready.length ? ready.map((model) => model.id).join(", ") : "–"}
      </TextCell>
    </TableRow>
  );
}

export function EndpointsView() {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const fleet = store.model.fleet;
  const launches = store.model.launches;
  const models = useGatewayModels(environmentId);
  const ms = useMemo(
    () =>
      machineViews(fleet, launches)
        .filter((machine) => machine.online && machine.snap)
        .toSorted((a, b) => (a.self === b.self ? a.name.localeCompare(b.name) : a.self ? -1 : 1)),
    [fleet, launches],
  );

  if (environmentId === null) return null;

  const ready = (models ?? []).filter(
    (model) => (model.local_studio?.state ?? "ready") === "ready",
  );
  const readyOn = (machine: MachineView) =>
    ready.filter((model) =>
      model.local_studio?.machineId
        ? model.local_studio.machineId === machine.id
        : model.owned_by === machine.name,
    );

  const served = ms.flatMap((machine) =>
    (machine.snap?.models ?? [])
      .filter((model) => !podWorker(model))
      .map((model) => ({
        machine,
        model,
        url: rewriteLoopback(model.baseUrl, machine.snap?.machine.hostname),
      })),
  );

  return (
    <div className="flex flex-col gap-8" data-testid="local-ai-endpoints">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Gateway</h2>
          <p className="text-xs text-muted-foreground">
            One OpenAI, Responses and Anthropic compatible base URL per machine. Clients need a key
            from that controller; loopback hosts are shown as each machine's tailnet name.
          </p>
        </div>
        {fleet ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Ready models</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ms.map((machine) => (
                <GatewayRow key={machine.id} machine={machine} ready={readyOn(machine)} />
              ))}
            </TableBody>
          </Table>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
        {models !== null ? (
          <p className="text-xs text-muted-foreground" data-testid="local-ai-gateway-models">
            {ready.length
              ? `This controller's /v1/models lists ${ready.length} ready: ${ready.map((model) => model.id).join(", ")}`
              : "No model is ready behind this controller's gateway."}
          </p>
        ) : null}
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Engines</h2>
          <p className="text-xs text-muted-foreground">
            Direct engine URLs, bypassing the gateway. They skip usage tracking and keys.
          </p>
        </div>
        {served.length === 0 ? (
          <p className="text-xs text-muted-foreground">No engine is running.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>URL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {served.map(({ machine, model, url }) => (
                <TableRow key={`${machine.id}/${model.id}`} data-testid="local-ai-engine-endpoint">
                  <TextCell className="text-foreground">{model.primaryModel || model.id}</TextCell>
                  <TableCell>{machine.name}</TableCell>
                  <TextCell className="text-muted-foreground">
                    {`${model.modality ?? (model.embedding ? "embedding" : "chat")} · ${model.engine}`}
                  </TextCell>
                  <TableCell>
                    <UrlLine url={url} label="engine URL" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Listening HTTP ports</h2>
          <p className="text-xs text-muted-foreground">
            What each controller found listening on its machine.
          </p>
        </div>
        {ms.map((machine) => {
          const endpoints = machine.snap?.endpoints ?? [];
          if (endpoints.length === 0) return null;
          const host = machine.snap?.machine.hostname;
          return (
            <div key={machine.id} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-foreground">{machine.name}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Port</TableHead>
                    <TableHead>Process</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>URL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {endpoints.map((endpoint) => (
                    <TableRow key={`${endpoint.bind}:${endpoint.port}`} data-testid="local-ai-port">
                      <TextCell className="tabular-nums">{endpoint.port}</TextCell>
                      <TextCell className="text-muted-foreground">
                        {endpoint.process ?? "–"}
                      </TextCell>
                      <TextCell className="text-muted-foreground">
                        {endpoint.kind}
                        {endpoint.note ? ` · ${endpoint.note}` : ""}
                      </TextCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <UrlLine
                            url={endpointUrl(endpoint.bind, endpoint.port, host)}
                            label="URL"
                          />
                          {isLoopbackBind(endpoint.bind) ? (
                            <Badge variant="outline">this machine only</Badge>
                          ) : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          );
        })}
      </section>
    </div>
  );
}
