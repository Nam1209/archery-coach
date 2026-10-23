import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { analyze, LM, LIMITS, sides, Speaker, equipmentFromSpan } from "./posture.js";
import { ShotTracker } from "./shot.js";

const $ = (id) => document.getElementById(id);
const video = $("video"), canvas = $("overlay"), ctx = canvas.getContext("2d");

// ---------- Profile ----------
const PROFILE_KEY = "archery.profile.v1";
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) ?? {}; } catch { return {}; }
}
function saveProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} }
let profile = { height: 177, span: 177, hand: "right", voice: true, ...loadProfile() };
$("height").value = profile.height; $("span").value = profile.span; $("hand").value = profile.hand;

function showEquipment() {
  const span = Number($("span").value);
  if (!(span >= 120 && span <= 230)) { $("drawLen").textContent = "–"; $("bowLen").textContent = "–"; return; }
  const e = equipmentFromSpan(span);
  $("drawLen").textContent = `${e.drawIn.toFixed(1)}" (${Math.round(e.drawCm)} cm)`;
  $("bowLen").textContent = `${e.bowIn}"`;
}
for (const id of ["height", "span", "hand"]) $(id).addEventListener("input", showEquipment);
showEquipment();

// ---------- Voice (Vietnamese) ----------
let viVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  // Prefer the higher-quality Vietnamese voices iOS can download (Enhanced / Premium) over the default compact one.
  const vi = voices.filter((v) => v.lang?.toLowerCase().startsWith("vi"));
  const rank = (v) => /premium/i.test(v.name + v.voiceURI) ? 2 : /enhanced|nâng cao/i.test(v.name + v.voiceURI) ? 1 : 0;
  viVoice = vi.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (!profile.voice || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "vi-VN"; if (viVoice) u.voice = viVoice; u.rate = 1;
  speechSynthesis.speak(u);
}
$("voiceBtn").onclick = () => {
  profile.voice = !profile.voice; saveProfile(profile);
  $("voiceBtn").textContent = `Giọng: ${profile.voice ? "bật" : "tắt"}`;
  if (profile.voice) say("Đã bật giọng");
};
$("voiceBtn").textContent = `Giọng: ${profile.voice ? "bật" : "tắt"}`;

// ---------- Session state ----------
const speaker = new Speaker();
let tracker = new ShotTracker({ hand: profile.hand });
let smooth = null;          // smoothed landmarks in pixels
let lastState = "idle", shots = 0, lastShot = null, snapshot = null, cueUntil = 0;
let noHipsSince = null, toldStepBack = false;
const counts = new Map();   // cue → shots it appeared in
let shotIssues = new Set(); // cues heard while anchored in the current shot
let landmarker = null, running = false, lastVideoTime = -1, wakeLock = null;

$("setupBtn").onclick = () => { $("sheet").hidden = false; };
$("logBtn").onclick = () => { $("log").hidden = !$("log").hidden; renderLog(); };

const el = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
function renderLog() {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const items = rows.length
    ? rows.map(([cue, n]) => { const r = el("div", "", "r"); r.append(el("span", cue), el("span", `${n}/${shots}`)); return r; })
    : [el("div", "Chưa có lỗi nào được ghi.", "sec")];
  const last = lastShot ? [el("div", shotStats(lastShot), "last")] : [];
  $("log").replaceChildren(el("b", `Tổng kết: ${shots} phát`), ...items, ...last);
}
function shotStats(s) {
  return `Phát vừa rồi: giữ ${(s.holdMs / 1000).toFixed(1)} s · run ${(s.tremor * 100).toFixed(1)}% vai · tay kéo về sau ${(s.handBack * 100).toFixed(0)}% vai`;
}

// ---------- Start ----------
$("startBtn").onclick = async () => {
  profile = { ...profile, height: Number($("height").value), span: Number($("span").value), hand: $("hand").value };
  saveProfile(profile);
  tracker = new ShotTracker({ hand: profile.hand });
  say("Bắt đầu buổi tập");   // the first speech must come from a tap on iOS
  $("status").textContent = "Đang mở camera…";
  try {
    if (!video.srcObject) {
      video.srcObject = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      await video.play();
    }
    if (!landmarker) {
      $("status").textContent = "Đang tải mô hình nhận dạng tư thế (lần đầu mất vài giây)…";
      const files = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
      landmarker = await PoseLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO", numPoses: 1,
      });
    }
  } catch (e) {
    $("status").textContent = e?.name === "NotAllowedError"
      ? "Safari đang chặn camera. Vào Cài đặt → Safari → Camera, chọn Hỏi hoặc Cho phép, rồi tải lại trang."
      : `Không mở được: ${e?.message ?? e}`;
    return;
  }
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  $("status").textContent = "";
  $("sheet").hidden = true;
  if (!running) { running = true; requestAnimationFrame(loop); }
};
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && running && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
  if (document.visibilityState === "hidden") wakeLock = null;
});

