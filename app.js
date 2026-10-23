import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { analyze, LM, LIMITS, sides, Speaker, equipmentFromSpan } from "./posture.js";

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
  viVoice = voices.find((v) => v.lang?.toLowerCase().startsWith("vi")) ?? null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (!profile.voice || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "vi-VN"; if (viVoice) u.voice = viVoice; u.rate = 1.05;
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
let smooth = null;          // smoothed landmarks in pixels
let lastPhase = "notVisible", shots = 0, cleanSince = null, praised = false;
const counts = new Map();   // issue cue → shots it appeared in
let shotIssues = new Set();
let landmarker = null, running = false, lastVideoTime = -1, wakeLock = null;

$("setupBtn").onclick = () => { $("sheet").hidden = false; };
$("logBtn").onclick = () => { $("log").hidden = !$("log").hidden; renderLog(); };

function renderLog() {
  const el = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const items = rows.length
    ? rows.map(([cue, n]) => { const r = el("div", "", "r"); r.append(el("span", cue), el("span", `${n}/${shots}`)); return r; })
    : [el("div", "Chưa có lỗi nào được ghi.", "sec")];
  $("log").replaceChildren(el("b", `Tổng kết: ${shots} phát`), ...items);
}

// ---------- Start ----------
$("startBtn").onclick = async () => {
  profile = { ...profile, height: Number($("height").value), span: Number($("span").value), hand: $("hand").value };
  saveProfile(profile);
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
  if (!norm) { smooth = null; update({ phase: "notVisible", metrics: {}, issues: [] }); return; }

  // Pixels (so angles are not stretched by the aspect ratio), lightly smoothed against jitter.
  const pts = norm.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 1 }));
  smooth = smooth ? pts.map((p, i) => ({ x: smooth[i].x * 0.5 + p.x * 0.5, y: smooth[i].y * 0.5 + p.y * 0.5, v: p.v })) : pts;

  const result = analyze(smooth, { hand: profile.hand });
  drawPose(smooth, result);
  update(result);
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
  drawElbowLow: ["drawShoulder:Elbow", "drawElbow:Wrist"], anchorFar: ["drawElbow:Wrist"], torsoLean: ["bowShoulder:Hip", "drawShoulder:Hip"],
};

/** A bone named by role instead of side, e.g. "bowElbow:Wrist", so blame works for either hand. */
function boneKey(a, b, s) {
  if (a === "leftShoulder" && b === "rightShoulder") return "shoulders";
  const role = a.startsWith(s.bow) ? "bow" : "draw";
  const strip = (n) => n.replace(/^(left|right)/, "");
  return `${role}${strip(a)}:${strip(b)}`;
}

function drawPose(p, result) {
  const s = sides(profile.hand);
  const blamed = new Set(result.issues[0] ? (BLAME[result.issues[0].id] ?? []) : []);
  const lw = Math.max(4, canvas.width / 220);
  const ok = (n) => p[LM[n]] && p[LM[n]].v >= 0.5;

  // Target form, drawn faint and dashed under the real skeleton.
  if (result.phase === "fullDraw") drawGhost(p, s, lw);

  ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    if (!ok(a) || !ok(b)) continue;
    const bad = blamed.has(boneKey(a, b, s));
    ctx.strokeStyle = bad ? "#ff5a4e" : "rgba(242,241,236,.9)";
    ctx.lineWidth = bad ? lw * 1.6 : lw;
    ctx.beginPath(); ctx.moveTo(p[LM[a]].x, p[LM[a]].y); ctx.lineTo(p[LM[b]].x, p[LM[b]].y); ctx.stroke();
  }
  ctx.fillStyle = "#e8c14a";
  for (const n of ["leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftHip", "rightHip"]) {
    if (!ok(n)) continue;
    ctx.beginPath(); ctx.arc(p[LM[n]].x, p[LM[n]].y, lw * 1.2, 0, Math.PI * 2); ctx.fill();
  }
}

