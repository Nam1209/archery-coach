// Follows one shot from frame to frame: drawing, holding at anchor, the release and the follow-through.
// Pure: feed it (time in ms, landmark points in pixels); it returns a "shot" event once the follow-through is over.
import { analyze, LIMITS, sides } from "./posture.js";

// Distances are in shoulder widths (sw), times in ms. Starting values, to tune on real shots.
export const SHOT = {
  holdMinMs: 1500,        // a barebow aim needs a steady moment at anchor
  tremorMax: 0.03,        // spread of the bow hand / anchor around their own slow movement during the hold
  creepMax: 0.08,         // anchor hand drifting toward the target before the release
  shoulderRiseMax: 0.08,  // bow shoulder rising between the start of the draw and the anchor
  drawElbowDropMax: 0.35, // draw elbow far below the shoulder at some point of the draw
  anchorMax: LIMITS.anchorMax * 1.5, // index finger this close to the mouth corner counts as at anchor
  settleMax: 0.05,        // ...once it moves less than this for `settleMs`
  settleMs: 250,
  releaseJump: 0.15,      // the draw wrist moving at least this far within `releaseWindowMs`...
  releaseFrames: 3,       // ...and staying that far for this many frames = the release
  releaseWindowMs: 100,
  behindEarMin: 0.1,      // after the release the draw wrist should end up clearly behind the draw-side ear
  deadBackMin: 0.2,       // without an ear in view: the draw hand should slide back at least this far
  forwardMax: 0.1,        // ...and not fly toward the target
  bowDropMax: 0.25,       // bow hand dropping within 0.5 s of the release
  followHoldMs: 1000,     // keep the bow arm up this long after the release
  afterMs: 1200,          // follow-through watched for this long
  keepBeforeMs: 1500,     // frames kept before the release for the replay
};