// ---------- Frame loop ----------
function loop() {
  if (!running) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    handleFrame(res.landmarks?.[0]);
  }
  requestAnimationFrame(loop);
}

function handleFrame(norm) {
  const w = video.videoWidth, h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  const now = performance.now();
  if (!norm) { smooth = null; update({ phase: "notVisible", metrics: {}, issues: [] }, now); return; }

  // Pixels (so angles are not stretched by the aspect ratio), lightly smoothed against jitter.
  const pts = norm.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 1 }));
  smooth = smooth ? pts.map((p, i) => ({ x: smooth[i].x * 0.5 + p.x * 0.5, y: smooth[i].y * 0.5 + p.y * 0.5, v: p.v })) : pts;

  const result = analyze(smooth, { hand: profile.hand });
  for (const e of tracker.push(now, smooth)) if (e.type === "shot") finishShot(e.shot, now);
  if (tracker.state === "follow" && lastState !== "follow") takeSnapshot();
  if (tracker.state === "anchored" && lastState !== "anchored") shotIssues = new Set();
  lastState = tracker.state;

  drawPose(ctx, smooth, result, tracker.state === "anchored" ? result.issues : []);
  update(result, now);
}

// ---------- Drawing ----------
const BONES = [
  ["leftShoulder", "rightShoulder"], ["leftShoulder", "leftElbow"], ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"], ["rightElbow", "rightWrist"], ["leftShoulder", "leftHip"], ["rightShoulder", "rightHip"],
  ["leftHip", "rightHip"], ["leftHip", "leftAnkle"], ["rightHip", "rightAnkle"],
];
// Bones to colour red for each problem.
const BOW_ARM = ["bowShoulder:Elbow", "bowElbow:Wrist"];
const BLAME = {
  bowArmBent: BOW_ARM, bowArmHigh: BOW_ARM, bowArmLow: BOW_ARM, shoulderUp: ["shoulders"], shoulderTilt: ["shoulders"],
  drawElbowLow: ["drawShoulder:Elbow", "drawElbow:Wrist"], anchorFar: ["drawElbow:Wrist"], anchorLow: ["drawElbow:Wrist"],
  torsoLean: ["bowShoulder:Hip", "drawShoulder:Hip"], balanceFront: ["bowHip:Ankle", "drawHip:Ankle"], balanceBack: ["bowHip:Ankle", "drawHip:Ankle"],
};

/** A bone named by role instead of side, e.g. "bowElbow:Wrist", so blame works for either hand. */
function boneKey(a, b, s) {
  if (a === "leftShoulder" && b === "rightShoulder") return "shoulders";
  const role = a.startsWith(s.bow) ? "bow" : "draw";
  const strip = (n) => n.replace(/^(left|right)/, "");
  return `${role}${strip(a)}:${strip(b)}`;
}

function drawPose(c, p, result, issues) {
  const s = sides(profile.hand);
  const blamed = new Set(issues[0] ? (BLAME[issues[0].id] ?? []) : []);
  const lw = Math.max(4, c.canvas.width / 220);
  const ok = (n) => p[LM[n]] && p[LM[n]].v >= 0.5;

  if (result.geom?.plumbX !== undefined) drawPlumb(c, p, result, lw);
  // Target form, drawn faint and dashed under the real skeleton.
  if (result.phase === "fullDraw") drawGhost(c, p, s, lw);

  c.lineCap = "round";
  for (const [a, b] of BONES) {
    if (!ok(a) || !ok(b)) continue;
    const bad = blamed.has(boneKey(a, b, s));
    c.strokeStyle = bad ? "#ff5a4e" : "rgba(242,241,236,.9)";
    c.lineWidth = bad ? lw * 1.6 : lw;
    c.beginPath(); c.moveTo(p[LM[a]].x, p[LM[a]].y); c.lineTo(p[LM[b]].x, p[LM[b]].y); c.stroke();
  }
  c.fillStyle = "#e8c14a";
  for (const n of ["leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftHip", "rightHip"]) {
    if (!ok(n)) continue;
    c.beginPath(); c.arc(p[LM[n]].x, p[LM[n]].y, lw * 1.2, 0, Math.PI * 2); c.fill();
  }
}

