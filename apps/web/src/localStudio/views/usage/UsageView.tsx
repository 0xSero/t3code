import type {
  DailyRow,
  GpuSample,
  MetricsSummary,
  RequestRecord,
} from "@local-studio/contracts/client";
import { fmt, histPercentile } from "@local-studio/contracts/client";
import {
  allTokens,
  cacheHitShare,
  decodeByConcurrency,
  gpuEnergyKwh,
  hourBuckets,
  type MachineView,
  machines as machineViews,
  sumSummaries,
  USAGE_BREAKDOWNS,
  USAGE_WINDOWS,
  type UsageBreakdown,
  usageBreakdown,
  usageColumns,
  usageRange,
  type UsageWindow,
  via,
} from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Skeleton } from "../../../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { controllerFetch } from "../../state/controllerClient";
import { TextCell } from "../shared/TextCell";
import { useLocalAiEnvironmentId } from "../../state/environment";
import { type LocalAiStore, useLocalAi } from "../../state/localAiStore";
import { Meter } from "../machines/Meter";
import { TokenColumns } from "./TokenColumns";

type Scope = "self" | "fleet";

interface MachineUsage {
  readonly machine: MachineView;
  readonly summary: MetricsSummary | null;
  readonly daily: ReadonlyArray<DailyRow>;
  readonly gpus: ReadonlyArray<GpuSample> | null;
}

const REFRESH_MS = 30_000;
const REQUEST_ROWS = 40;

const WINDOW_LABEL: Record<UsageWindow, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: "All time",
};

const settle = async <T,>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise;
  } catch {
    return null;
  }
};

