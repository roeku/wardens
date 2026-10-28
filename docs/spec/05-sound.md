# Sound and music

> **Rebuild notes.** Meta's lineup has no audio-generation model, so every sound is made with code, as it already was in VANGUARD. Each cue below is a Strudel recipe (strudel.cc), rendered offline in a dev-only "sound lab" page to `.m4a`. The game plays only the rendered files and never runs Strudel at runtime, because Strudel is AGPL. To ship faster, you can also play these recipes as tiny Web Audio synth voices for SFX and keep Strudel for the music. In both cases, **re-render every file during the hackathon**: the old `.m4a` files are pre-existing assets.

## 1. Audio philosophy

- **Diegetic and placed.** Every sound belongs to something in the world: a horn, steel, cloth, wind, a bell. There is no UI sound for UI's sake. Audio starts on the first tap; **M** toggles mute, and the setting is kept in localStorage.
- **Only what the player can see is heard.** Before an event plays a sound, check whether the player's fog of war shows its position. The player's own side is always heard.
- **Positioned by the camera.** One-shots are panned by their position across the screen and faded by their distance from the camera's focus. Horns are panned but not faded: a horn carries.
- **Under the music.** Repeating sounds (steps, selection creaks, footfalls) are mixed below the music. Horn calls sit about 4 dB over the road tune, just enough to read as a signal.
- **One tonality.** Pitched SFX use only the notes D and A, which belong to every piece of music. The third is avoided because it differs between minor and major pieces.
- **Never the same twice.** Most cues have round-robin variants `_0.._N`, never repeat back to back, and get a small random pitch bend.

## 2. Runtime engine

### Graph
```
BufferSource -> Gain(level × matchedGain) -> StereoPanner(pan) -> bus ─┐
bus: music (0.42) | sfx (0.85) | ambience (0.5)                       ├-> master Gain(0.9; 0 muted; ×0.35 while paused) -> destination
```
- Master changes use `setTargetAtTime(v, t, 0.08)`.
- Each one-shot gets a new `BufferSource→Gain→StereoPanner` chain, with the pitch bend set on `playbackRate`. Skip the sound if its buffer isn't loaded yet or its gain is ≤ 0.001.
- **Beds** are looping sources on the ambience bus, starting at gain 0: din (battle noise), wind, fire and alarm. Each frame sets every bed's level with `setTargetAtTime(level, t, 0.3)`.
- Suspend the AudioContext while the tab is hidden.

### Unlock
- Create the `AudioContext` 300 ms after the first frame is drawn. Creation costs 90 to 120 ms on an old phone, so it must not happen under the player's finger. The context starts suspended.
- `unlock()` runs on every `pointerdown`, `pointerup` and `keydown` in the capture phase. The first call resumes the context, builds the buses and starts loading sounds; later calls wake the context again if it is suspended.

### Levels table `MIX`
| key | value | key | value |
|---|---|---|---|
| master | 0.9 | music / sfx / ambience bus | 0.42 / 0.85 / 0.5 |
| roadTune / roadDrums / restDrums | 0.9 / 0.85 / 0.12 | battleTune / battleDrums | 0.9 / 0.85 |
| battleFloor → battleTop | 0.3 → 1 | stinger | 0.7 (music bus) |
| stingerHold / stingerDuck | 5 s / 0.12 | fallDuck / fallDuckSeconds | 0.3 / 4 s |
| horn (company) | 0.2 | army / rally | 0.22 / 0.28 |
| steel | 0.3 (×0.7–1.0 random) | volley | 0.4 |
| banner | 0.55 | fall (commander_fall) | 0.35 |
| freed / saved | 0.35 / 0.18 | bell (dusk) | 0.4 (ambience) |
| din / wind / fire / alarm | 0.75 / 0.7 / 1 / 1 | alarmReach | 3 (× reach) |
| houseFall | 0.55 | enemyHorn | 0.22 |
| torch / dawn | 0.3 / 0.5 (dawn on music bus) | foeFall | 0.23 |
| honour | 0.19 | musterLift/Step/Plant/Big/Horn/Down | 0.11/0.10/0.21/0.22/0.11/0.34 |
| select / deselect | 0.22 / 0.11 | paused (whole mix) | 0.35 |

