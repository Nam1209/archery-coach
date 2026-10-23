import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, LM, Speaker, equipmentFromSpan, jointAngle } from "../posture.js";

// A right-handed archer at full draw, seen from the front (raw camera image: the archer's left is on the right).
function goodFullDraw() {
  const p = [];
  const set = (i, x, y) => { p[i] = { x, y, v: 1 }; };
  set(LM.nose, 500, 320); set(LM.mouthLeft, 510, 335); set(LM.mouthRight, 490, 335);
  set(LM.leftShoulder, 560, 400); set(LM.rightShoulder, 440, 400);   // shoulder width 120
  set(LM.leftElbow, 680, 400); set(LM.leftWrist, 800, 400);           // bow arm straight and level
  set(LM.rightElbow, 330, 405); set(LM.rightWrist, 505, 345);         // draw elbow at shoulder height, hand at the chin
  set(LM.leftHip, 520, 640); set(LM.rightHip, 480, 640);
  set(LM.leftAnkle, 580, 900); set(LM.rightAnkle, 420, 900);          // feet a bit wider than the shoulders
  return p;
}

test("good form at full draw has nothing to correct", () => {
  const r = analyze(goodFullDraw());
  assert.equal(r.phase, "fullDraw");
  assert.deepEqual(r.issues, []);
  assert.ok(r.metrics.bowElbow > 179);
});

test("a bent bow arm is the first thing said", () => {
  const p = goodFullDraw();
  p[LM.leftElbow] = { x: 680, y: 440, v: 1 };
  const r = analyze(p);
  assert.equal(r.phase, "fullDraw");
  assert.equal(r.issues[0].id, "bowArmBent");
  assert.equal(r.issues[0].say, "Duỗi thẳng tay trái");
});

test("a raised bow shoulder says which shoulder to lower", () => {
  const p = goodFullDraw();
  p[LM.leftShoulder] = { x: 560, y: 380, v: 1 };
  const r = analyze(p);
  assert.ok(r.issues.some((i) => i.id === "shoulderUp" && i.say === "Hạ vai trái xuống"));
});

test("a dropped draw elbow and a hand away from the face are both found", () => {
  const p = goodFullDraw();
  p[LM.rightElbow] = { x: 340, y: 460, v: 1 };
  p[LM.rightWrist] = { x: 440, y: 360, v: 1 };
  const ids = analyze(p).issues.map((i) => i.id);
  assert.ok(ids.includes("drawElbowLow"));
  assert.ok(ids.includes("anchorFar"));
});

test("a left-handed archer holds the bow in the right hand", () => {
  // Mirror the right-handed pose: swap left/right landmarks.
  const p = goodFullDraw();
  const swap = (a, b) => { [p[a], p[b]] = [p[b], p[a]]; };
  swap(LM.leftShoulder, LM.rightShoulder); swap(LM.leftElbow, LM.rightElbow); swap(LM.leftWrist, LM.rightWrist);
  p[LM.rightElbow] = { x: 680, y: 440, v: 1 };   // now the bow arm, bent
  const r = analyze(p, { hand: "left" });
  assert.equal(r.phase, "fullDraw");
  assert.equal(r.issues[0].say, "Duỗi thẳng tay phải");
});

test("arms down is not full draw, and hidden joints say so", () => {
  const p = goodFullDraw();
  p[LM.leftElbow] = { x: 570, y: 520, v: 1 }; p[LM.leftWrist] = { x: 575, y: 630, v: 1 };
  assert.equal(analyze(p).phase, "other");
  p[LM.leftWrist] = { x: 575, y: 630, v: 0.1 };
  assert.equal(analyze(p).phase, "notVisible");
});

test("the speaker waits for a problem to last, then speaks one cue at a time", () => {
  const s = new Speaker({ holdMs: 600, gapMs: 3000, repeatMs: 6000 });
  const bent = [{ id: "bowArmBent", severity: 1, say: "x" }];
  assert.equal(s.next(bent, 0), null);              // just appeared
  assert.equal(s.next(bent, 700)?.id, "bowArmBent"); // lasted 0.7 s
  assert.equal(s.next(bent, 1500), null);           // too soon after the last cue
  assert.equal(s.next(bent, 4000), null);           // same cue within 6 s
  assert.equal(s.next(bent, 6800)?.id, "bowArmBent");
});

test("equipment hint from arm span", () => {
  const e = equipmentFromSpan(175);
  assert.ok(Math.abs(e.drawIn - 27.56) < 0.01);
  assert.equal(e.bowIn, 68);
});

test("joint angle", () => {
  assert.ok(Math.abs(jointAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }) - 90) < 1e-9);
});
