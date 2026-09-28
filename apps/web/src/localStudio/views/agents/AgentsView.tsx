import type {
  AgentDefault,
  AgentSession,
  AgentTestResult,
  AgentTestRun,
  Harness,
  HarnessInfo,
  HarnessJob,
} from "@local-studio/contracts/client";
import { fmt } from "@local-studio/contracts/client";
import { homeDir } from "@local-studio/local-ai-model";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Skeleton } from "../../../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { controllerFetch, controllerJson } from "../../state/controllerClient";
import { TextCell } from "../shared/TextCell";
import { useLocalAiEnvironmentId } from "../../state/environment";
import { useLocalAi } from "../../state/localAiStore";
import { EnableInT3 } from "./EnableInT3";

const LABEL: Record<Harness, string> = {
  dsh: "dsh",
  pi: "pi",
  omp: "omp",
  amp: "amp",
  hermes: "hermes",
  droid: "droid",
  codex: "Codex CLI",
  "codex-desktop": "Codex desktop",
  claude: "Claude Code CLI",
  "claude-desktop": "Claude Code desktop",
};

interface GatewayModelRow {
  readonly id: string;
  readonly local_studio?: { readonly state?: string };
}

const AGENTS_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 300_000;
const JOB_POLL_MS = 2_000;
const SESSION_POLL_MS = 5_000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const newer = (a: string | null, b: string | null): boolean => {
  if (!a || !b || a === b) return false;
  const parse = (value: string) => /^\d+\.\d+\.\d+/.exec(value)?.[0].split(".").map(Number) ?? [];
  const x = parse(a);
  const y = parse(b);
  for (let index = 0; index < 3; index++)
    if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0);
  return false;
};

const statusOf = (info: HarnessInfo): { text: string; tone: "muted" | "alert" | "strong" } => {
  if (info.blocked) return { text: info.blocked, tone: "muted" };
  if (info.job?.state === "running") return { text: `${info.job.action}ing…`, tone: "muted" };
  if (info.job?.state === "failed")
    return { text: `${info.job.action} failed: ${info.job.detail}`, tone: "alert" };
  if (!info.installed) return { text: "not installed", tone: "muted" };
  if (newer(info.latest, info.version)) return { text: "update available", tone: "strong" };
  return { text: info.managed ? "managed by Local Studio" : "", tone: "muted" };
};

function TestCell({
  result,
  running,
}: {
  readonly result: AgentTestResult | undefined;
  readonly running: boolean;
}) {
  if (!result) return <span className="text-muted-foreground">{running ? "running…" : "–"}</span>;
  const tone =
    result.status === "ok"
      ? "success"
      : result.status === "failed"
        ? "error"
        : ("secondary" as const);
  return (
    <span className="flex items-center gap-2">
      <Badge variant={tone}>{result.status === "skipped" ? "skipped" : result.status}</Badge>
      <span className="truncate text-xs text-muted-foreground">
        {result.reason ?? (result.ms ? `${(result.ms / 1000).toFixed(1)} s` : "")}
      </span>
    </span>
  );
}