/** A plumb line straight up from the middle of the feet, and where the body's centre (hips and shoulders) sits on it. */
function drawPlumb(c, p, result, lw) {
  const { plumbX, sw, dir } = result.geom;
  const bal = result.metrics.balance;
  const off = bal !== undefined && Math.abs(bal) > LIMITS.balanceMax;
  const colour = off ? "#ffb020" : "rgba(110,190,255,.9)";
  c.save();
  c.setLineDash([lw * 3, lw * 2]); c.strokeStyle = colour; c.lineWidth = lw * 0.8;
  c.beginPath(); c.moveTo(plumbX, 0); c.lineTo(plumbX, c.canvas.height); c.stroke();
  if (bal !== undefined) {
    const hipY = (p[LM.leftHip].y + p[LM.rightHip].y) / 2;
    const cx = plumbX + bal * sw * dir;
    c.setLineDash([]); c.lineWidth = lw;
    c.beginPath(); c.moveTo(plumbX, hipY); c.lineTo(cx, hipY); c.stroke();
    c.fillStyle = colour; c.beginPath(); c.arc(cx, hipY, lw * 1.8, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

/** Where the arms should be for this archer: bow arm straight and level from the bow shoulder, draw elbow at shoulder
 *  height, shoulders level. Lengths come from the archer's own upper arm and forearm in this frame. */
function drawGhost(c, p, s, lw) {
  const P = (side, n) => p[LM[side + n]];
  const bs = P(s.bow, "Shoulder"), be = P(s.bow, "Elbow"), bw = P(s.bow, "Wrist");
  const ds = P(s.draw, "Shoulder"), de = P(s.draw, "Elbow");
  const dir = Math.sign(bw.x - bs.x) || 1;
  const upper = Math.hypot(be.x - bs.x, be.y - bs.y), fore = Math.hypot(bw.x - be.x, bw.y - be.y);
  const shoulderY = (bs.y + ds.y) / 2;
  c.save();
  c.setLineDash([lw * 2.5, lw * 2]);
  c.strokeStyle = "rgba(60,207,122,.85)"; c.lineWidth = lw * 1.2; c.lineCap = "round";
  c.beginPath();
  c.moveTo(bs.x, shoulderY); c.lineTo(bs.x + dir * (upper + fore), shoulderY);      // bow arm
  c.moveTo(bs.x, shoulderY); c.lineTo(ds.x, shoulderY);                             // level shoulders
  c.moveTo(ds.x, shoulderY); c.lineTo(de.x, shoulderY);                             // draw elbow at shoulder height
  c.stroke();
  c.restore();
}

// ---------- HUD and voice ----------
function update(r, now) {
  const m = r.metrics;
  const set = (id, text, off) => { const e = $(id); e.textContent = text; e.classList.toggle("off", !!off); };
  set("mBow", m.bowElbow ? `${Math.round(m.bowElbow)}°` : "–", m.bowElbow && m.bowElbow < LIMITS.bowElbowMin);
  set("mShoulder", m.shoulderTilt !== undefined ? `${m.shoulderTilt.toFixed(0)}°` : "–", m.shoulderTilt > LIMITS.shoulderTiltMax);
  set("mElbow", m.drawElbowDrop !== undefined ? (m.drawElbowDrop > LIMITS.drawElbowDropMax ? "thấp" : "ổn") : "–", m.drawElbowDrop > LIMITS.drawElbowDropMax);
  const anchorText = m.anchor === undefined ? "–" : m.anchorDrop > LIMITS.anchorLowMax ? "thấp" : m.anchor > LIMITS.anchorMax ? "xa" : "khoé miệng";
  set("mAnchor", anchorText, anchorText === "thấp" || anchorText === "xa");
  const bal = m.balance;
  const noFeet = r.geom && r.geom.plumbFrom !== "feet";
  set("mBalance", noFeet ? "không thấy chân" : bal === undefined ? "–" : Math.abs(bal) <= LIMITS.balanceMax ? "giữa" : bal > 0 ? "chân trước" : "chân sau",
      noFeet || (bal !== undefined && Math.abs(bal) > LIMITS.balanceMax));
  // Say plainly what can't be judged rather than staying silent about it.
  const from = r.geom?.plumbFrom;
  const hint = !r.geom ? "" : from === "feet" ? "" : from === "hips"
    ? "Lùi xa để thấy cả hai chân: chưa đo được trọng tâm"
    : "Lùi xa: chưa thấy hông và chân, chưa đo được người nghiêng và trọng tâm";
  $("feetHint").textContent = hint; $("feetHint").hidden = !hint;
  if (hint && !from) {
    noHipsSince ??= now;
    // Once per session, while not aiming, after 2 s without hips in view.
    if (!toldStepBack && tracker.state !== "anchored" && now - noHipsSince > 2000) { toldStepBack = true; say("Lùi ra xa để camera thấy cả người"); }
  } else noHipsSince = null;

  const st = r.phase === "notVisible" ? "notVisible" : tracker.state;
  const holdS = tracker.anchorT !== null && st === "anchored" ? ((now - tracker.anchorT) / 1000).toFixed(1) : null;
  $("phase").className = "pill" + (st === "anchored" ? (r.issues.length ? " draw" : " ok") : "");
  $("phaseText").textContent = {
    notVisible: "Không thấy đủ người", idle: "Chuẩn bị", drawing: "Đang kéo", anchored: `Giữ dây ${holdS} s`,
    follow: "Nhả – giữ dáng", cooldown: "Hạ cung",
  }[st];

  const cueEl = $("cue");
  if (now < cueUntil) return;   // a post-shot cue is still showing
  // Cues while aiming only: never during the draw, the release or the follow-through.
  if (st !== "anchored") { cueEl.hidden = true; speaker.next([], now); return; }
  for (const i of r.issues) shotIssues.add(i.say);
  if (r.issues.length) {
    cueEl.hidden = false; cueEl.className = "bad"; cueEl.textContent = r.issues[0].say;
    const cue = speaker.next(r.issues, now);
    if (cue) say(cue.say);
  } else {
    speaker.next([], now);
    cueEl.hidden = false; cueEl.className = "good"; cueEl.textContent = "Dáng tốt";
  }
}

/** After the follow-through: count the shot, say the one thing that mattered most, keep it for the replay. */
function finishShot(shot, now) {
  shots += 1; $("shots").textContent = `Phát ${shots}`;
  for (const i of shot.issues) shotIssues.add(i.say);
  for (const cue of shotIssues) counts.set(cue, (counts.get(cue) ?? 0) + 1);
  lastShot = { ...shot, snapshot };
  const top = shot.issues[0];
  const text = top ? `Phát vừa rồi: ${top.say}` : shotIssues.size ? "Nhả dây tốt" : "Phát tốt";
  say(text);
  const cueEl = $("cue");
  cueEl.hidden = false; cueEl.className = top ? "bad" : "good"; cueEl.textContent = text;
  cueUntil = now + 3000;
  $("replayBtn").hidden = false;
  if (!$("log").hidden) renderLog();
}

// ---------- Slow replay around the release ----------
function takeSnapshot() {
  const c = document.createElement("canvas");
  c.width = video.videoWidth / 2; c.height = video.videoHeight / 2;
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  snapshot = c;
}

let replayRaf = 0;
$("replayBtn").onclick = () => {
  if (!lastShot?.frames?.length) return;
  $("replay").hidden = false;
  $("replayStats").textContent = shotStats(lastShot);
  const rc = $("replayCanvas"), c = rc.getContext("2d");
  rc.width = video.videoWidth; rc.height = video.videoHeight;
  const frames = lastShot.frames, t0 = frames[0].t, span = frames.at(-1).t - t0;
  const start = performance.now(), SLOW = 4;
  const s = sides(profile.hand);
  const track = (f, side, name) => {
    const p = f.points[LM[side + name]];
    return p && p.v >= 0.5 ? p : null;
  };
  const draw = () => {
    const pos = t0 + (((performance.now() - start) / SLOW) % (span + 400));
    const i = Math.max(0, frames.findLastIndex((f) => f.t <= pos));
    c.clearRect(0, 0, rc.width, rc.height);
    if (lastShot.snapshot) { c.globalAlpha = 0.35; c.drawImage(lastShot.snapshot, 0, 0, rc.width, rc.height); c.globalAlpha = 1; }
    // Paths so far: the draw hand (index finger, else wrist) in gold, the bow hand in green.
    const lw = Math.max(4, rc.width / 220);
    for (const [colour, pick] of [["#e8c14a", (f) => track(f, s.draw, "Index") ?? track(f, s.draw, "Wrist")], ["#3ccf7a", (f) => track(f, s.bow, "Wrist")]]) {
      c.strokeStyle = colour; c.lineWidth = lw * 0.8; c.beginPath();
      frames.slice(0, i + 1).map(pick).filter(Boolean).forEach((p, k) => (k ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    }
    const f = frames[i];
    drawPose(c, f.points, analyze(f.points, { hand: profile.hand }), []);
    $("replayRelease").hidden = f.t < lastShot.releaseT;
    replayRaf = requestAnimationFrame(draw);
  };
  cancelAnimationFrame(replayRaf);
  draw();
};
$("replayClose").onclick = () => { cancelAnimationFrame(replayRaf); $("replay").hidden = true; };
