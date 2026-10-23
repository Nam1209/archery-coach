// Barebow form checks from MediaPipe pose landmarks, seen by a camera in front of the archer.
// Pure functions: points in pixels (x right, y down), so the checks can be tested without a camera.

// MediaPipe Pose landmark indices (left/right are the archer's own sides).
export const LM = {
  nose: 0, mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftAnkle: 27, rightAnkle: 28,
};

// Tolerances. Angles in degrees; distances as a share of shoulder width so they work at any camera distance.
export const LIMITS = {
  bowElbowMin: 165,        // bow arm straight (180 = fully straight)
  shoulderTiltMax: 6,      // line between the shoulders vs horizontal
  bowArmTiltMax: 12,       // shoulder → bow hand vs horizontal
  drawElbowDropMax: 0.15,  // draw elbow below the draw shoulder
  anchorMax: 0.45,         // draw hand to the mouth
  torsoLeanMax: 8,         // hips → shoulders vs vertical
  stanceMin: 0.8, stanceMax: 1.7, // ankle gap
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const deg = (r) => (r * 180) / Math.PI;

/** Angle at b (degrees) between b→a and b→c. */
export function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}

/** Angle of a→b against the horizontal, 0…90 degrees. */
export function tiltFromHorizontal(a, b) {
  return deg(Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)));
}

/** Which arm holds the bow: a right-handed archer draws with the right hand, so the bow is in the left. */
export function sides(hand) {
  const right = hand !== "left";
  return {
    bow: right ? "left" : "right", draw: right ? "right" : "left",
    bowWord: right ? "trái" : "phải", drawWord: right ? "phải" : "trái",
  };
}

function part(points, side, name) {
  return points[LM[side + name[0].toUpperCase() + name.slice(1)]];
}

/**
 * Reads one frame. `points` is the landmark array in pixels ({x, y, v} with v = visibility 0…1).
 * Returns the phase ("fullDraw" when the bow arm is out and the draw hand is at the face), the measured values,
 * and the problems at full draw, most serious first, each with a short Vietnamese cue to speak.
 */