export function AgentsView() {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const readOnly =
    store.model.fleet?.machines.find((machine) => machine.peerId === null)?.snapshot?.machine
      .readOnly ?? false;
  const [infos, setInfos] = useState<ReadonlyArray<HarnessInfo> | null>(null);
  const [sessions, setSessions] = useState<ReadonlyArray<AgentSession>>([]);
  const [models, setModels] = useState<ReadonlyArray<string>>([]);
  const [defaultHarness, setDefaultHarness] = useState<Harness | null>(null);
  const [testModel, setTestModel] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<Harness, AgentTestResult>>>({});
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInfos = useCallback(() => {
    if (environmentId === null) return;
    controllerFetch<HarnessInfo[]>(environmentId, "/api/agents", undefined, AGENTS_TIMEOUT_MS).then(
      (value) => setInfos(Array.isArray(value) ? value : []),
      (cause) => {
        setInfos((current) => current ?? []);
        setError(messageOf(cause));
      },
    );
  }, [environmentId]);

  const loadSessions = useCallback(() => {
    if (environmentId === null) return;
    controllerFetch<AgentSession[]>(environmentId, "/api/agents/sessions").then(
      (value) => setSessions(Array.isArray(value) ? value : []),
      () => undefined,
    );
    controllerFetch<{ data?: GatewayModelRow[] }>(environmentId, "/v1/models").then(
      (body) =>
        setModels(
          (Array.isArray(body?.data) ? body.data : [])
            .filter((model) => (model.local_studio?.state ?? "ready") === "ready")
            .map((model) => model.id),
        ),
      () => undefined,
    );
  }, [environmentId]);

  useEffect(() => {
    if (environmentId === null) return;
    loadInfos();
    loadSessions();
    controllerFetch<AgentDefault>(environmentId, "/api/agents/default").then(
      (value) => setDefaultHarness(value.harness),
      () => undefined,
    );
    const timer = setInterval(loadSessions, SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [environmentId, loadInfos, loadSessions]);

  const installing = (infos ?? []).some((info) => info.job?.state === "running");
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(loadInfos, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [installing, loadInfos]);

  if (environmentId === null) return null;

  const install = async (harness: Harness) => {
    setError(null);
    try {
      const job = await controllerFetch<HarnessJob>(
        environmentId,
        `/api/agents/${harness}/install`,
        controllerJson("POST"),
      );
      setInfos((current) =>
        (current ?? []).map((info) => (info.harness === harness ? { ...info, job } : info)),
      );
    } catch (cause) {
      setError(`${LABEL[harness]}: ${messageOf(cause)}`);
    }
  };

  const makeDefault = async (harness: Harness) => {
    setError(null);
    try {
      const value = await controllerFetch<AgentDefault>(
        environmentId,
        "/api/agents/default",
        controllerJson("PUT", { harness }),
      );
      setDefaultHarness(value.harness);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const model = testModel && models.includes(testModel) ? testModel : (models[0] ?? null);

  const testAll = async () => {
    if (!model) return;
    setTesting(true);
    setError(null);
    setTests({});
    try {
      const run = await controllerFetch<AgentTestRun>(
        environmentId,
        "/api/agents/test",
        controllerJson("POST", { model }),
        TEST_TIMEOUT_MS,
      );
      setTests(Object.fromEntries(run.results.map((result) => [result.harness, result])));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setTesting(false);
    }
  };

  const stopSession = async (id: string) => {
    try {
      await controllerFetch<unknown>(
        environmentId,
        `/api/agents/sessions/${encodeURIComponent(id)}`,
        controllerJson("DELETE"),
      );
    } catch (cause) {
      setError(messageOf(cause));
    }
    loadSessions();
  };

  return (
    <div className="flex flex-col gap-8" data-testid="local-ai-agents">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Agents in T3</h2>
          <p className="text-xs text-muted-foreground">
            pi and omp run as T3 providers against this controller's gateway, with their own home
            and key. Enabling one adds it to the provider list without a restart.
          </p>
        </div>
        <EnableInT3 environmentId={environmentId} harnesses={infos ?? []} />
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="me-auto">
            <h2 className="text-sm font-medium text-foreground">Harnesses</h2>
            <p className="text-xs text-muted-foreground">
              {infos
                ? `${infos.filter((info) => info.installed).length} of ${infos.length} installed · default ${defaultHarness ? LABEL[defaultHarness] : "–"}`
                : "Checking installed harnesses"}
            </p>
          </div>
          <Select
            value={model ?? ""}
            onValueChange={(value) => typeof value === "string" && setTestModel(value)}
            disabled={models.length === 0}
          >
            <SelectTrigger size="sm" className="w-56" aria-label="Test model">
              <SelectValue placeholder="No ready model" />
            </SelectTrigger>
            <SelectPopup>
              {models.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void testAll()}
            disabled={!model || testing || readOnly}
            data-testid="local-ai-test-all"
          >
            {testing ? "Testing…" : "Test all"}
          </Button>
        </div>
        {error ? (
          <p className="text-xs text-destructive-foreground" data-testid="local-ai-agents-error">
            {error}
          </p>
        ) : null}
        {infos === null ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Table data-testid="local-ai-harnesses">
            <TableHeader>
              <TableRow>
                <TableHead>Harness</TableHead>
                <TableHead>Installed</TableHead>
                <TableHead>Latest</TableHead>
                <TableHead>Test</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {infos.map((info) => {
                const status = statusOf(info);
                const canInstall =
                  info.package !== null &&
                  info.job?.state !== "running" &&
                  (!info.installed || newer(info.latest, info.version));
                const canDefault = info.installed && !info.blocked;
                return (
                  <TableRow
                    key={info.harness}
                    data-testid="local-ai-harness"
                    data-harness={info.harness}
                  >
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="text-foreground">{LABEL[info.harness]}</span>
                        {defaultHarness === info.harness ? (
                          <Badge variant="outline">default</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TextCell className="max-w-32 truncate text-muted-foreground">
                      {info.installed ? (info.version ?? "?") : "–"}
                    </TextCell>
                    <TextCell className="max-w-32 truncate text-muted-foreground">
                      {info.latest ?? "–"}
                    </TextCell>
                    <TableCell className="max-w-56">
                      <TestCell result={tests[info.harness]} running={testing && info.installed} />
                    </TableCell>
                    <TextCell
                      className={
                        status.tone === "alert"
                          ? "max-w-72 truncate text-destructive-foreground"
                          : status.tone === "strong"
                            ? "max-w-72 truncate text-foreground"
                            : "max-w-72 truncate text-muted-foreground"
                      }
                    >
                      {status.text}
                    </TextCell>
                    <TableCell className="text-right">
                      <span className="flex justify-end gap-1">
                        {canDefault && defaultHarness !== info.harness ? (
                          <Button
                            size="xs"
                            variant="ghost-muted"
                            onClick={() => void makeDefault(info.harness)}
                            disabled={readOnly}
                          >
                            Make default
                          </Button>
                        ) : null}
                        {canInstall ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => void install(info.harness)}
                            disabled={readOnly}
                          >
                            {info.installed ? "Update" : "Install"}
                          </Button>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Running sessions</h2>
          <p className="text-xs text-muted-foreground">
            Harness sessions this controller started outside T3.
          </p>
        </div>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No harness session is running.</p>
        ) : (
          <Table data-testid="local-ai-sessions">
            <TableHeader>
              <TableRow>
                <TableHead>Harness</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Folder</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>{LABEL[session.harness] ?? session.harness}</TableCell>
                  <TextCell className="max-w-48 truncate">{session.model || "–"}</TextCell>
                  <TextCell className="max-w-64 truncate text-muted-foreground">
                    {homeDir(session.dir)}
                  </TextCell>
                  <TextCell className="text-muted-foreground">
                    {session.startedAt ? fmt.ago(session.startedAt) : "–"}
                  </TextCell>
                  <TableCell className="text-right">
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      onClick={() => void stopSession(session.id)}
                      disabled={readOnly}
                    >
                      Stop
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