Unit voices: elephant_trumpet 0.34, elephant_scream 0.19, elephant_step 0.12, crossbow_release 0.4, crossbow_span 0.12, knight_charge 0.35, halberd_chop 0.24, javelin 0.21, drake_roar 0.36, drake_breath 0.27, drake_snap 0.44, drake_step 0.14, drake_shriek 0.16. Unit voices bend pitch by ±0.05.

The levels above aim at these targets, in momentary LUFS as played:

| sound | target LUFS |
|---|---|
| music | −21 to −26 |
| horns | −24 |
| steel | −27 to −29 |
| select | −29 |
| deselect | −32 |
| muster steps | −32 to −34 |
| commander_fall | −21 (the loudest signal) |
| victory / defeat | −20 |

### Spatial rule
- **Ear.** The ear is the camera focus in tiles, plus `half` = half the screen width in tiles.
- **Reach.** `reach = max(10, half × 1.6)`. Some sounds carry further: banner_fall, freed and enemy_horn use reach×2, and house_fall uses reach×1.5. The crossbow span uses reach×0.6.
- **Attenuation.** With `d = dist(source, ear)`: drop the sound if `d ≥ reach`, otherwise multiply its gain by `(1 − d/reach)^1.5`.
- **Pan.** The camera looks north-east, so screen-right is the ground vector (1,1).
  - `across = clamp(((x−ex)+(y−ey))/√2 / max(1, half), −1, 1)`
  - `pan = across × 0.7`
  - Company horns use `across × 0.6` and no distance fade.
- **Not positioned:** horn_army, horn_rally, commander_fall, the stingers, the dusk bell, the night enemy horn, and the muster, select and honour sounds. The ford's "saved" cheer is panned −0.7, "from the side".

### Density rules (instead of a polyphony cap)
- **Steel:** of the melee hits seen this frame, only the one nearest the camera sounds. The next steel waits a random 0.08 to 0.22 s.
- **Volley:** at most one per company per 1.1 s.
- **Charge:** once per company per 6 s. **Creature cries:** one per company per 1.5 s. **Drake breath or bite:** once per company per 0.9 s.
- **Footfall:** one per 1.6 tiles walked by the company's centre, and only while it moves faster than 0.6 tiles/s.
- **Crossbow span:** follows 60% of releases, 0.3 to 0.8 s after the release.

### Variation and loudness matching
- **Picking a variant:** `v = floor(roll×count)`; if v equals the last variant played, use `(v+1)%count` instead.
- **Pitch bend:** select, deselect and muster lift/step ±0.06; honour ±0.03; plant ±0.02; muster horn ±0.01; down ±0.05; steel 0.94 to 1.06.
- **Company calls:** gain = `horn_army_loudness / call_loudness`, clamped to 0.25 to 4. Peak normalising left the trumpet call 4.5 to 5 dB quieter than the horns, which is why the calls are matched by loudness.
- **Unit voices:** each variant's gain = `geometric_mean / own`, clamped to 0.7 to 1.4.
- **Measuring loudness:** RMS of the samples within 40 dB of the peak. Precompute these values into a table rather than measuring at runtime.

### Ducking and intensity
- **Ducking:** `hold()` returns 0.12 for 5 s after a victory or defeat, 0.3 for 4 s after one of your commanders falls, and 1 otherwise. The music's output gain follows it with a 0.5 s time constant.
- **Battle intensity:** `want = min(1, seenMeleeBlowsPerSecond / 30)`, smoothed by `fight += (want−fight)·min(1, dt/1.6)`. The battle stem's level is `0.3 + 0.7·fight`.
- **Din:** `0.75 × min(1, fight×1.4)`.
- **Fire:** `(1 − d/reach)^1.5`, where d is the distance to the nearest visible burning house.
- **Alarm:** `1 − d/(reach×3)`, where d is the distance to an unfreed village with a house on fire.

