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
| Weight centred: hips and shoulders over a plumb line between the feet | "Đừng dồn người lên chân trước" / "… về chân sau" |

## Each shot: draw, hold, release, follow-through

`shot.js` follows the shot from frame to frame and, once the follow-through is over, says the one thing that mattered
most ("Phát vừa rồi: …"). Nothing is spoken during the draw, the release or the follow-through.

| Moment | Check | Cue |
|---|---|---|
| Draw | Bow shoulder rising between the start of the draw and the anchor | "Vai cung nhô lên khi kéo" |
| Draw | Draw elbow far below the shoulder on the way in | "Kéo khuỷu tay ngang vai từ đầu" |
| Hold | Under 1.5 s at anchor | "Giữ dây lâu hơn trước khi nhả" |
| Hold | Bow hand or anchor shaking | "Tay đang run khi giữ dây" |
| Hold | Anchor hand creeping toward the target | "Giữ tay neo, đừng để dây trôi về trước" |
| Release | Draw hand not reaching behind the draw-side ear (dead release) | "Nhả dây cho tay phải trượt ra sau tai" |
| Release | Draw hand thrown toward the target | "Tay kéo bật về trước khi nhả" |
| Follow-through | Bow hand dropping within 0.5 s | "Giữ tay cung sau khi nhả" |
| Follow-through | Bow arm down before 1 s | "Giữ dáng thêm một giây sau khi nhả" |

A shot starts counting once the index finger has stopped at the mouth corner (a pause on the way in is not the
anchor). The release is the anchor hand jumping away from there and still being away on the next frame (a one-frame
jump of the finger landmark at the face is ignored); the camera (30 frames a second) cannot see the
string leave the fingers, only what the hands do around it. A front camera also sees little of a hand moving toward or
away from it, so plucking out from the face is not checked yet.

"Xem lại" replays 1.5 s before to 1.2 s after the release, four times slower, with the paths of both hands.

Sides follow the drawing hand chosen in setup. A cue is spoken only after the problem has lasted 0.6 s, at most every
3 s, and the same cue not again within 6 s. "Tổng kết" counts in how many shots each problem appeared.

From your arm span the setup also shows the usual draw-length estimate (span in inches ÷ 2.5) and the bow length often
suggested for it: a starting point to check with a coach or shop.

## Setting up

Stand the phone 3–4 m away, facing your chest, **outside the arrow's path**, with your whole body in frame. Wear
headphones to hear the cues.

## Code

- `posture.js`: the checks on one frame, as pure functions on landmark points.
- `shot.js`: one shot followed frame by frame (draw, hold, release, follow-through).
- Both are tested with `npm test` (Node 20+) on synthetic poses.
- `app.js`: camera, MediaPipe, drawing, voice and the session log.
- `index.html`: the page.
