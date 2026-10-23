// Follows one shot from frame to frame: drawing, holding at anchor, the release and the follow-through.
// Pure: feed it (time in ms, landmark points in pixels); it returns a "shot" event once the follow-through is over.
import { analyze } from "./posture.js";

// Distances are in shoulder widths (sw), times in ms. Starting values, to tune on real shots.
export const SHOT = {
  holdMinMs: 1500,        // a barebow aim needs a steady moment at anchor
  tremorMax: 0.03,        // spread of the bow hand / anchor around their own slow movement during the hold
  creepMax: 0.08,         // anchor hand drifting toward the target before the release
  shoulderRiseMax: 0.08,  // bow shoulder rising between the start of the draw and the anchor
  drawElbowDropMax: 0.35, // draw elbow far below the shoulder at some point of the draw
  settleMax: 0.05,        // the hand counts as anchored once it moves less than this within `releaseWindowMs`
  releaseJump: 0.15,      // the anchor hand moving at least this far within `releaseWindowMs` = the release
  releaseWindowMs: 100,
  deadBackMin: 0.2,       // after the release the draw hand should slide back at least this far
  forwardMax: 0.1,        // ...and not fly toward the target
  bowDropMax: 0.25,       // bow hand dropping within 0.5 s of the release
  followHoldMs: 1000,     // keep the bow arm up this long after the release
  afterMs: 1200,          // follow-through watched for this long
  keepBeforeMs: 1500,     // frames kept before the release for the replay
};

const say = {
  holdShort: "Giữ dây lâu hơn trước khi nhả",
  tremor: "Tay đang run khi giữ dây",
  creep: "Giữ tay neo, đừng để dây trôi về trước",
  shoulderRiseDraw: "Vai cung nhô lên khi kéo",
  drawElbowLowDraw: "Kéo khuỷu tay ngang vai từ đầu",
  deadRelease: "Nhả dây cho tay trượt về sau",
  forwardRelease: "Tay kéo bật về trước khi nhả",
  bowDrop: "Giữ tay cung sau khi nhả",
  followShort: "Giữ dáng thêm một giây sau khi nhả",
};

export class ShotTracker {
  constructor({ hand = "right" } = {}) {
    this.hand = hand;
    this.reset();
  }

  reset() {
    this.state = "idle";
    this.drawStart = null;      // bow shoulder y and time when the draw began
    this.shoulderRise = 0; this.elbowDrop = 0;
    this.hold = [];             // {t, anchor, bowWrist} while anchored
    this.anchorT = null; this.release = null; this.after = [];
    this.lostSince = null;
  }

  /** One frame. Returns events: [{ type: "shot", shot }] when a shot is complete, otherwise []. */
  push(t, points) {
    const r = analyze(points, { hand: this.hand });
    this.frames = (this.frames ?? []).filter((f) => t - f.t <= SHOT.keepBeforeMs + SHOT.afterMs);
    this.frames.push({ t, points });
    const g = r.geom;
    if (!g) return [];

    switch (this.state) {
      case "idle":
        if (g.armOut) { this.state = "drawing"; this.drawStart = { y: g.bowShoulder.y, t }; this.path = []; }
        return [];

      case "drawing": {
        if (!g.armOut) return this.lost(t);
        this.lostSince = null;
        this.shoulderRise = Math.max(this.shoulderRise, (this.drawStart.y - g.bowShoulder.y) / g.sw);
        this.elbowDrop = Math.max(this.elbowDrop, r.metrics.drawElbowDrop ?? 0);
        // Anchored once the hand is at the face and has stopped moving (it moves fast on the way in).
        this.path.push({ t, anchor: g.anchor });
        this.path = this.path.filter((h) => t - h.t <= SHOT.releaseWindowMs);
        const settled = this.path.length >= 3 && this.path.every((h) => Math.hypot(h.anchor.x - g.anchor.x, h.anchor.y - g.anchor.y) / g.sw < SHOT.settleMax);
        if (r.phase === "fullDraw" && settled) this.anchor(t, g);
        return [];
      }

      case "anchored": {
        this.hold.push({ t, anchor: g.anchor, bowWrist: g.bowWrist, sw: g.sw, dir: g.dir });
        // The release: the anchor hand jumps away within a few frames. A let-down moves slowly and is not a shot.
        const recent = this.hold.filter((h) => t - h.t <= SHOT.releaseWindowMs);
        const start = recent[0];
        const moved = Math.hypot(g.anchor.x - start.anchor.x, g.anchor.y - start.anchor.y) / g.sw;
        if (moved >= SHOT.releaseJump && this.hold.length > recent.length) {
          this.release = { t: start.t, anchor: start.anchor, bowWrist: start.bowWrist, sw: g.sw, dir: g.dir };
          this.hold = this.hold.filter((h) => h.t <= start.t);
          this.after = recent.slice(1).map((h) => ({ t: h.t, anchor: h.anchor, bowWrist: h.bowWrist, armOut: true }));
          this.state = "follow";
          return [];
        }
        if (r.phase !== "fullDraw") {
          const away = Math.hypot(g.anchor.x - this.hold[0].anchor.x, g.anchor.y - this.hold[0].anchor.y) / g.sw;
          if (away > 0.6) { this.reset(); return []; }   // let down: back to idle without a shot
        }
        return [];
      }

      case "follow":
        this.after.push({ t, anchor: g.anchor, bowWrist: g.bowWrist, armOut: g.armOut });
        if (t - this.release.t >= SHOT.afterMs) {
          const shot = this.summarize();
          const keep = this.frames.filter((f) => f.t >= this.release.t - SHOT.keepBeforeMs);
          shot.frames = keep;
          this.reset();
          this.state = "cooldown";
          return [{ type: "shot", shot }];
        }
        return [];

      case "cooldown":
        // Wait for the bow arm to come down before looking for the next draw.
        if (!g.armOut) this.state = "idle";
        return [];
    }
    return [];
  }

