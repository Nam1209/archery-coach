# Gương Bắn Cung (Barebow Mirror)

A web page that turns a phone's front camera into a mirror for barebow archery form. It finds your shoulders, elbows,
wrists, hips and ankles with [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
on the device, draws the target form over you, and speaks one short Vietnamese cue at a time while you are at full draw.
Video never leaves the phone.

Voice cues use the phone's Vietnamese voice. On iPhone the more natural "Enhanced" Vietnamese voice can be downloaded in
Settings → Accessibility → Spoken Content → Voices → Vietnamese; the page picks it when present.

**Open it:** https://nam1209.github.io/archery-coach/ (Safari on iPhone; allow the camera)

> **Prototype.** The thresholds are starting values to tune after real sessions.

## What it checks at full draw

| Check | Cue |
|---|---|
| Bow arm straight (elbow ≥ 165°) | "Duỗi thẳng tay trái" |
| Bow shoulder not raised (shoulders within 6° of level) | "Hạ vai trái xuống" |
| Bow arm level with the shoulder (within 12°) | "Nâng/Hạ tay cầm cung … ngang vai" |
| Draw elbow at shoulder height | "Nâng khuỷu tay phải lên ngang vai" |
| Barebow anchor: draw index finger at the mouth corner (not under the chin, as in Olympic recurve) | "Kéo dây về khoé miệng" / "Đưa tay neo lên khoé miệng" |
| Upright body (within 8° of vertical) | "Đứng thẳng người" |
| Feet about shoulder width apart | "Mở/Khép hai chân …" |

Sides follow the drawing hand chosen in setup. A cue is spoken only after the problem has lasted 0.6 s, at most every
3 s, and the same cue not again within 6 s. "Tổng kết" counts in how many shots each problem appeared.

From your arm span the setup also shows the usual draw-length estimate (span in inches ÷ 2.5) and the bow length often
suggested for it: a starting point to check with a coach or shop.

## Setting up

Stand the phone 3–4 m away, facing your chest, **outside the arrow's path**, with your whole body in frame. Wear
headphones to hear the cues.

## Code

- `posture.js`: the checks, as pure functions on landmark points (tested with `npm test`, Node 20+).
- `app.js`: camera, MediaPipe, drawing, voice and the session log.
- `index.html`: the page.
