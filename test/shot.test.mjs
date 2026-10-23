import { test } from "node:test";
import assert from "node:assert/strict";
import { LM } from "../posture.js";
import { ShotTracker, SHOT } from "../shot.js";

// A right-handed archer seen from the front: target to the right of the image (dir = +1), shoulder width 120 px.
function pose({ bowShoulderY = 400, anchorX = 492, anchorY = 338, drawElbowY = 405, bowWristY = 400, bowWristX = 800 } = {}) {
  const p = [];
  const set = (i, x, y) => { p[i] = { x, y, v: 1 }; };
  set(LM.nose, 500, 320); set(LM.mouthLeft, 510, 335); set(LM.mouthRight, 490, 335);
  set(LM.rightEar, 470, 318);                                         // draw-side ear
  set(LM.leftShoulder, 560, bowShoulderY); set(LM.rightShoulder, 440, 400);
  set(LM.leftElbow, (560 + bowWristX) / 2, (bowShoulderY + bowWristY) / 2); set(LM.leftWrist, bowWristX, bowWristY);
  set(LM.rightElbow, 330, drawElbowY); set(LM.rightIndex, anchorX, anchorY); set(LM.rightWrist, anchorX - 22, anchorY + 22);
  set(LM.leftHip, 520, 640); set(LM.rightHip, 480, 640);
  set(LM.leftAnkle, 580, 900); set(LM.rightAnkle, 420, 900);
  return p;
}

const SETUP = { anchorX: 700, anchorY: 400 };         // bow arm up, draw hand still out by the bow
const ANCHOR = { anchorX: 492, anchorY: 338 };        // index finger at the mouth corner

/** Plays segments of [ms, fromParams, toParams] at 30 fps, linearly interpolated; returns the tracker's shots. */
function play(segments, wobble = () => ({})) {
  const t = new ShotTracker({ hand: "right" });
  const shots = [];
  let now = 0;
  for (const [ms, from, to = from] of segments) {
    const frames = Math.max(1, Math.round(ms / 33));
    for (let f = 0; f < frames; f++) {
      const k = frames === 1 ? 1 : f / (frames - 1);
      const params = {};
      for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
        const a = from[key] ?? to[key], b = to[key] ?? from[key];
        params[key] = a + (b - a) * k;
      }
      Object.assign(params, wobble(now));
      for (const e of t.push(now, pose(params))) if (e.type === "shot") shots.push(e.shot);
      now += 33;
    }
  }
  return shots;
}

const back = (dx, extra = {}) => ({ ...ANCHOR, anchorX: ANCHOR.anchorX - dx, ...extra });   // hand slides away from the target

function cleanShot({ hold = 2500, draw = {}, holdTo = ANCHOR, release = back(60), after = back(70) } = {}) {
  return [
    [300, SETUP],
    [1000, { ...SETUP, ...draw.from }, { ...ANCHOR, ...draw.to }],
    [hold, ANCHOR, holdTo],
    [66, holdTo, release],
    [1500, after],
  ];
}

test("a clean shot: held long enough, hand slides back, bow arm stays up", () => {
  const shots = play(cleanShot());
  assert.equal(shots.length, 1);
  const s = shots[0];
  assert.ok(Math.abs(s.holdMs - 2500) < 150, `hold ${s.holdMs}`);
  assert.ok(s.handBack > 0.4, `hand back ${s.handBack}`);
  assert.ok(s.behindEar > 0.3, `behind ear ${s.behindEar}`);
  assert.deepEqual(s.issues, []);
});

test("the bow shoulder rising while drawing is caught", () => {
  const shots = play(cleanShot({ draw: { from: { bowShoulderY: 400 }, to: { bowShoulderY: 384 } } }).map((seg, i) =>
    i >= 2 ? seg.map((x) => (typeof x === "object" ? { ...x, bowShoulderY: 384 } : x)) : seg));
  assert.ok(shots[0].issues.some((i) => i.id === "shoulderRiseDraw"));
});

test("creeping forward during the hold is caught", () => {
  const shots = play(cleanShot({ holdTo: { ...ANCHOR, anchorX: ANCHOR.anchorX + 14 } }));
  assert.ok(shots[0].creep > SHOT.creepMax);
  assert.ok(shots[0].issues.some((i) => i.id === "creep"));
});

test("a short hold is caught", () => {
  const shots = play(cleanShot({ hold: 800 }));
  assert.ok(shots[0].issues.some((i) => i.id === "holdShort"));
});

test("a dead release (hand barely moves back) is caught", () => {
  const shots = play(cleanShot({ release: back(18), after: back(20) }));
  assert.equal(shots.length, 1);
  assert.equal(shots[0].issues[0].id, "deadRelease");
  assert.equal(shots[0].issues[0].say, "Nhả dây cho tay phải trượt ra sau tai");
  assert.ok(shots[0].behindEar < 0);
});

test("the bow arm dropping right after the release is caught", () => {
  const shots = play(cleanShot({ release: back(60), after: back(70, { bowWristY: 450 }) }));
  assert.ok(shots[0].issues.some((i) => i.id === "bowDrop"));
});

test("a shaking hold is caught", () => {
  const shake = (t) => (t > 1300 && t < 3800 ? { bowWristY: 400 + 9 * Math.sin((2 * Math.PI * 8 * t) / 1000) } : {});
  const shots = play(cleanShot(), shake);
  assert.ok(shots[0].tremor > SHOT.tremorMax, `tremor ${shots[0].tremor}`);
  assert.ok(shots[0].issues.some((i) => i.id === "tremor"));
});

test("letting down slowly is not a shot", () => {
  const shots = play([[300, SETUP], [1000, SETUP, ANCHOR], [1500, ANCHOR], [1500, ANCHOR, SETUP], [600, SETUP]]);
  assert.equal(shots.length, 0);
});

test("the shot keeps its frames around the release for the replay", () => {
  const s = play(cleanShot())[0];
  assert.ok(s.frames.length > 40);
  assert.ok(s.frames.some((f) => f.t < s.releaseT) && s.frames.some((f) => f.t > s.releaseT));
});

test("pausing on the way in and then finishing the draw is not a release", () => {
  // The hand slows to a stop well short of the mouth (about 0.6 shoulder widths away), then finishes the draw.
  const midway = { anchorX: 560, anchorY: 360 };
  const shots = play([
    [300, SETUP], [600, SETUP, midway], [400, midway], [400, midway, ANCHOR],
    [2000, ANCHOR], [66, ANCHOR, back(60)], [1500, back(70)],
  ]);
  assert.equal(shots.length, 1);
  assert.ok(Math.abs(shots[0].holdMs - 2000) < 200, `hold ${shots[0].holdMs}`);
});

test("a one-frame jump of the finger landmark at the face is not a release", () => {
  let n = 0;
  const glitch = (t) => (t > 2400 && t < 2440 && n++ < 1 ? { anchorX: ANCHOR.anchorX - 30, anchorY: ANCHOR.anchorY + 10 } : {});
  const shots = play(cleanShot(), glitch);
  assert.equal(shots.length, 1);
  assert.ok(Math.abs(shots[0].holdMs - 2500) < 150, `hold ${shots[0].holdMs}`);
});