  anchor(t, g) {
    this.state = "anchored"; this.anchorT = t;
    this.hold = [{ t, anchor: g.anchor, bowWrist: g.bowWrist, sw: g.sw, dir: g.dir }];
  }

  lost(t) {
    this.lostSince ??= t;
    if (t - this.lostSince > 500) this.reset();
    return [];
  }

  summarize() {
    const { sw, dir } = this.release;
    const holdMs = this.release.t - this.anchorT;
    // Steadiness: how far the bow hand and the anchor wander around their own slow movement (moving average).
    const steady = this.hold.filter((h) => this.release.t - h.t > 150);
    const tremor = Math.max(spread(steady.map((h) => h.bowWrist)), spread(steady.map((h) => h.anchor))) / sw;
    const first = this.hold[0].anchor, last = this.release.anchor;
    const creep = ((last.x - first.x) * dir) / sw;

    const within = (ms) => this.after.filter((a) => a.t - this.release.t <= ms);
    const along = (a) => ((a.anchor.x - this.release.anchor.x) * dir) / sw;   // + = toward the target
    const half = within(500);
    const handBack = Math.max(0, ...half.map((a) => -along(a)));
    const handForward = Math.max(0, ...half.map((a) => along(a)));
    const bowDrop = Math.max(0, ...half.map((a) => (a.bowWrist.y - this.release.bowWrist.y) / sw));
    const downAt = this.after.find((a) => !a.armOut);
    const bowHeldMs = downAt ? downAt.t - this.release.t : SHOT.afterMs;

    const issues = [];
    const add = (id, over) => { if (over > 0) issues.push({ id, severity: over, say: say[id] }); };
    // The release first: it is what the shot just showed.
    add("forwardRelease", (handForward - SHOT.forwardMax) / 0.1 + 1);
    if (handForward <= SHOT.forwardMax) add("deadRelease", (SHOT.deadBackMin - handBack) / 0.1 + 1);
    add("bowDrop", (bowDrop - SHOT.bowDropMax) / 0.15 + (bowDrop > SHOT.bowDropMax ? 1 : 0));
    if (bowDrop <= SHOT.bowDropMax) add("followShort", (SHOT.followHoldMs - bowHeldMs) / 500);
    add("creep", (creep - SHOT.creepMax) / 0.06);
    add("holdShort", (SHOT.holdMinMs - holdMs) / 700);
    add("tremor", (tremor - SHOT.tremorMax) / 0.02);
    add("shoulderRiseDraw", (this.shoulderRise - SHOT.shoulderRiseMax) / 0.06);
    add("drawElbowLowDraw", (this.elbowDrop - SHOT.drawElbowDropMax) / 0.15);
    issues.sort((a, b) => b.severity - a.severity);

    return {
      releaseT: this.release.t, holdMs, tremor, creep, handBack, handForward, bowDrop, bowHeldMs,
      shoulderRise: this.shoulderRise, elbowDrop: this.elbowDrop, issues,
    };
  }
}

/** Root-mean-square distance of points from a centred 7-frame moving average (slow drift does not count). */
function spread(pts) {
  if (pts.length < 8) return 0;
  let sum = 0, n = 0;
  for (let i = 3; i < pts.length - 3; i++) {
    let mx = 0, my = 0;
    for (let k = -3; k <= 3; k++) { mx += pts[i + k].x; my += pts[i + k].y; }
    mx /= 7; my /= 7;
    sum += (pts[i].x - mx) ** 2 + (pts[i].y - my) ** 2; n++;
  }
  return Math.sqrt(sum / n);
}
