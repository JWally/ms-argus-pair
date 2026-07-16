# Poisoning the QR: how far can a captcha's QR code fight a screenshot bot?

_An engineering log of what we learned trying to make the Argus Captcha's pairing
QR readable by any phone but useless to an automated screenshotter — where the
wall is, why it's a theorem and not a skills gap, and what to actually ship._

---

## The problem

The Argus Captcha is a QR device-pairing widget: a human points their phone at a
QR on screen, the phone attests, and a session gets paired. The obvious attack a
bot runs against _any_ on-screen QR is trivial:

> **screenshot the widget → run a QR decoder → lift the pairing URL → replay it.**

No camera, no phone, no presence. The question we chased: **can the QR itself be
made readable by a real phone camera but _not_ by a decoder run on a screenshot?**

Spoiler: partially, and the boundary is sharp and instructive. The QR can be made
a real **speed-bump** against the lazy majority of scrapers, but it **cannot** be
the lock. The lock has to be the token (see [The part that actually
matters](#the-part-that-actually-matters-tokens)).

---

## The idea: poison the high frequencies

A screenshot is the exact framebuffer. A phone captures that framebuffer _through
a lens_ — an optical low-pass (blur + downscale + perspective). So encode the true
bit in each module's **low spatial frequency** (its average tone), and **poison
its high frequency** — invert a small square at the dead center of every data
module:

- A **pixel-exact decoder** that samples the module center locks onto the poisoned
  center and reads the wrong bit → error-correction fails → no decode.
- A **lens** averages that tiny center back into the module's dominant tone → the
  phone reads the true bit.

This is textbook **hybrid images** (Oliva/Torralba/Schyns, 2006) — an image whose
interpretation changes with viewing distance — applied to a QR. The closest prior
art is **mQRCode** (Pan/Chen/Yang, ACM MobiCom 2019), which uses spatial-frequency
moiré for _secrecy_ (readable only from one exact spot). Our inversion —
_readable by everyone's phone, blocked only for a screenshot decoder, as an
anti-automation measure_ — appears unclaimed in the literature we surveyed.

It works on real hardware: a Pixel 5 decodes the poisoned QR at arm's length,
while `zbar`, `zxing`, and `jsQR` all fail on the raw screenshot.

---

## The fitness landscape

Two axes, and they fight:

- **Blue / phone** — reads it fast and reliably (instant, not flaky).
- **Red / bot** — can't lift the URL from a screenshot.

### The theorem (why there's a ceiling)

- A **screenshot** = framebuffer `F`.
- A **phone** = `O(F)`, a _lossy_ optical transform of `F`.
- The phone reads iff some decoder `D` gives `D(O(F)) = URL`.
- The bot **has `F`** — strictly _more_ information than `O(F)`. So it can apply
  the same `O` digitally to match the phone, **and do better**: it knows the module
  grid from the finder patterns, so it can average each cell _perfectly_ where the
  phone only blurs.

**⇒ bot-capability ⊇ phone-capability, always.** No passive, single-frame,
spatial scheme separates them. The corollary governs everything temporal too:

> _single-frame-decodable_ ⟺ _screenshot-readable_.
> Forcing the bot to **record video** ⟺ **no single frame decodes** ⟺ the **phone
> can't read a single frame either**.

### The attack ladder (Red's cost)

| tier   | attack                                                                      | effort                |
| ------ | --------------------------------------------------------------------------- | --------------------- |
| **T0** | stock decoder on one screenshot (`pyzbar` / `zxing` / `cv2.QRCodeDetector`) | one library call      |
| **T1** | + one line of preprocessing (**`downscale → opencv`**)                      | one line              |
| **T2** | custom per-module averager (detect grid, mean each cell)                    | ~20 lines, ~600ms     |
| **T3** | must **record video** and combine frames                                    | screen-record + align |

**Everything we built tops out at T1.** Nothing reached T2 while the phone still
read — because T2's per-module average is _exactly what the phone's lens does_, so
you can't block it without blocking the phone.

---

## What we tried (~15 combos), and how each scored

Scored against the real decoder libraries (`zbar`, `zxing`, OpenCV) plus a
per-module-average custom attack, with an optical model (and later a real Pixel)
for the phone side:

| combo                         | phone    | cheapest bot attack                   |
| ----------------------------- | -------- | ------------------------------------- |
| plain QR                      | 100%     | T0                                    |
| **static poison, small dot**  | **100%** | **T1** ← the max                      |
| poison, big dot / high dose   | 100%     | T0 (OpenCV reads it raw)              |
| moving dots (static QR)       | 100%     | T1 — motion adds nothing              |
| noise + flash                 | ~11%     | T0–T1 (catches the flash)             |
| dots + clean flash            | 100%     | T0 — flash hands over a frame         |
| flips (50/50, 60/60, thirds…) | 0%/frame | T3 — must record                      |
| flip + overlap-poison         | 0%/frame | T3                                    |
| flip + flash (low ratio)      | ~1s live | T1 (recorder)                         |
| bounce / undulate poison      | 100%     | **T0** — pretty, decoratively useless |

### The findings that cost the most to learn

1. **Poison is weaker than it first looks, and OpenCV is the reason.** It reliably
   kills the _center-sampling_ decoders (jsQR/ZBar/ZXing), but **OpenCV averages
   per-module internally** and reads most poison configs straight off a screenshot.
   A one-line `downscale → opencv` cracks the rest. So the ceiling is **T1**.

2. **Poison only reads _at distance_.** A sharp, close capture behaves like a
   screenshot and the poison beats it. The phone works because arm's-length optics
   supply the blur. This is a feature (the screenshot bot has _zero_ blur) but it
   means the effect is real optics, not a trick.

3. **The dose-response is a "chemo" curve.** Two dials: _poison %_ (how many
   modules) and _dot size_ (how much of each module the inverted center covers,
   as % of module width):

   | dot width | module area | phone                 | bot                            |
   | --------- | ----------- | --------------------- | ------------------------------ |
   | ~20%      | 4%          | reads                 | **T1** (only OpenCV+downscale) |
   | ~28–35%   | 8–12%       | reads (flaky near 35) | T0 (OpenCV raw)                |
   | ~40%+     | >16%        | **dies**              | —                              |

   Real Pixel toxicity line: **~35% width**; reliable zone **≤ ~22–25%**. And it's
   _non-monotonic_ — bigger dose is **worse**, not better (past ~20% width, OpenCV
   reads it raw). The sweet spot is a small, static, centered dot.

4. **Every temporal trick collapses.** Flips force the bot to record (T3!) but
   zero out single-frame phone reads — the equivalence above. Flip-flash's flash
   frame is just a poisoned QR the recorder grabs. Bounce/undulate are purely
   cosmetic (T0). "Move the poison so temporal integration cleans it up for the
   phone but not the bot" was tested head-on: **no gap exists** — the recorder does
   the identical averaging the phone does.

5. **Measurement is treacherous.** Single **shutter photos undercount temporal
   configs** — a config that _live-locks_ on the phone scored **0/8** on stills
   (one exposure misses a 16ms flash; a 30fps scanner doesn't). Google's on-screen
   QR chip is laggy/persistent, unreliable for quick sweeps. Judge temporal designs
   by the _live continuous scanner_, not stills.

---

## The recommendation (QR layer)

```json
{ "mode": "static", "poison": 100, "dotWidth": "~18–20% of module", "animation": "none" }
```

- **Static**, so a single exposure locks it → **instant, reliable** phone read.
- **Small centered dot (~18–20% width)** — the only setting that holds **T1**.
- **Canvas-rendered**, so the URL isn't in the DOM either (a scraper gets nothing
  from the markup _or_ a stock decode of the pixels).

What this buys, stated honestly: it **defeats the entire "run a stock QR library
on a screenshot" attack class** — the realistic mass-scraper — and forces anyone
else to write bespoke code. It is a **T1 speed-bump**, not a wall. A determined
`downscale→opencv` or a 20-line custom averager still gets through.

---

## The part that actually matters: tokens

Because the QR can't be the lock, **the QR must not carry anything worth
stealing.** This is the "bitly exchange": the QR encodes a **short-lived, opaque,
single-use token**, not the real pairing URL/secret.

- The QR shows `…/j/<token>` where `<token>` is random, **TTL'd (seconds)**, and
  **single-use** — bound to the desktop session key.
- A bot that perfectly screenshots and decodes the QR gets a string that is
  **already dead** by the time it's replayed, and **can't be exchanged** for
  anything without also completing the phone-side attestation.
- This is exactly what Discord (2-min QR + pubkey binding), Telegram
  (`auth.acceptLoginToken`, single-use), and WhatsApp all do: **security lives in
  the token + phone-approval, never in the QR being unreadable.**

In this codebase that's the `token` the widget already returns and the host
verifies server-to-server (`POST {EMBED_ORIGIN}/api/verify`). The poison is the
**cosmetic outer layer**; the single-use token + attestation is the lock; and a
**proximity/liveness** channel (BLE / ultrasound / WebAuthn hybrid) is the answer
to a determined _relay/record_ adversary the pixels can never stop.

---

## Bottom line

- The anti-screenshot QR is real, works on hardware, and is worth shipping — as a
  **T1 defense-in-depth speed-bump** (`static poison, ~18% dot, canvas`).
- **T1 is a ceiling, not a plateau** — it's the theorem: OpenCV averages like a
  lens, so anything the phone reads a screenshot decoder reads too.
- The genuine, un-cheatable win inside T1: **center-sampling scrapers
  (jsQR/ZBar/ZXing) are fully blocked** across the read-safe range.
- **Do not rely on it.** Put the security in the **single-use, TTL, phone-approved
  token**, and keep the QR payload worthless-if-lifted.