export function analyze(points, { hand = "right" } = {}) {
  const s = sides(hand);
  const need = [LM.leftShoulder, LM.rightShoulder, LM.leftElbow, LM.rightElbow, LM.leftWrist, LM.rightWrist];
  if (!points || need.some((i) => !points[i] || (points[i].v ?? 1) < 0.5)) {
    return { phase: "notVisible", metrics: {}, issues: [] };
  }
  const bowShoulder = part(points, s.bow, "shoulder"), bowElbow = part(points, s.bow, "elbow"), bowWrist = part(points, s.bow, "wrist");
  const drawShoulder = part(points, s.draw, "shoulder"), drawElbow = part(points, s.draw, "elbow"), drawWrist = part(points, s.draw, "wrist");
  const sw = dist(points[LM.leftShoulder], points[LM.rightShoulder]) || 1;
  const mouth = mid(points[LM.mouthLeft] ?? points[LM.nose], points[LM.mouthRight] ?? points[LM.nose]);

  const metrics = {
    bowElbow: jointAngle(bowShoulder, bowElbow, bowWrist),
    shoulderTilt: tiltFromHorizontal(points[LM.leftShoulder], points[LM.rightShoulder]),
    bowShoulderHigher: bowShoulder.y < drawShoulder.y,
    bowArmTilt: tiltFromHorizontal(bowShoulder, bowWrist),
    bowHandHigh: bowWrist.y < bowShoulder.y,
    drawElbowDrop: (drawElbow.y - drawShoulder.y) / sw,
    anchor: dist(drawWrist, mouth) / sw,
  };
  const hips = [points[LM.leftHip], points[LM.rightHip]];
  if (hips.every((h) => h && (h.v ?? 1) >= 0.5)) {
    const sm = mid(points[LM.leftShoulder], points[LM.rightShoulder]), hm = mid(hips[0], hips[1]);
    metrics.torsoLean = deg(Math.atan2(Math.abs(sm.x - hm.x), Math.abs(hm.y - sm.y) || 1));
  }
  const ankles = [points[LM.leftAnkle], points[LM.rightAnkle]];
  if (ankles.every((a) => a && (a.v ?? 1) >= 0.5)) metrics.stance = Math.abs(ankles[0].x - ankles[1].x) / sw;

  // Bow arm raised toward the target: straight-ish, away from the body and near horizontal (a hanging arm is straight too).
  const armOut = metrics.bowElbow > 140 && dist(bowShoulder, bowWrist) > 1.2 * sw && metrics.bowArmTilt < 35;
  const atFace = metrics.anchor < 0.9;
  const phase = armOut && atFace ? "fullDraw" : "other";
  if (phase !== "fullDraw") return { phase, metrics, issues: [] };

  const issues = [];
  const add = (id, over, say) => { if (over > 0) issues.push({ id, severity: over, say }); };
  add("bowArmBent", (LIMITS.bowElbowMin - metrics.bowElbow) / 15, `Duỗi thẳng tay ${s.bowWord}`);
  add("shoulderUp", metrics.bowShoulderHigher ? (metrics.shoulderTilt - LIMITS.shoulderTiltMax) / 6 : 0, `Hạ vai ${s.bowWord} xuống`);
  add("shoulderTilt", metrics.bowShoulderHigher ? 0 : (metrics.shoulderTilt - LIMITS.shoulderTiltMax) / 6, "Giữ hai vai ngang");
  add(metrics.bowHandHigh ? "bowArmHigh" : "bowArmLow", (metrics.bowArmTilt - LIMITS.bowArmTiltMax) / 10,
    metrics.bowHandHigh ? "Hạ tay cầm cung xuống ngang vai" : "Nâng tay cầm cung lên ngang vai");
  add("drawElbowLow", (metrics.drawElbowDrop - LIMITS.drawElbowDropMax) / 0.15, `Nâng khuỷu tay ${s.drawWord} lên ngang vai`);
  add("anchorFar", (metrics.anchor - LIMITS.anchorMax) / 0.2, "Kéo dây về sát cằm");
  if (metrics.torsoLean !== undefined) add("torsoLean", (metrics.torsoLean - LIMITS.torsoLeanMax) / 6, "Đứng thẳng người");
  if (metrics.stance !== undefined) {
    add("stanceNarrow", (LIMITS.stanceMin - metrics.stance) / 0.3, "Mở hai chân rộng bằng vai");
    add("stanceWide", (metrics.stance - LIMITS.stanceMax) / 0.3, "Khép hai chân lại bằng vai");
  }
  issues.sort((a, b) => b.severity - a.severity);
  return { phase, metrics, issues };
}

/**
 * Draw length from arm span (the common rule: span in inches ÷ 2.5), and the bow length usually suggested for it.
 * A starting point to check with a coach or archery shop, not a fitting.
 */
export function equipmentFromSpan(spanCm) {
  const drawIn = spanCm / 2.54 / 2.5;
  const bowIn = drawIn < 20 ? 54 : drawIn < 22 ? 58 : drawIn < 24 ? 62 : drawIn < 26 ? 66 : drawIn < 28 ? 68 : drawIn < 30 ? 70 : 72;
  return { drawIn, drawCm: drawIn * 2.54, bowIn };
}

/**
 * Decides what to say: only the most serious problem, only once it has lasted `holdMs`, never more often than every
 * `gapMs`, and the same cue not again within `repeatMs`. Keeps state between frames.
 */
export class Speaker {
  constructor({ holdMs = 600, gapMs = 3000, repeatMs = 6000 } = {}) {
    Object.assign(this, { holdMs, gapMs, repeatMs });
    this.since = new Map(); this.lastSaid = -Infinity; this.lastById = new Map();
  }
  /** Returns the cue to speak now, or null. */
  next(issues, now) {
    const present = new Set(issues.map((i) => i.id));
    for (const id of [...this.since.keys()]) if (!present.has(id)) this.since.delete(id);
    for (const i of issues) if (!this.since.has(i.id)) this.since.set(i.id, now);
    if (now - this.lastSaid < this.gapMs) return null;
    for (const i of issues) {
      if (now - this.since.get(i.id) < this.holdMs) continue;
      if (now - (this.lastById.get(i.id) ?? -Infinity) < this.repeatMs) continue;
      this.lastSaid = now; this.lastById.set(i.id, now);
      return i;
    }
    return null;
  }
}
