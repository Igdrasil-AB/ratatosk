import type {
  ReplayPhase,
  ReplayPhaseAttempt,
  ReplayPhaseResult,
  ReplayPlanKind,
  ReplayTrace,
} from "./types";

export function emptyReplayTrace(planKind: ReplayPlanKind): ReplayTrace {
  return { planKind, phases: [] };
}

export function replayFailureTrace(
  planKind: ReplayPlanKind,
  phase: ReplayPhase,
  result: ReplayPhaseResult,
): ReplayTrace {
  return replayTraceWithPhase(emptyReplayTrace(planKind), phase, result);
}

export function replayTraceWithPlanKind(replay: ReplayTrace, planKind: ReplayPlanKind): ReplayTrace {
  return { ...replay, planKind };
}

export function replayTraceWithPhase(
  replay: ReplayTrace,
  phase: ReplayPhase,
  result: ReplayPhaseResult,
  durationMs = 0,
): ReplayTrace {
  const attempt = { phase, result, durationMs: Math.max(0, Math.min(60_000, durationMs)) };
  const existing = replay.phases.findIndex((item) => item.phase === phase);
  const phases = [...replay.phases];
  if (existing >= 0) phases[existing] = attempt;
  else phases.push(attempt);
  return withFirstFailure({ ...replay, phases });
}

export function replayTraceWithComplete(replay: ReplayTrace, phase: ReplayPhase): ReplayTrace {
  return replayTraceWithPhase(replay, phase, "complete");
}

export function replayTraceWithPrefix(
  replay: ReplayTrace,
  prefix: readonly ReplayPhaseAttempt[],
): ReplayTrace {
  const phases = [...prefix, ...replay.phases.filter((item) =>
    !prefix.some((prefixItem) => prefixItem.phase === item.phase))];
  return withFirstFailure({ ...replay, phases });
}

function withFirstFailure(replay: ReplayTrace): ReplayTrace {
  const firstFailure = replay.phases.find((item) => item.result !== "complete");
  return {
    ...replay,
    ...(firstFailure
      ? { firstFailure: { phase: firstFailure.phase, result: firstFailure.result } }
      : { firstFailure: undefined }),
  };
}
