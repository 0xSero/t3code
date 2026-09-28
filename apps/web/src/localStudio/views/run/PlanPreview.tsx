import type { LaunchPreview } from "@local-studio/contracts/client";
import { via } from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Skeleton } from "../../../components/ui/skeleton";
import { controllerFetch } from "../../state/controllerClient";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function PlanPreview({
  environmentId,
  peerId,
  recipeId,
  gpuKeys,
}: {
  readonly environmentId: EnvironmentId;
  readonly peerId: string | null;
  readonly recipeId: string;
  readonly gpuKeys: ReadonlyArray<string>;
}) {
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = gpuKeys.join(",");

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    const query = keys ? `?gpuKeys=${encodeURIComponent(keys)}` : "";
    controllerFetch<LaunchPreview>(
      environmentId,
      via(peerId, `/api/recipes/${encodeURIComponent(recipeId)}/plan${query}`),
    ).then(
      (value) => {
        if (active) setPreview(value);
      },
      (cause) => {
        if (active) setError(messageOf(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, peerId, recipeId, keys]);

  if (error) return <p className="text-xs text-destructive-foreground">{error}</p>;
  if (!preview) return <Skeleton className="h-16 w-full" />;
  const plan = preview.plan;
  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Container", plan.containerName],
    ["GPUs", plan.gpuKeys.join(", ") || "–"],
    ["Port", `127.0.0.1:${plan.hostPort} → ${plan.containerPort}`],
    ...preview.weights.map(
      (weights) =>
        [
          "Weights",
          `${weights.repository} · ${weights.present ? "present" : (weights.hint ?? "missing")}`,
        ] as const,
    ),
    ...(plan.downloads ?? []).map(
      (download) =>
        [
          "Download",
          `${download.repository}${download.bytes ? ` · ${Math.round(download.bytes / 1e9)} GB` : ""}`,
        ] as const,
    ),
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="local-ai-plan-preview">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {facts.map(([label, value], index) => (
          <div key={`${label}-${index}`} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-all text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {preview.warnings.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-warning-foreground">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-2xs leading-4 whitespace-pre-wrap break-all text-muted-foreground">
        {preview.dockerArgv.join(" ")}
      </pre>
    </div>
  );
}