### Fetching
- At most 4 downloads at a time, in priority order: first 0, music 1, title 2, battle 3, units 4, ahead 5. Fetch rank 3 and above with `priority:'low'`.
- The sets:
  - **first:** select, wind
  - **title:** muster cues, honour, horn_army
  - **battle:** to_arms, the horn orders and recalls, steel, volley, din, enemy_horn, banner_fall, commander_fall, foe_fall, freed, horn_rally, victory, defeat, dusk_bell. Fetch this set when the player is at the muster or the army sets out.
  - **village:** fire, alarm, house_fall
  - **night:** torch, dawn
  - Unit voices load per the units present on the field.
- A cue requested before its file arrives stays silent.

## 3. Music director
| piece | stems | plays before a rest |
|---|---|---|
| march | drums, tune | 2 |
| longfield | drums, tune | 2 |
| hearth | single | 1 |
| shieldwall, ironfield, keep | drums, tune, battle | until the battle ends |
| lament | single | 1, not looped |

- **On the road:** rotate march → longfield → hearth, with 12 to 28 s of wind alone between pieces. "Silence keeps a piece fresh."
- **Battle start:**
  1. `to_arms` plays on the music bus at 0.7.
  2. 2.6 s later the battle piece starts: shieldwall and ironfield alternate, and the last battle (at the keep) uses `keep`.
  3. The road piece fades out with a 0.5 time constant.
- **After the battle:** the road music resumes 3 s later. After a defeat, `lament` plays first.
- **Stems:** start all stems of a piece sample-aligned at `ctx.currentTime + 0.05`, all looping. Each stem's gain follows its scene level with `setTargetAtTime(level, t, 0.6)`.
  - road: drums 0.85 while marching and 0.12 at rest; tune 0.9; battle stem 0
  - battle: drums 0.85; tune 0.9; battle stem 0.3 to 1
- **Ending a looping piece:** start the fade 1.2 s before its last pass ends (time constant 0.3), and stop the sources 1.2 s later.
- **Memory:** decode only one piece at a time. Prefetch the next piece's compressed bytes 30 s before the current one ends, and decode it during the rest. A decoded 3-stem battle piece is 55 to 79 MB.

## 4. SFX cue recipes (Strudel)
Conventions:
- Muster, select and honour cues run at `setcps(2)`, so seconds×2 = cycles.
- Instruments are VCSL samples (CC0, loaded from jsDelivr) and GM soundfonts.
- Shared reverb tails:
  - `AIR = .room(.16).roomsize(.8)`
  - `GROUND = .room(.12).roomsize(1).roomlp(4500)`
  - `LAIR = .room(.15).roomsize(1.3).roomlp(4000)`
- Each cue's kind is either `once` or `loop`:
  - `once`: rendered with a tail, trimmed at −60 dB, given a 20 ms fade-out, and normalised to a −1 dBFS peak.
  - `loop`: rendered one period plus its tail, with the tail folded back onto the start for a seamless loop.

### Stingers (music bus)
- **to_arms** (battle starts; 5.2 s):
  ```
  setcps(1/3)
  stack(s("snare_hi*16").n(irand(4).add(4)).velocity(saw.range(.15,1)).gain(.7).compress(0,.5),
        s("bassdrum1").n(7).struct("~ ~ x ~").gain(1).room(.3),
        note("~ ~ [d3 d3 a3@2]@2").s("gm_french_horn").n(1).attack(.03).release(.6).gain(.9).room(.4))
  ```
- **victory** (9 s). `setcps(1/5)`. Then `.room(.4).roomsize(4)`.
  - brass: `note("[d4 d4 d4 a4@3 [d4,f#4,a4,d5]@10]").s("gm_brass_section").n(3).attack(.02).release(1).gain(.75)`
  - timpani: `[~@6 a1@3 d2@7]`, n 2, gain .9
  - snare roll: snare_hi*8 with velocity on a saw from .2 to .8
  - clash: on `[~@6 x@10]`, gain .45
- **defeat** (10 s). `setcps(1/6)`. Then room .5, roomsize 5.
  - horn: `[a3@2 g3 f3@2 e3 d3@6]`, attack .15, release 1.2, gain .8
  - gm_cello: `[d2,a2]`, attack 1, release 2, gain .45
  - timpani: `[~@8 d2]`, gain .5
