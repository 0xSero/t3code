import type { ControllerEvent, FleetSnapshot, Snapshot } from "@local-studio/contracts/client";

export interface LocalAiState {
  readonly snapshot: Snapshot | null;
  readonly fleet: FleetSnapshot | null;
  readonly updatedAt: number | null;
}

export const initialLocalAiState: LocalAiState = {
  snapshot: null,
  fleet: null,
  updatedAt: null,
};

export const applySnapshot = (state: LocalAiState, snapshot: Snapshot): LocalAiState => ({
  ...state,
  snapshot,
  updatedAt: snapshot.at,
});

export const applyFleet = (state: LocalAiState, fleet: FleetSnapshot): LocalAiState => ({
  ...state,
  fleet,
  updatedAt: fleet.at,
});

export const onEvent = (state: LocalAiState, event: ControllerEvent): LocalAiState => {
  switch (event.type) {
    case "snapshot":
      return applySnapshot(state, event.data);
    case "fleet":
      return applyFleet(state, event.data);
    default:
      return state;
  }
};
