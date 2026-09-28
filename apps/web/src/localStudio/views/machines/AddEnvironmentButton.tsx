import type { T3Pairing, T3Status } from "@local-studio/contracts/client";
import { type MachineView, via } from "@local-studio/local-ai-model";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { toastManager } from "../../../components/ui/toast";
import { connectPairing } from "../../../connection/onboarding";
import { useAtomCommand } from "../../../state/use-atom-command";
import { controllerFetch, controllerJson } from "../../state/controllerClient";

const PAIR_TIMEOUT_MS = 90_000;

const ensureT3Running = async (environmentId: EnvironmentId, machine: MachineView) => {
  const status = await controllerFetch<T3Status>(environmentId, via(machine.peerId, "/api/t3"));
  if (status.state === "running") return;
  if (status.state === "unavailable") {
    throw new Error(status.error ?? `${machine.name} has no T3 CLI installed for its controller.`);
  }
  const started = await controllerFetch<T3Status>(
    environmentId,
    via(machine.peerId, "/api/t3/start"),
    controllerJson("POST", {}),
    PAIR_TIMEOUT_MS,
  );
  if (started.state !== "running") {
    throw new Error(started.error ?? `T3 on ${machine.name} did not start (${started.state}).`);
  }
};

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : "The machine could not be added.";

export function AddEnvironmentButton({
  environmentId,
  machine,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine: MachineView;
}) {
  const [busy, setBusy] = useState(false);
  const register = useAtomCommand(connectPairing, { reportFailure: false });

  const add = async () => {
    setBusy(true);
    try {
      await ensureT3Running(environmentId, machine);
      const pairing = await controllerFetch<T3Pairing>(
        environmentId,
        via(machine.peerId, "/api/t3/pair"),
        controllerJson("POST", { label: `Local Studio ${machine.name}` }),
        PAIR_TIMEOUT_MS,
      );
      if (pairing.loopbackOnly && !machine.self) {
        throw new Error(
          `${machine.name} serves T3 on loopback only, so it cannot be reached from here.`,
        );
      }
      const result = await register({ pairingUrl: pairing.pairUrl });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `Added ${machine.name}`,
        description: "The machine is saved as a T3 environment and reconnects on startup.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not add ${machine.name}`,
        description: failureText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={busy || !machine.online || machine.readOnly}
      onClick={() => void add()}
      data-testid="local-ai-add-environment"
    >
      {busy ? <Spinner className="size-3" /> : null}
      Add as T3 environment
    </Button>
  );
}