const say = (hand) => ({
  holdShort: "Giữ dây lâu hơn trước khi nhả",
  tremor: "Tay đang run khi giữ dây",
  creep: "Giữ tay neo, đừng để dây trôi về trước",
  shoulderRiseDraw: "Vai cung nhô lên khi kéo",
  drawElbowLowDraw: "Kéo khuỷu tay ngang vai từ đầu",
  deadRelease: `Nhả dây cho tay ${sides(hand).drawWord} trượt ra sau tai`,
  forwardRelease: "Tay kéo bật về trước khi nhả",
  bowDrop: "Giữ tay cung sau khi nhả",
  followShort: "Giữ dáng thêm một giây sau khi nhả",
});

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
    this.anchorT = null; this.release = null; this.after = []; this.candidate = null;
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
        // Anchored once the index finger is at the mouth corner and has stopped there (a draw can pause on the way in).
        // Movement is judged on the draw wrist: the pose model loses the index finger against the face.
        this.path.push({ t, hand: g.drawWrist });
        this.path = this.path.filter((h) => t - h.t <= SHOT.settleMs);
        const settled = t - this.path[0].t >= SHOT.settleMs - 40
          && this.path.every((h) => Math.hypot(h.hand.x - g.drawWrist.x, h.hand.y - g.drawWrist.y) / g.sw < SHOT.settleMax);
        const atAnchor = r.metrics.anchor <= SHOT.anchorMax || r.metrics.wristAnchor <= SHOT.anchorMax;
        // The hold is timed from when the hand arrived, not from when it had been still long enough to tell.
        if (r.phase === "fullDraw" && atAnchor && settled) this.anchor(this.path[0].t, g);
        return [];
      }

      case "anchored": {
        this.hold.push({ t, anchor: g.drawWrist, bowWrist: g.bowWrist, ear: g.ear, sw: g.sw, dir: g.dir });
        // The release: the draw wrist jumps away from where it held and stays away for a few frames (a glitch of the
        // pose model comes straight back). A let-down is too slow to count.
        const away = (from) => Math.hypot(g.drawWrist.x - from.anchor.x, g.drawWrist.y - from.anchor.y) / g.sw >= SHOT.releaseJump;
        if (this.candidate) {
          const c = this.candidate;
          if (away(c.start)) {
            c.frames += 1;
            if (c.frames >= SHOT.releaseFrames) {
              this.release = { t: c.start.t, anchor: c.start.anchor, bowWrist: c.start.bowWrist, ear: c.start.ear, sw: g.sw, dir: g.dir };
              this.after = this.hold.filter((h) => h.t > c.start.t).map((h) => ({ t: h.t, anchor: h.anchor, bowWrist: h.bowWrist, armOut: true }));
              this.hold = this.hold.filter((h) => h.t <= c.start.t);
              this.candidate = null;
              this.state = "follow";
            }
            return [];
          }
          // It came back: drop the glitch frames from the hold.
          this.hold = this.hold.filter((h) => h.t < c.t || h.t === t);
          this.candidate = null;
        } else {
          const recent = this.hold.filter((h) => t - h.t <= SHOT.releaseWindowMs);
          if (this.hold.length > recent.length && away(recent[0])) {
            this.candidate = { t, start: recent[0], frames: 1 };
            return [];
          }
        }
        if (r.phase !== "fullDraw") {
          const gone = Math.hypot(g.drawWrist.x - this.hold[0].anchor.x, g.drawWrist.y - this.hold[0].anchor.y) / g.sw;
          if (gone > 0.6) { this.reset(); return []; }   // let down: back to idle without a shot
        }
        return [];
      }

      case "follow":
        this.after.push({ t, anchor: g.drawWrist, bowWrist: g.bowWrist, armOut: g.armOut });
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
    this.hold = [{ t, anchor: g.drawWrist, bowWrist: g.bowWrist, ear: g.ear, sw: g.sw, dir: g.dir }];
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
    // How far behind the draw-side ear the hand got (+ = behind it, away from the target), when the ear is in view.
    const ear = this.release.ear;
    const behindEar = ear ? Math.max(...half.map((a) => ((ear.x - a.anchor.x) * dir) / sw)) : null;
    const handForward = Math.max(0, ...half.map((a) => along(a)));
    const bowDrop = Math.max(0, ...half.map((a) => (a.bowWrist.y - this.release.bowWrist.y) / sw));
    const downAt = this.after.find((a) => !a.armOut);
    const bowHeldMs = downAt ? downAt.t - this.release.t : SHOT.afterMs;

    const issues = [];
    const cues = say(this.hand);
    const add = (id, over) => { if (over > 0) issues.push({ id, severity: over, say: cues[id] }); };
    // Release problems rank above the others (+1): they are what the shot just showed.
    const addRelease = (id, over) => add(id, over > 0 ? over + 1 : 0);
    // The release first: it is what the shot just showed.
    addRelease("forwardRelease", (handForward - SHOT.forwardMax) / 0.1);
    if (handForward <= SHOT.forwardMax) {
      addRelease("deadRelease", behindEar !== null ? (SHOT.behindEarMin - behindEar) / 0.1 : (SHOT.deadBackMin - handBack) / 0.1);
    }
    addRelease("bowDrop", (bowDrop - SHOT.bowDropMax) / 0.15);
    if (bowDrop <= SHOT.bowDropMax) add("followShort", (SHOT.followHoldMs - bowHeldMs) / 500);
    add("creep", (creep - SHOT.creepMax) / 0.06);
    add("holdShort", (SHOT.holdMinMs - holdMs) / 700);
    add("tremor", (tremor - SHOT.tremorMax) / 0.02);
    add("shoulderRiseDraw", (this.shoulderRise - SHOT.shoulderRiseMax) / 0.06);
    add("drawElbowLowDraw", (this.elbowDrop - SHOT.drawElbowDropMax) / 0.15);
    issues.sort((a, b) => b.severity - a.severity);

    return {
      releaseT: this.release.t, holdMs, tremor, creep, handBack, behindEar, handForward, bowDrop, bowHeldMs,
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