/** Where the arms should be for this archer: bow arm straight and level from the bow shoulder, draw elbow at shoulder
 *  height, shoulders level. Lengths come from the archer's own upper arm and forearm in this frame. */
function drawGhost(p, s, lw) {
  const P = (side, n) => p[LM[side + n]];
  const bs = P(s.bow, "Shoulder"), be = P(s.bow, "Elbow"), bw = P(s.bow, "Wrist");
  const ds = P(s.draw, "Shoulder"), de = P(s.draw, "Elbow");
  const dir = Math.sign(bw.x - bs.x) || 1;
  const upper = Math.hypot(be.x - bs.x, be.y - bs.y), fore = Math.hypot(bw.x - be.x, bw.y - be.y);
  const shoulderY = (bs.y + ds.y) / 2;
  ctx.save();
  ctx.setLineDash([lw * 2.5, lw * 2]);
  ctx.strokeStyle = "rgba(60,207,122,.85)"; ctx.lineWidth = lw * 1.2; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(bs.x, shoulderY); ctx.lineTo(bs.x + dir * (upper + fore), shoulderY);      // bow arm
  ctx.moveTo(bs.x, shoulderY); ctx.lineTo(ds.x, shoulderY);                             // level shoulders
  ctx.moveTo(ds.x, shoulderY); ctx.lineTo(de.x, shoulderY);                             // draw elbow at shoulder height
  ctx.stroke();
  ctx.restore();
}

// ---------- HUD, voice and per-shot log ----------
function update(r) {
  const m = r.metrics;
  const set = (id, text, off) => { const el = $(id); el.textContent = text; el.classList.toggle("off", !!off); };
  set("mBow", m.bowElbow ? `${Math.round(m.bowElbow)}°` : "–", m.bowElbow && m.bowElbow < LIMITS.bowElbowMin);
  set("mShoulder", m.shoulderTilt !== undefined ? `${m.shoulderTilt.toFixed(0)}°` : "–", m.shoulderTilt > LIMITS.shoulderTiltMax);
  set("mElbow", m.drawElbowDrop !== undefined ? (m.drawElbowDrop > LIMITS.drawElbowDropMax ? "thấp" : "ổn") : "–", m.drawElbowDrop > LIMITS.drawElbowDropMax);
  set("mAnchor", m.anchor !== undefined ? (m.anchor > LIMITS.anchorMax ? "xa" : "sát") : "–", m.anchor > LIMITS.anchorMax);

  const phaseEl = $("phase");
  phaseEl.className = "pill" + (r.phase === "fullDraw" ? (r.issues.length ? " draw" : " ok") : "");
  $("phaseText").textContent = { notVisible: "Không thấy đủ người", other: "Chuẩn bị", fullDraw: "Đang kéo dây" }[r.phase];

  const now = performance.now();
  if (r.phase === "fullDraw" && lastPhase !== "fullDraw") {
    shots += 1; $("shots").textContent = `Phát ${shots}`; shotIssues = new Set(); praised = false; cleanSince = null;
  }
  if (r.phase !== "fullDraw" && lastPhase === "fullDraw") {
    for (const cue of shotIssues) counts.set(cue, (counts.get(cue) ?? 0) + 1);
    if (!$("log").hidden) renderLog();
  }
  lastPhase = r.phase;

  const cueEl = $("cue");
  if (r.phase !== "fullDraw") { cueEl.hidden = true; speaker.next([], now); return; }
  for (const i of r.issues) shotIssues.add(i.say);
  if (r.issues.length) {
    cleanSince = null;
    cueEl.hidden = false; cueEl.className = "bad"; cueEl.textContent = r.issues[0].say;
    const cue = speaker.next(r.issues, now);
    if (cue) say(cue.say);
  } else {
    speaker.next([], now);
    cleanSince ??= now;
    cueEl.hidden = false; cueEl.className = "good"; cueEl.textContent = "Dáng tốt";
    if (!praised && now - cleanSince > 1500) { praised = true; say("Tốt"); }
  }
}
