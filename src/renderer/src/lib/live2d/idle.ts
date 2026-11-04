import {
  LIVE2D_IDLE_GAZE_DRIFT_MAX_MS,
  LIVE2D_IDLE_GAZE_DRIFT_MIN_MS,
  LIVE2D_IDLE_GAZE_HOLD_MAX_MS,
  LIVE2D_IDLE_GAZE_HOLD_MIN_MS,
  LIVE2D_IDLE_GAZE_SACCADE_CHANCE,
  LIVE2D_IDLE_GAZE_SACCADE_MAX_MS,
  LIVE2D_IDLE_GAZE_SACCADE_MIN_MS,
  LIVE2D_IDLE_GAZE_X_LIMIT,
  LIVE2D_IDLE_GAZE_Y_MAX,
  LIVE2D_IDLE_GAZE_Y_MIN,
} from "@/content/live2d";

export type IdleGazePhase = "move" | "hold";

export type IdleGazeState = {
  phase: IdleGazePhase;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  moveStart: number;
  moveDuration: number;
  holdUntil: number;
};

export type IdleGazeStep = {
  state: IdleGazeState;
  x: number;
  y: number;
};

type Random = () => number;

function between(random: Random, min: number, max: number) {
  return min + random() * Math.max(0, max - min);
}

function smoothstep(value: number) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function randomTarget(random: Random) {
  return {
    x: between(random, -LIVE2D_IDLE_GAZE_X_LIMIT, LIVE2D_IDLE_GAZE_X_LIMIT),
    y: between(random, LIVE2D_IDLE_GAZE_Y_MIN, LIVE2D_IDLE_GAZE_Y_MAX),
  };
}

function createMove(
  now: number,
  fromX: number,
  fromY: number,
  random: Random,
  saccade: boolean,
): IdleGazeState {
  const target = randomTarget(random);
  const duration = saccade
    ? between(random, LIVE2D_IDLE_GAZE_SACCADE_MIN_MS, LIVE2D_IDLE_GAZE_SACCADE_MAX_MS)
    : between(random, LIVE2D_IDLE_GAZE_DRIFT_MIN_MS, LIVE2D_IDLE_GAZE_DRIFT_MAX_MS);

  return {
    phase: "move",
    fromX,
    fromY,
    toX: target.x,
    toY: target.y,
    moveStart: now,
    moveDuration: Math.max(1, duration),
    holdUntil: 0,
  };
}

export function createIdleGaze(
  now: number,
  fromX: number,
  fromY: number,
  random: Random = Math.random,
): IdleGazeStep {
  return {
    state: createMove(now, fromX, fromY, random, false),
    x: fromX,
    y: fromY,
  };
}

export function advanceIdleGaze(
  state: IdleGazeState,
  now: number,
  random: Random = Math.random,
): IdleGazeStep {
  if (state.phase === "move") {
    const progress = (now - state.moveStart) / state.moveDuration;
    if (progress >= 1) {
      return {
        state: {
          ...state,
          phase: "hold",
          holdUntil:
            now +
            between(
              random,
              LIVE2D_IDLE_GAZE_HOLD_MIN_MS,
              LIVE2D_IDLE_GAZE_HOLD_MAX_MS,
            ),
        },
        x: state.toX,
        y: state.toY,
      };
    }

    const eased = smoothstep(progress);
    return {
      state,
      x: state.fromX + (state.toX - state.fromX) * eased,
      y: state.fromY + (state.toY - state.fromY) * eased,
    };
  }

  if (now < state.holdUntil) {
    return { state, x: state.toX, y: state.toY };
  }

  const saccade = random() < LIVE2D_IDLE_GAZE_SACCADE_CHANCE;
  return {
    state: createMove(now, state.toX, state.toY, random, saccade),
    x: state.toX,
    y: state.toY,
  };
}