function useMachineUsage(
  environmentId: EnvironmentId | null,
  ms: ReadonlyArray<MachineView>,
  span: UsageWindow,
): ReadonlyArray<MachineUsage> | null {
  const [data, setData] = useState<ReadonlyArray<MachineUsage> | null>(null);
  const key = ms.map((machine) => `${machine.id}:${machine.peerId ?? ""}`).join(",");
  useEffect(() => {
    if (environmentId === null) return;
    let active = true;
    setData(null);
    const load = async () => {
      const range = usageRange(span);
      const out = await Promise.all(
        ms.map(async (machine): Promise<MachineUsage> => {
          const get = <T,>(path: string) =>
            settle(controllerFetch<T>(environmentId, via(machine.peerId, path)));
          const [summary, daily, gpus] = await Promise.all([
            get<MetricsSummary>(`/api/metrics/summary?window=${span}`),
            get<DailyRow[]>(
              `/api/usage/daily?from=${range.dailyFrom}&to=${range.dailyTo}&group=model,client`,
            ),
            range.gpuFrom === null
              ? Promise.resolve(null)
              : get<GpuSample[]>(`/api/metrics/gpus?from=${range.gpuFrom}`),
          ]);
          return {
            machine,
            summary: summary && typeof summary.requests === "number" ? summary : null,
            daily: Array.isArray(daily) ? daily : [],
            gpus: Array.isArray(gpus) ? gpus : null,
          };
        }),
      );
      if (active) setData(out);
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [environmentId, key, span]);
  return data;
}

function Figures({ items }: { readonly items: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <div
      className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-5"
      data-testid="local-ai-usage-totals"
    >
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-1" data-figure={item.label}>
          <span className="truncate text-xl font-semibold text-foreground tabular-nums">
            {item.value}
          </span>
          <span className="text-xs text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const requestsFor = (store: LocalAiStore, ms: ReadonlyArray<MachineView>): RequestRecord[] => {
  const ids = new Set(ms.map((machine) => machine.id));
  const self = ms.find((machine) => machine.self);
  const local = self
    ? store.model.requests.filter((row) => row.via !== "peer" && row.machineId === self.id)
    : [];
  const peers = ms.flatMap((machine) =>
    machine.peerId ? (store.stats[machine.id]?.requests ?? []) : [],
  );
  return [...local, ...peers]
    .filter((row) => ids.has(row.machineId))
    .toSorted((a, b) => b.tsStart - a.tsStart);
};

const time = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

export function UsageView() {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const fleet = store.model.fleet;
  const launches = store.model.launches;
  const [span, setSpan] = useState<UsageWindow>("24h");
  const [by, setBy] = useState<UsageBreakdown>("model");
  const [scope, setScope] = useState<Scope>("self");
  const online = useMemo(
    () => machineViews(fleet, launches).filter((machine) => machine.online),
    [fleet, launches],
  );
  const scoped = useMemo(
    () => (scope === "self" ? online.filter((machine) => machine.self) : online),
    [online, scope],
  );
  const data = useMachineUsage(environmentId, scoped, span);

  if (environmentId === null) return null;

  const summaries = (data ?? []).flatMap((entry) => (entry.summary ? [entry.summary] : []));
  const totals = sumSummaries(summaries);
  const tokens = allTokens(totals);
  const hit = cacheHitShare(totals);
  const energy =
    data === null || data.every((entry) => entry.gpus === null)
      ? null
      : data.reduce((total, entry) => total + (entry.gpus ? gpuEnergyKwh(entry.gpus) : 0), 0);
  const hourly = scoped.flatMap((machine) => store.stats[machine.id]?.hourly ?? []);
  const ttft = scoped.flatMap((machine) => store.stats[machine.id]?.ttft ?? []);
  const columns = usageColumns(
    span,
    (data ?? []).flatMap((entry) => entry.daily),
    hourly,
  );
  const breakdown = usageBreakdown(
    by,
    (data ?? []).flatMap((entry) =>
      entry.summary ? [{ machine: entry.machine.name, summary: entry.summary }] : [],
    ),
  );
  const requests = requestsFor(store, scoped);
  const concurrency = decodeByConcurrency(requests.filter((row) => row.via === "local"));
  const hours = hourBuckets([...hourly], [...ttft], Date.now());
  const hourP50 = hours.map((hour) => ({
    at: hour.at,
    p50: histPercentile(hour.hist, 0.5),
    count: hour.hist.reduce((total, n) => total + n, 0),
  }));
  const topTtft = Math.max(1, ...hourP50.map((hour) => hour.p50 ?? 0));
  const names = Object.fromEntries(online.map((machine) => [machine.id, machine.name]));

  return (
    <div className="flex flex-col gap-8" data-testid="local-ai-usage">
      <div className="flex flex-wrap items-center gap-3">
        <div className="me-auto">
          <h2 className="text-sm font-medium text-foreground">Usage</h2>
          <p className="text-xs text-muted-foreground">
            {scope === "self"
              ? `Requests recorded by this controller${scoped[0] ? ` (${scoped[0].name})` : ""}, including those it forwarded to peers.`
              : "Sum of every online machine's own records; a request forwarded to a peer counts on both."}
          </p>
        </div>
        <ToggleGroup
          aria-label="Usage scope"
          variant="segmented"
          value={[scope]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "self" || value === "fleet") setScope(value);
          }}
        >
          <Toggle value="self" data-testid="local-ai-usage-scope-self">
            This controller
          </Toggle>
          <Toggle value="fleet" data-testid="local-ai-usage-scope-fleet">
            All machines
          </Toggle>
        </ToggleGroup>
        <ToggleGroup
          aria-label="Usage window"
          variant="segmented"
          value={[span]}
          onValueChange={(next) => {
            const value = USAGE_WINDOWS.find((item) => item === next[0]);
            if (value) setSpan(value);
          }}
        >
          {USAGE_WINDOWS.map((item) => (
            <Toggle key={item} value={item} data-testid={`local-ai-usage-window-${item}`}>
              {WINDOW_LABEL[item]}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {data === null ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <Figures
          items={[
            { label: "requests", value: formatCount(totals.requests) },
            { label: "tokens", value: formatTokens(tokens) },
            { label: "errors", value: formatCount(totals.errors) },
            { label: "cache hit", value: hit === null ? "–" : formatPercent(hit) },
            { label: "GPU energy", value: energy === null ? "–" : `${energy.toFixed(1)} kWh` },
          ]}
        />
      )}
      <Section title="Tokens">
        <TokenColumns columns={columns} />
      </Section>
      <Section
        title="Breakdown"
        aside={
          <ToggleGroup
            aria-label="Break down by"
            variant="segmented"
            value={[by]}
            onValueChange={(next) => {
              const value = USAGE_BREAKDOWNS.find((item) => item === next[0]);
              if (value) setBy(value);
            }}
          >
            {USAGE_BREAKDOWNS.map((item) => (
              <Toggle key={item} value={item}>
                {item}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      >
        {breakdown.length === 0 ? (
          <p className="text-xs text-muted-foreground">No requests in this window.</p>
        ) : (
          <Table data-testid="local-ai-usage-breakdown">
            <TableHeader>
              <TableRow>
                <TableHead>
                  {by === "model" ? "Model" : by === "client" ? "Client" : "Machine"}
                </TableHead>
                <TableHead className="w-1/4">Share</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Decode</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.map((row) => (
                <TableRow key={row.key}>
                  <TextCell className="max-w-64 truncate text-foreground">{row.key}</TextCell>
                  <TableCell>
                    <Meter
                      pct={tokens ? (row.tokens / tokens) * 100 : 0}
                      label={`${row.key} share`}
                    />
                  </TableCell>
                  <TextCell className="tabular-nums" align="end">
                    {formatTokens(row.tokens)}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {formatCount(row.requests)}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {row.decodeTps === null ? "–" : `${fmt.tps(row.decodeTps)} tok/s`}
                  </TextCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <Section
        title="Time to first token"
        aside={
          <span className="text-xs text-muted-foreground">last 24 hours · median per hour</span>
        }
      >
        <div className="flex h-20 items-end gap-px" data-testid="local-ai-usage-ttft">
          {hourP50.map((hour) => (
            <Tooltip key={hour.at}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-0 flex-1 cursor-default flex-col-reverse rounded-sm hover:bg-muted/60">
                    <div
                      className="bg-info/60"
                      style={{ height: `${((hour.p50 ?? 0) / topTtft) * 100}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top">
                {`${String(new Date(hour.at).getHours()).padStart(2, "0")}:00 · ${hour.p50 === null ? "no requests" : `p50 ${fmt.ms(hour.p50)} over ${hour.count} requests`}`}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
        {(data ?? []).some((entry) => entry.summary && entry.summary.requests > 0) ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead className="text-right">p50</TableHead>
                <TableHead className="text-right">p90</TableHead>
                <TableHead className="text-right">p99</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? [])
                .filter((entry) => entry.summary && entry.summary.requests > 0)
                .map((entry) => (
                  <TableRow key={entry.machine.id}>
                    <TextCell className="text-foreground">{entry.machine.name}</TextCell>
                    <TextCell className="tabular-nums" align="end">
                      {fmt.ms(entry.summary?.ttftMs.p50)}
                    </TextCell>
                    <TextCell className="tabular-nums" align="end">
                      {fmt.ms(entry.summary?.ttftMs.p90)}
                    </TextCell>
                    <TextCell className="tabular-nums" align="end">
                      {fmt.ms(entry.summary?.ttftMs.p99)}
                    </TextCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        ) : null}
      </Section>
      {concurrency ? (
        <Section
          title="Decode by concurrency"
          aside={
            <span className="text-xs text-muted-foreground">{`${concurrency.model} · last ${concurrency.n} requests`}</span>
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>In flight</TableHead>
                <TableHead className="text-right">Per request</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Samples</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {concurrency.rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell>{row.label}</TableCell>
                  <TextCell className="tabular-nums" align="end">
                    {fmt.tps(row.perRequest)}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {fmt.tps(row.total)}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {row.samples}
                  </TextCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
      <Section
        title="Requests"
        aside={<span className="text-xs text-muted-foreground">newest first</span>}
      >
        {requests.length === 0 ? (
          <p className="text-xs text-muted-foreground">No requests recorded yet.</p>
        ) : (
          <Table data-testid="local-ai-usage-requests">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Model · client</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Cached</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">tok/s</TableHead>
                <TableHead className="text-right">TTFT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.slice(0, REQUEST_ROWS).map((row) => (
                <TableRow
                  key={row.id}
                  data-testid="local-ai-request"
                  data-fresh={store.fresh.has(row.id) ? "true" : "false"}
                >
                  <TextCell className="text-muted-foreground tabular-nums">
                    {time(row.tsStart)}
                  </TextCell>
                  <TextCell className="max-w-72 truncate">
                    <span className="text-foreground">{row.model}</span>
                    <span className="text-muted-foreground">
                      {` · ${row.client}${scope === "fleet" ? ` · ${names[row.machineId] ?? ""}` : ""}${row.via === "peer" ? " · via peer" : ""}`}
                    </span>
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {fmt.k(row.inputUncached)}
                  </TextCell>
                  <TextCell className="tabular-nums text-muted-foreground" align="end">
                    {row.cacheSource === null ? "–" : fmt.k(row.cacheRead)}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {row.errorCode ? (
                      <span className="text-destructive-foreground">{row.errorCode}</span>
                    ) : (
                      fmt.k(row.output)
                    )}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {fmt.tps(row.decodeTps)}
                  </TextCell>
                  <TextCell className="tabular-nums" align="end">
                    {fmt.ms(row.ttftMs)}
                  </TextCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