- **dawn** (a night survived). `setcps(1/6)`. Then room .6, roomsize 5.
  - gm_string_ensemble_1: `[d3,a3,d4,f#4]`, attack 1.5, release 2, gain .5
  - gm_piccolo birdsong: `~ [a6 b6]*3 ~ [f#6 g6 f#6 ~] ~ [a6 b6]*2`, attack .01, release .15, gain .22, `pan(sine.range(.3,.8))`

### Horns and signals
- **horn_army** (an order to the whole army): two horns in harmony.
  ```
  setcps(1)
  stack(note("[d3@2 a3@4]"), note("[a2@2 f3@4]").gain(.6)).s("gm_french_horn").n(1).attack(.04).release(.5).gain(.9).room(.45).roomsize(3)
  ```
- **horn_rally** (captain tapped). `setcps(1/3)`. `[d3 d3 a3@6]` over `[a2 a2 d3@6]` at gain .6. Same horn, with attack .06, release 1, room .5, roomsize 4.
- **commander_fall**: one sinking, distant note. It ducks the music to 0.3 for 4 s.
  ```
  setcps(1/4)
  note("[d3@5 c3@3]").s("gm_french_horn").n(1).attack(.4).release(1.5).gain(.75).lpf(1800).room(.6).roomsize(6)
  ```
- **enemy_horn**: a semitone rub. `setcps(1/3)`.
  - gm_tuba: `[a1@3 bb1@5]`
  - gm_trombone (n 2): `[a2@3 bb2@5]` at gain .6
  - shared: attack .08, release 1, gain .85, lpf 1600, room .6, roomsize 6
- **foe_fall** (an enemy commander falls; 1.5 s). `setcps(2)`.
  - horns: `d3 a3 d4@2` (gain .85) over `a2 d3 f#3@2` (gain .5), clip 1, lpf 2000
  - shout at 0.25 s: `men('d2,a2,d3,a3,d4', hold .22, fade .45, gain .42)`
- **muster_horn_0/1**: one note, d3 or a3.
  ```
  s("gm_french_horn").n(1).attack(.07).release(.3).clip(.5).gain(.9).lpf(1800).room(.18).roomsize(1)
  ```

### Per-company horn calls (orders rise, recalls fall)
Template: `setcps(cps); note(seq).<voice>.attack(.04).release(.5).gain(.9).room(.45).roomsize(3)`

| # | character | voice | cps | order | recall |
|---|---|---|---|---|---|
| 0 | short, long; low | gm_french_horn n1 | 1 | `[c3 f3@3]` | `[f3 c3@3]` |
| 1 | three quick, then a leap | french horn | 1 | `[d3 d3 d3 g3@3]` | `[g3 g3 g3 d3@3]` |
| 2 | long, a breath, long; higher | french horn | 2/3 | `[a3@2 ~ d4@3]` | `[d4@2 ~ a3@3]` |
| 3 | a quick run, the highest | gm_trumpet n0 | 1 | `[g3 a3 c4 d4@4]` | `[d4 c4 a3 g3@4]` |
| 4 | slow and low, a fifth | gm_trombone n2 | 2/3 | `[a2@3 e3@3]` | `[e3@3 a2@3]` |

- Each call differs from the others in rhythm, register **and** instrument at once. A first set used one rhythm at five pitches, and the owner said it was "too similar".
- A commander gets a call at their first order on the field and keeps it. If another active company already holds that call, they get the lowest free one.
- Assignments persist by commander name.

### Building blocks
- **`foot(note,g)`**:
  - sine thump: penv(4), pdecay .04, decay .08, gain g·.4
  - brown noise: decay .07, lpf 900, gain g·.5
  - pink scuff: decay .035, bpf 1100, q .7, gain g·.18
- **`gusts(n, span, from, to, gust, gain)`** (cloth): `s("pink*n")`, attack gust·.3, decay gust, a `bpf(saw.range(from,to))` sweep, bpq .7, hpf 260, all compressed into `span` seconds.
- **`snap(t,hz,g)`**: a pink crack (decay .06, bpf hz) plus a brown slap (lpf 450).
- **`unfurl(g)`**: a pink swell at bpf 900, then snaps at 0.10, 0.17 and 0.23 s (1200, 1000 and 800 Hz; gains 1, .68, .4), all under lpf 4200.
- **`pole(v,g)`**:
  - a VCSL `cajon` stroke through lpf 1100
  - a sine "post" at d3: penv 5, decay .12
  - brown earth through lpf 650
  - a pink knock at bpf 580–720, q 1.6
  - a tiny 2.2 kHz click
- **`men(notes, hold, fade, gain)`** (a shout):
  - `gm_choir_aahs` n 2, tuned sharp (D +40 cents, A +7 to 20 cents) because the patch sounds flat
  - a formant voice per note: a saw through bpf 650 (q 2.5), 1150 (q 3, ×.5) and 2600 (q 4, ×.1), with `penv(2)` and `vib(5.5).vibmod(.1)`, spread across pan .3 to .7
  - a pink "h" at bpf 1300
- **`creak(v,g)`** (leather):
  - a saw near 90 Hz (g2, f#2, a2, f2 or e2) gliding ±2 to 3 semitones, through bpf 700–950 (q 4) with `vib(37).vibmod(.9)`
  - `pink*(span·100)` stick-slip ticks: degradeBy .18, bpf sweeping from mid·.85 to mid·1.2

### Muster and command cues (each under 1.2 s)
| cue | variants | recipe |
|---|---|---|
| muster_lift | 2 | cloth gusts (3–4 gusts over 0.22 s, sweeping 650→1500 Hz or 800→1700 Hz, gain .75), then `foot('a3',.9)` at 0.2 s |
| muster_step | 2 | `foot(d3,1)` + `foot(a3,.7)`, 0.16 or 0.19 s apart, with cloth gusts at 0.06 s |
| muster_plant | 3 | `pole` + `unfurl(1)` + `men` (3 voices, e.g. d2,a2,d3; hold .1, fade .16, gain .4) at 0.03 s |
| muster_plant_big | 2 | the same, with 4–5 `men` voices (d2..d4), hold .2, fade .26 |
| muster_down | 2 | `framedrum` n 3/4, clip .3, lpf 900; falling cloth (1500→350 Hz) at 0.1 s; a "flump" (brown lpf 350 + pink bpf 600) at 0.3 s |
| select | 3 | `creak` (g2/f#2/a2, glide −2/−3, mid 850/750/950, span .18–.22) + 2 cloth gusts; also used as the title screen's click |
| deselect | 2 | `creak` at gain .7 (f2/e2, glide +2/+3) + cloth settling |
| honour | 2 | a rising-fifth horn `d3 a3@2` or `a2 d3@2` (clip 1, lpf 1800) + `men` at 0.17 s + `unfurl(.7)` |

### Field and world
- **steel_0..5** (≈0.5 s). `setcps(1)`. Variants (n, speed, ring): (2,2.0,1), (5,2.3,1.12), (8,1.8,.9), (1,2.1,1.21), (4,2.5,.95), (7,1.9,1.06).
  ```
  stack(s("anvil").n(N).speed(S).hpf(1500).gain(.7),
        freq("[2650,2671,4170,6020] × ring").s("sine").decay(.28).sustain(0).gain(.1),
        s("white").decay(.02).sustain(0).hpf(4000).gain(.5)).room(.15)
  ```
  The inharmonic partials above 2.5 kHz stop steel from ringing like a bell.
- **volley**. `setcps(1/2)`.
  - bowstrings: `note("g2").s("triangle").struct("x*12").compress(0,.06).penv(14).pdecay(.04).decay(.07).gain(.2)`
  - arrows: `s("pink").struct("x*14").degradeBy(.25).compress(.02,.3).clip(15).bpf(rand.range(1800,4200)).bpq(2.5).attack(.15).decay(.5).gain(rand.range(.6,1)).pan(rand)`
- **banner_fall**. `setcps(1/2)`. room .25.
  - flapping cloth: `pink*28` degradeBy .2, compressed into the first 55%, decay .05, velocity rand .3 to 1, hpf 150, lpf rand 700 to 2400
  - at 6/8: `bassdrum1` n 4 (lpf 380, gain .35) plus `framedrum` n 7 (speed .7, gain .2)
- **din** (loop, 8 s). `setcps(1/8)`. room .35, roomsize 3.
  - metal: `s("anvil").struct("x*48").degradeBy(.35).n(irand(9)).speed(rand.range(1.2,1.9)).hpf(900).gain(rand.range(.08,.3)).pan(rand)`
  - feet: a brown-noise shuffle, x*8, attack .4, release .6, lpf 420, gain .35
- **wind** (loop, 16 s). `setcps(1/16)`.
  - `pink` x*4, attack 2, release 2.5, clip 1.6, `lpf(perlin.range(280,1100))`, lpq 1.5, gain perlin .2 to .4
  - `brown` x*3, attack 2.5, release 3, `lpf(perlin.slow(2).range(200,700))`, gain perlin .3 to .5
- **fire** (loop, 6 s):
  - a brown roar: x*6, lpf perlin 300 to 700
  - white crackles: x*64, degradeBy .55, decay .004 to .02, hpf 1.2 to 3.5k
  - pink pops: x*12, bpf 300 to 900
- **alarm** (loop, 4 s). Uneven, frightened ringing.
  ```
  setcps(1/4)
  note("d4 ~ d4 d4 ~ d4 d4 ~ d4 ~ d4 d4").s("tubularbells").velocity(rand.range(.55,1)).clip(3).release(.4).lpf(3000).gain(.7).room(.4).roomsize(3)
  ```
- **house_fall**. room .4.
  - white cracks x*24
  - `bassdrum1` n 5, lpf 300
  - brown noise, decay 1.2, `lpf(sine.range(400,1200))`
  - `framedrum` n 3 at speed .6
- **dusk_bell** (when the day is 80% gone):
  ```
  setcps(1/9)
  note("d3 d3 d3").s("tubularbells").lpf(2600).gain(.85).room(.7).roomsize(6)
  ```
- **torch**: pink noise, decay .35, `bpf(sine.range(600,1800))`, with sparse white sparks at hpf 2500.
- **freed** (0.9 s): a choir on (d3,a3), then on (a3,d4) 0.1 s later, lpf 2600, plus a pink murmur and `s("clap*10").n(irand(4).add(6)).degradeBy(.45).gain(rand.range(.12,.28))`. **No bell**: the alarm bell stopping says it.

### Unit voices (all through 24 dB/oct lowpasses, with GROUND or LAIR)
- **elephant_trumpet ×3** (≈1.6 s):
  - two saws on D4, A3 or A4, detuned +0.2 semitone from each other
  - pitch rises from 5 to 7 semitones below over 0.11 s, then sinks over 0.4 to 0.5 s
  - each saw has its own vibrato (15–29 Hz) and tremolo (11–21 Hz, depth .33), with lpf 3000
  - a nasal bpf 1000 band that opens
  - a pink breath before the note
- **elephant_scream ×3**: higher (A4/D5). The cry jumps up 4 to 7 semitones and falls, with a wail (vib 7 or 11) and tremolo 26, and a groan at A3/D4 0.3 s later.
- **elephant_step ×4**: a sine at a1/d2 with penv 3, brown noise at bpf 120–165, brown noise at lpf 280–360, a pink pad at bpf 230, and dust at bpf 800.
- **crossbow_release ×3**:
  - a white plus pink crack
  - `slapstick` at speed .85 to .95
  - a sine thunk (g2/a2, penv 8) plus brown noise
  - a triangle limb ring (c3/d3)
  - a pink bolt whistle at bpf 1350–1700, q 4, falling `bpenv(-1.2)`
- **crossbow_span ×2**: 9 to 10 pink ratchet clicks at bpf 2300–3000, slowing (gaps 0.07→0.13 s), each with a triangle a4 tock, then a clack at about 0.93 s.
- **knight_charge ×3**:
  - anvil clash (speed .8–.9, hpf 500, lpf 2600)
  - a sine a1 impact (penv 7)
  - hooves: `s("[brown brown brown ~]*4")` with `velocity(saw.range(1,.12))`, lpf 320
  - plate jingle: anvil*10, degradeBy .35
- **halberd_chop ×4**: a sine thock (e3–a3, penv 8) plus brown noise, a pink bite at 1.7–2.1 kHz, and a short anvil ring. It replaces steel for heavy foot.
- **javelin ×3**: three throws 0.06 to 0.09 s apart, each a pink swish (bpf 450–580, rising) then a flight (bpf 620–800, falling `bpenv(-1.3)`).
- **drake_roar ×3**:
  - a saw growl at D2/A1 that climbs 9 to 14 semitones and falls
  - three formants (420, 900 and 1900 Hz), FM'd by brown noise, with `distort(1)` and tremolo 19–41 Hz
  - a gurgle, a rasp and a closing hiss
- **drake_breath ×3** (1.8 s, synced to the animation):
  - an inhale: pink noise sweeping up 3.2 octaves over 0 to 0.4 s
  - ignition at 0.4 s: a sine at MIDI 40 plus brown noise
  - the jet from 0.4 to 1.45 s: a brown whoosh with an opening lpf, a pink burn at bpf 700, sub-rumble, a growl, then sparks and embers
- **drake_snap ×3**: a slapstick clack, a triangle tooth, then a snort 80 to 90 ms later.
- **drake_step ×4**: a sine thud, brown weight at bpf 135–165, a scrape, and three claw ticks at 1.8 to 2.7 kHz, 25 to 35 ms apart.
- **drake_shriek ×3**: two saws falling 10 to 14 semitones from D5/E5, with tremolo 53–73 Hz, distort 1.2 and a falling bpf 1400.
- **Borrowed voices.** A creature without its own voice borrows one: beasts roar with drake_roar and cry when hurt with drake_shriek; walking beasts use elephant_step; impact blows use halberd_chop.

## 5. Music pieces
Render all pieces to the same loudness: RMS −20 dB over the samples within 40 dB of the peak, with the peak capped at −1 dBFS. Each stem gets the full mix's gain, so the stems sum to the full mix. VCSL recorders, strumstick and organ sound an octave above their written note, so they are written with `oct(...,-1)`.

| Piece | Place | Key / metre / tempo | Length | Stems |
|---|---|---|---|---|
| THE ROAD (march) | road | D dorian, 4/4, `setcpm(100/4)` | 16 bars, 38.4 s | drums, tune |
| THE LONG FIELD | road | G mixolydian, 6/8, `setcpm(50)` | 32 bars AABB, 38.4 s | drums, tune |
| HEARTH | road at rest, campaign end | E dorian, 3/4, 72 bpm | 32 bars, 80 s | single |
| SHIELDWALL | every other battle | D minor, 4/4, 112 bpm | 32 bars ABAB, 68.6 s | drums, tune, battle |
| IRONFIELD | every other battle | A phrygian, 6/8, `setcpm(40)` | 32 bars, 48 s | drums, tune, battle |
| THE KEEP | last battle | D phrygian, 4/4, 84 bpm | 24 bars, 68.6 s | drums, tune, battle |
| LAMENT | once after a defeat | D minor, 4/4, 60 bpm | 12 bars, 51 s | single, not looped |

- **THE ROAD**
  - drums: `snare_low` in a 2-bar pattern `<[x ~ ~ x x ~ ~ ~ x ~ ~ x x ~ x ~] [x ~ ~ x x ~ ~ ~ x x x x x ~ ~ ~]>`, gain .75, plus `bassdrum1` n 6 on `x ~ x ~`
  - tune: a gm_cello drone in fifths, one chord per bar: `<[d2,a2] [c2,g2] [g2,d3] [d2,a2] ×2, [f2,c3] [c2,g2] [f2,c3] [d2,a2] [c2,g2] [d2,a2] [g2,d3] [d2,a2]>`, under a tenor recorder melody that opens `d4@2 a3@2 d4 e4 f4@2`
- **THE LONG FIELD**
  - tune: a fiddle jig in quavers. Section A opens `g4 b4 d5 b4 d5 g5` over G F G Dm G F C G; section B opens `c5 e5 g5 e5 g5 c6` over C G F G C F Dm G.
  - The alto recorder doubles the tune an octave down on the repeats only.
  - strumstick chords on `x ~ ~ x ~ ~`; cello on root and fifth
  - drums: framedrum `<[x ~ x x ~ x]!7 [x x x x x x]>` plus bass drum on `x ~ ~ x ~ ~`
- **HEARTH**
  - a 16-bar air: fiddle the first time, tenor recorder the second
  - chords: Em D Em A G D A Bm G D A Em Bm G A Em
  - harp arpeggios of six notes per bar; a cello root with a slow attack; a string pad on the second pass only
- **SHIELDWALL** (A = Dm Dm Bb C Dm Dm Gm A; B = Dm C Bb C Dm Bb Gm A)
  - drums: gm_taiko on `x ~ ~ x ~ ~ x ~`; timpani on the roots with a fill every 8th bar; snare ghosts
  - tune: a cello quaver ostinato, strings an octave up, contrabass
  - battle stem: horn stabs in the A sections; a horn theme in the B sections, opening `d4@3 a3 d4@2 f4@2`; choir in bars 17 to 24; trumpets an octave up in the last 8 bars
- **IRONFIELD** (Am Bb Am Bb F G Bb A)
  - drums: snare gallop `<[x ~ x x ~ x]!7 [x x x x x x]>`
  - tune: a cello gallop
  - battle stem: a high string pad; a trumpet theme (opening `e4 a4 c5 e5@3`) in bars 9–16 and 25–32; horns an octave down in bars 17–32
- **THE KEEP** (Dm Eb Dm C Bb Eb Gm A; the Eb is the phrygian bII)
  - drums: timpani, a gong every 8 bars, taiko on beat 4
  - tune: pipe organ in fifths plus a tuba
  - battle stem: choir and gm_brass_section theme (opening `d4@4 a3@4`) from bar 9; tubular bells and trumpets in bars 17 to 24
- **LAMENT** (Dm Bb Gm A Dm F Gm A Bb Gm A Dm)
  - a gm_english_horn melody that opens `a4@4 f4@2 d4@2` and ends on `d4@8`
  - cello roots and a slow string pad

Because the battle stems carry masks, a long battle hears its piece develop through its sections.

## 6. Authoring pipeline
- **The sound lab** is a dev-only page listing each cue as `{name, event, group, kind: once|loop, cycles, tail, code, stems?, level?}`. For each cue it can:
  - play it live
  - solo a stem
  - open it in strudel.cc (the code base64'd into the URL hash)
  - render it to a file
- **Rendering** runs Strudel's engine in an `OfflineAudioContext` at 44.1 kHz stereo. The dev server saves a WAV plus an AAC `.m4a`; music is encoded at 128 kb/s.
- **The sound check** runs ffmpeg on each render and reports its duration, integrated LUFS and true peak, draws a spectrogram PNG, and measures the loop-seam jump. An AI can't listen, so it should check these measurements instead. The test suite fails if a file's loudness drifts more than 0.05 dB from the table.

## 7. Lessons (what was wrong, then the fix)
1. **Horns were too loud and too similar.** Their levels dropped from 0.45 to 0.2, so they now sit about 4 dB over the tune instead of about 11. The calls were made to differ in rhythm, register and instrument, and matched by loudness rather than peak.
2. **Spectrograms caught real faults:**
   - steel rang like a bell; fixed with inharmonic partials above 2.5 kHz
   - the volley's arrows were cut short
   - the banner's thud drowned its cloth
   - the wind loop stepped at its fold
   - the recorder played an octave high
3. **"The march gets repetitive."** The fix was seven pieces, each with a place of its own, and wind alone between them.
4. **"Peasants recruited SFX much too extreme."** Ceremonies had 3 to 7 s fanfares and applause. They became short wood, cloth and leather sounds under 1.2 s. The company call is never used at a ceremony, only as an order.
5. **Loud ceremonies were trimmed.** honour went from −15.8 to −24 LUFS and from 6 s to 1 s; foe_fall from 6 s to 1.5 s.
6. **Repeats must not sound mechanical.** Variants are matched to within 1.4 dB, at most 2% of the energy sits above 5 kHz, and reverb tails are darkened. Footfalls are made from noise, not pitched thuds.
7. **Performance.** The first tap had fetched 101 files (6.5 MB). Staged fetching, a precomputed loudness table and decoding one music piece at a time fixed it.
