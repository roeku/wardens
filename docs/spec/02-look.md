# The look: rendering pipeline and art style

The look in one paragraph:
- A three.js scene lit with **toon shading** and seen through an **orthographic camera at the 2:1 isometric angle** (pitch 30°, facing north-east).
- It is drawn into a **small, low-resolution target, about 380 art pixels on the short side**.
- A post pass then runs **once per art pixel**. It adds depth-based outlines, night torchlight and the pause grey.
- A final pass scales the image up with **nearest-neighbour sampling** and corrects for the camera's sub-pixel offset.
- **Every see-through effect is ordered Bayer dithering**, so the picture is always made of whole pixels.
- The result is pixel art made from 3D: soldiers can turn, walk and fall freely and still read as hand-placed pixels.

## 1. Pipeline end to end

**Renderer setup**
- `WebGLRenderer({antialias:false, stencil:false, depth:false})`. The canvas itself has no depth buffer; only the off-screen target has one.
- `outputColorSpace = LinearSRGBColorSpace` and `THREE.ColorManagement.enabled = false`. **The palette is exactly the colours that reach the screen**: hex values go through with no sRGB conversion.
- `setPixelRatio(1)`; size the canvas by hand.
- Shadows: `BasicShadowMap` (hard edges, no PCF), bias −0.0008, normalBias 0.02, map 2048 at the high tier.

**Choosing the art pixel**
- `px` (CSS pixels per art pixel) = `?px` or `max(1, round(min(innerW, innerH) / 380))`. The short side is always about 380 art pixels: px=3 on a 1080p desktop, px=1 on a phone.
- `aw = floor(w/px)`, `ah = floor(h/px)`. The canvas CSS size is `aw*px × ah*px`.
- `dpr = min(3, devicePixelRatio)`, or 1 on the low tier.
- **Scene target `rt`:** `(aw+2) × (ah+2)`. The 1 art-pixel margin on each side is for the sub-pixel shift. NearestFilter, no mipmaps, a float `DepthTexture`.
- **"Cell" target `cellRt`:** the same size, 8 bits per channel, no depth.

**One frame is three passes**
1. Render the scene into `rt` through the ortho camera.
2. Run `CELL_FS` on a full-screen quad into `cellRt`, **once per art pixel**. It used to run once per screen pixel, which was a big waste.
3. `POST_FS` scales the cell image up onto the canvas.

### Pass 2: CELL_FS

Uniforms:
- `uRange` = far − near (319); it converts depth to tiles
- `uEdge = 0.32` tiles
- `uInk = #16120f`
- `uLights[48]` (vec4: x and y in art px, reach in art px, strength) and `uLightN`
- `uNightK` (0..1)
- `uGrey` (0 or 1)

```glsl
c = floor(gl_FragCoord.xy); col = tCol(c); d = tDepth(c);
// Outline: drawn on the FARTHER pixel, coloured from the NEARER neighbour ("selective outlining")
best=0; near=col;
for each 4-neighbour o: dn = depth(c+o); gap = (min(d,0.9999)-dn)*uRange;
  if (gap>uEdge && gap>best && d<0.9999) { best=gap; near=tCol(c+o); }
if (best>0) col = mix(near*0.42, uInk, 0.25);
// Night
if (uNightK>0) {
  lit=0; for each light L: dd=(c-L.xy)*vec2(1,1.7);   // ground pools are ellipses, ~half as tall as wide
         lit=max(lit, L.w*clamp((1-length(dd)/L.z)*1.3,0,1));
  q = clamp(floor(clamp(lit,0,1)*3 + bayer4(c))/3, 0,1);  // 3 warmth steps, 4x4 Bayer dithered
  tint = mix(vec3(0.34,0.40,0.62) /*moonlight*/, vec3(1.12,0.92,0.68) /*torch*/, q);
  col = mix(col, col*tint + vec3(0,0.004,0.018)*(1-q), uNightK);
}
// Pause grey
if (uGrey>0) { l=dot(col,vec3(0.3,0.55,0.15)); col=mix(col, vec3(l)*vec3(0.92,0.90,1.0), 0.55*uGrey); }
```

The Bayer 4×4 matrix `[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5]`, used as `(m+0.5)/16`, is the same everywhere: fog, marks, ground paint and night.

**There is no palette-quantization pass.** The limited-palette feel comes from three things:
- the 4-step toon ramp
- hex colours passed straight through
- dithered steps (fog levels, haze, night bands, marks, ground ramps)

### Pass 3: POST_FS
```glsl
dev = vUv*uOut; a = dev/uScale + 1.0 + uSub; c = floor(a);
col = tCell((c+0.5)/uArt);
if (uDanger>0) { v = smoothstep(0.28,0.72,length((vUv-0.5)*vec2(1,0.8)));
                 col = mix(col, vec3(0.55,0.05,0.04), v*uDanger*0.55); }  // hurt captain: red vignette
```
- `uScale = px*dpr`.
- `uSub` is the camera's leftover fraction of an art pixel (see §2). It is what keeps panning smooth while the art stays on its grid.
- The red vignette is the only effect drawn at screen resolution.
- The clear colour is `L.haze`, which changes with the time of day.

## 2. Camera
- **Projection:** orthographic, **pitch 30° down from the horizon** (the 2:1 isometric), yaw facing **north-east**. `FWD = normalize(1,0,-1)`, `RIGHT = normalize(1,0,1)`.
- **World axes:** x east, z south, y up; 1 unit = 1 tile. The attacker's west edge is along the lower left and the keep is upper right, so **the army advances up the screen**.
- **Zoom:** `ZOOMS = [7, 9, 11, 13, 16, 19, 23, 28, 34]` art px per tile along the screen. Start at index 4 for maps 80 wide or more, 5 for 64 or more, else 6.
- **Frustum:** half extents `hw = (aw+2)/2/s`, `hh = (ah+2)/2/s`; near 1, far 320. The camera sits 150 units back along the view direction.
- **Pixel snapping (essential):**
  1. Project the focus point (on the ground, at terrain height) onto the screen's RIGHT and UP axes.
  2. Round both to multiples of `1/s`.
  3. Put the camera at the snapped point.
  4. Pass the remainder `(r-rs)*s, (u-us)*s` to `uSub`, where the scaling pass adds it back.
- **Figures are snapped too:**
  - Round each man's position to the art-pixel grid along the screen axes, with `across = (x+z)·√½` and `up = (x−z)·√½·0.5 + h·(√3/2)`.
  - To move up the screen, slide along the ground so the feet stay planted.
- **Moving the view:**
  - `panBy` makes the ground follow the finger; divide the vertical drag by sin(pitch).
  - `zoomAt` steps the zoom index and keeps the ground under the cursor fixed.
  - `easeTo(x,y,dt,rate=3)` is an exponential follow. Clamp the focus to the map ±2 tiles.
- **Controls:** follow the captain until the player moves the view. Pan with two fingers, right mouse, arrows or WASD; pinch or wheel steps the zoom; F follows again.
- **Picking:**
  - `groundAt` walks the ray down from 6 tiles up in 0.08 steps, then bisects 8 times.
  - Squads are picked in screen space, by the nearest man or banner.

## 3. Light and time of day: the light is the clock
There is no clock on screen. `daylight(t)`, with t = battle time / time limit, interpolates between these keys:

| t | sun elev | sun RGB | sunI | sky (hemi) | ground (hemi) | hemiI | haze |
|---|---|---|---|---|---|---|---|
| 0 | 52° | 1, .95, .84 | 2.45 | .8, .86, .98 | .56, .5, .4 | 1.62 | .42, .5, .56 |
| .55 | 42° | 1, .92, .76 | 2.42 | .8, .84, .93 | .58, .5, .38 | 1.56 | .44, .48, .52 |
| .8 | 26° | 1, .78, .5 | 2.5 | .8, .72, .8 | .54, .43, .34 | 1.4 | .42, .34, .38 |
| 1 | 13° | .98, .52, .34 | 1.9 | .48, .48, .68 | .36, .3, .28 | 1.1 | .2, .18, .28 |

**Sun direction**
- Azimuth `az = -0.35 - 0.25t`; `sunDir = (-sin az·cos el, -sin el, cos az·cos el)`.
- The sun is to the north and a little west, i.e. the upper left of the screen, and swings west as the day goes.
- The shadow camera is a square of half-size `hyp((aw+2)/s, (ah+2)/(s·sin30))/2 + 6` around the focus.

**Toon ramp:** a 4-texel `gradientMap` with steps `[96, 150, 205, 255]`, NearestFilter. Every solid is a `MeshToonMaterial`.

**Night**
- When the day runs out in a campaign battle, night falls; dawn comes 70 s later.
- `night` eases toward 1 at rate `dt·0.7`; dawn eases back at 0.9.
- The darkness is done entirely in CELL_FS: a blue moonlight tint multiplied over the picture, with warm, banded, elliptical pools around lights.

**Lights** (a world point with a reach in tiles, converted to art px by the zoom, and a strength)

| light | reach r (tiles) | strength s |
|---|---|---|
| torch flame | 2.6 | 1 |
| burning house | 1.5 → 4, growing over 6 s | 1.15 |
| smouldering ruin | 1.3 | 0.6 |
| camp, shrine, wagons or hall fire | 2.2 | 0.9 |

- Sort lights nearest the screen centre first and cap them by tier: 48, 24 or 12.

**Torches**
- Each squad's leader carries one in his left hand, with his shield slung on his back.
- The warband lights them in order along the line, at 0.7 s + 0.45 s × index after nightfall. The enemy lights all of theirs together at 2.4 s.
- The flame is a box 0.07×0.11×0.07 × FIG, flickering `0.8 + 0.35|sin(13t + id·1.7)|`.
- The flame cycles through `#d84a1c #f07a22 #ffb23a #ffe07a`.

**Fog of war, baked into every material** (a shader patch on every material)
- Three levels, Bayer-dithered between them:

  | level | meaning | colour |
  |---|---|---|
  | 2 | in sight | as it is |
  | 1 | seen before ("dusk") | `greyed(c,0.18)*0.8 + (0,.008,.03)` |
  | 0 | never seen ("night") | `greyed(c,0.3)*0.58 + (.01,.016,.045)` |

- **"The land is known, the enemy is not."** Never-seen ground is dim but never black. Enemy units are simply hidden outside sight.
- **Past the map edge:** use the dusk colour ×1.04, fading to `uHaze` by `far²` (with `far = dist/17` tiles) in 4 dithered steps.
- Draw 18 tiles of country past every edge, so there is never a black void.

## 4. Palette

### Teams, dark → light
- [0] darkest
- [1] capes, roofs, hoods
- [2] tunics, saddle cloths, pennants
- [3] rank plume, routing tunic, selection ring

| | [0] | [1] | [2] | [3] |
|---|---|---|---|---|
| Player (blue) | #12324a | #1f5a80 | #3a8dbd | #78c5e6 |
| Enemy (red) | #4a1614 | #86281f | #c64833 | #ef8e70 |
| Neutral | #6e6655 | #a89f86 | #d8cfb4 | |

### Heraldry ramps
- Blue: `#153a5c #1f5a8e #2f78b8 #6fb0e0`.
- Red: `#4a1614 #86281f #b83a2b #e8765c`.
- Device (emblem): **cream `#f3ecd8`**.
- Kind mark: `0.6 × device + 0.4 × ramp[3]`.
- Freed (linen) banner: `#6b5a40 #a8946c #d2c29c #ece2c6`, device `#a8741e`.

### Gold means honour and choice
`#e8c34a`, with dark gold `#9a7a2a`. It is used for:
- the captain's banner border and emblem
- rank-3 plumes
- banner chevrons, which pulse toward `#fffbe8` while a rank is previewed
- cloak clasps `#d8b24a`
- the captain's ring
- "take this place" order lines
- the captain's dot in a formation preview

### Mark colours
| use | colour |
|---|---|
| ink | `#16120f` |
| cream line | `#f1ead6` |
| attack red | `#e0533f` |
| archers in a plan | `#9fd36a` |
| withdraw line | `#f3a08a` |
| honour ribbons (alternating) | cream `#f3ecd8`, red `#d8463a` |

### Men
| part | colours |
|---|---|
| skin | `#dcae82` |
| mail | `#8d949c` |
| steel | `#a3abb3` |
| wood | `#7a5634` |
| iron | `#5c6066` |
| gold | `#d8b24a` |
| villager smocks | `#c9b48a #a89a7a #8d8a6a #b59a74 #9c8466` |
| hair | `#4a3020 #6b4a2a #2e241c #8a6a3a #5a4a3a` |
| horse coats (bay, dark bay, chestnut, black, grey, dun) | `#8a5632 #6e4426 #a8642e #3e342c #b4ada2 #bc9c68` |
| general's charger | grey `#c9c3b6` (player), black `#36302b` (enemy) |
| captain's helmet | `#e8c34a` |
| captain's plume | red `#d8463a` |

### Terrain: the meadow (the default land)
Ramps run dark → light and are dithered between steps.

| Ramp | Colours |
|---|---|
| grass | #3b5e26 #4b742c #5d8a33 #71a03b #88b347 |
| dry | #667a30 #7f923a #9aa845 #b5ba55 |
| dirt/bare (roads) | #6a4f30 #86663f #a07f50 #b99863 |
| moss | #294a22 #335a27 #3f6a2c #4c7a30 |
| rock | #3c3834 #524c46 #6b645b #878073 #a39b8c |
| wheat | #8d7432 #b39540 #cfb055 #e0c66e |
| plough | #4f3a27 #654a31 #7b5c3d |
| snow | #9eb0cc … #fafcff |
| flowers | #ead35a #f1ece0 #6f93db #e2a2bc #d65a46 |
| leaves | #2f5e24 #3a6e28 #46802e #548f34 #63a03a |
| needles | #1f4428 #25502c #2c5a32 |
| stones | #5a544d #6b645b #7d766b #8e877a (moss coat #5c8038) |
| water shallows | rgb(0.3, 0.52, 0.58) |
| building STONE | #4b443b #6c6356 #8e8477 #b0a693 #d0c7b2 |
| building THATCH | #6f5829 #977b3c #bf9e55 |
| building WOOD | #35231a #56391f #7a5634 |

Other lands are the meadow with some ramps overridden. For example, an alpine grass of `#4a6038…#98b470`, or a dry/Egyptian grass of `#9c7e38…#e0c876`.

**The readability rule**
- The environment has a limited value range and low saturation.
- Units have a wide value range and high saturation.
- The faction colour is the most saturated thing on screen.
- The weapon says the role.
- Roads are the highest-contrast terrain.

### Material tricks
- **Foliage:** a world-fixed speckle from a `floor(worldPos·11)` hash. Above 0.82, ×1.22; below 0.18, ×0.84.
- **Stone:** moss on faces whose normal points up, `smoothstep(.5,.85,up)`.
- **Roofs:** banded ×0.8 wherever `fract(y·8) < 0.28` (shingle rows).

### Ground texture
- Painted on the CPU into an RGBA texture at **12 texels per tile**, NearestFilter.
- Ramp steps are chosen per texel with the Bayer 4×4 dither.
- Texel-level details:
  - tufts (a dark root and a light blade in a 3×3 cell)
  - flowers in 2×2 cells
  - worn verges
- Warp terrain edges so shores and wood edges wander about ⅓ tile instead of stair-stepping.
- The terrain mesh samples the heights every 0.5 tiles. Water sits at y = −0.22.
- Trees are instanced from three shapes: a 0.11-wide box trunk, an icosahedron (detail 0) crown, and a 7-sided cone tier.

## 5. How a soldier is built

### Approach
- **One `InstancedMesh` per body part, shared by every figure.** For example, every man's leg is one InstancedMesh, every horse head another, every cloak another.
- **Posing:** each frame, every visible man is posed procedurally. Compose the joint matrices and write them straight into the instance buffers.
- **No skeletal meshes, no animation files.** The only keyframes are tiny inline tables for weapon blows.
- **Colour:**
  - The instance colour is the dye.
  - Each piece of a merged part's geometry is vertex-painted either `shade(k)` (multiplying the dye; k < 1 for hems, cuffs and boots) or a fixed hex (steel, wood), which is drawn with a white instance colour.
  - So one tunic mesh serves both teams.
- **Hit flash:** for 0.1 s after a hit, the man's dye colours become `#ffffff`.
- **Petrified:** every part lerps to a cool grey of the same lightness.
- **Materials:** all parts are MeshToonMaterial with the 4-step ramp and the fog patch. Cloth parts add a vertex-shader bend.
- **Performance:** create parts lazily, grow buffers by doubling, and upload only the instance ranges that changed.

### Scale
- The figure scale is `FIG = 1.32` (part units → tiles). A commander is ×1.16 and a mounted general ×1.08.
- **"The soldiers are the subject of the picture, about half the height of a tree."** Men stand 0.72 tiles apart.
- Part units, before FIG:

  | part | size |
  |---|---|
  | hip | 0.2 |
  | shoulder height | 0.232 |
  | shoulder half-width | 0.128 |
  | neck | 0.25 |
  | upper arm | 0.11 |
  | forearm | 0.118 |
  | head radius | ≈ 0.064 |

- **A standing man is ≈ 0.55 tiles tall.** That is about 9–12 art px at the default zoom of 16–19, and about 19 px at zoom 34.

### Parts
The primitives are `round` (tapered cylinder), `ball` (ellipsoid), `rod`, `cone`, `shell`, `drape` and `strip`.

**Body**
- **Leg:** a cylinder 0.13 long, a boot at shade 0.55, and a toe ball.
- **Skirt:** a flared cylinder r 0.125 → 0.088, squeezed to 0.78 in x, with a hem band at shade 0.7.
- **Torso:** a cylinder r 0.093 → 0.108, h 0.19, with:
  - a shoulder ellipsoid
  - a front panel at shade 1.15
  - a collar at shade 0.72
  - a belt and pouch
- **Arms:** a ball shoulder, a cylinder upper arm, a forearm with a cuff at shade 0.72, and a hand sphere r 0.029.

**Head**
- A sphere r 0.064 narrowing to the jaw, with nose and ears.
- Face (eyes and mouth at shade 0.22 and 0.5) and brows are drawn **only at zoom ≥ 28**.
- Hair is a ball. There are five beard types (full, short, moustache, forked, pointed), chosen by `id % 7`.

**Headgear**
- Kettle hat, nasal helm, mail coif, pointed hood with mantle, soft cap.
- Plume: a cylinder plus a ball.
- Each people adds more: montefortino, attic and boeotian helmets, wolf pelt, gallic hair, crests.

**Cloak**
- A `drape` with 7 folds deepening toward the hem, lined at shade 0.62, with a collar, a dark hem band and two gold clasps.
- Length 0.3. It is cloth and bends in the shader.

**Gear (fixed colours)**
| item | build |
|---|---|
| spear | shaft 1.0, leaf head `#e7eaec` |
| sword | blade `#d8dde2`, cross `#8a9096` |
| bow | a torus arc, string `#d8d0b8` |
| arrow | red `#c44a34` fletch |
| lance | with a pennant |
| heater shield | an extruded back `#6a4a30` with an iron boss, and a face card from the shield atlas |
| others | pitchfork, quiver |

**Horse**
- Body: a capsule barrel r 0.095 with chest, croup, shoulder and haunch balls, and a girth at shade 0.3.
- Neck with a mane tuft row. Head with ears, forelock and a muzzle at shade 0.55.
- Legs: upper and lower leg with a knee or hock, and a dark hoof.
- Tail: cloth, length 0.27, colour coat × 0.32.
- Saddle cloth in team [2], saddle `#5a3a22`, and reins `#3a2618` from the rider's left hand.

**Minimum thickness and detail**
- Thin things (shafts, blades, strings, reins) are thickened so they are never under 1 art pixel across.
- Shield devices are drawn only at zoom 34.

### Kinds (first campaign)
| Kind | Body | Head | Gear |
|---|---|---|---|
| spear | team [2] | steel kettle hat | spear |
| shield | team [2] tabard over mail sleeves and skirt, hose `#4e4a46` | coif + nasal helm | sword + heater shield |
| archer | team [2], undyed sleeves `#8a6e4e` | hood and mantle in team [1] | bow, quiver |
| captain | team [3] | gold kettle hat, red plume | hose in team [0], cape |
| levy (the freed) | own village smock until "dyed" in your colours | none, then a cap at rank 1, then a steel helm | pitchfork |

- **Folk** (the civilians):
  - a smock and a bundle on the back
  - 1 in 4 is a child, at ×0.72 scale
  - women wear gowns and kerchiefs

### Rank marks
| rank | mark on the men |
|---|---|
| 1 | a plume in team [3] |
| 2 | a cape in team [1] |
| 3 | a gold plume |

On the banner, gold chevrons pop in (up to 3), and the banner gains one honour ribbon per battle survived.

### Peoples
An `Outfit` describes how a people dresses:
- body, sleeves and skirt, each one of `team`, `mail`, `skin`, `home` or a hex
- hem
- legs
- armour: linen, muscle, pectoral, discs, plate or bell
- head, crest
- shield, weapon, sidearm
- **its own skin and hair palettes, picked by `id % n`**

Skin palettes:

| people | skin |
|---|---|
| Africa | `#94603c…#5e3a22` |
| Iberia | `#ca9a68…` |
| Italy | `#d8aa7a…` |
| Gaul | `#f2caa4…` |

Gaulish hair runs red to straw: `#a04a22 #c89a52…`.

Example outfits:
- **Iberian:** a white `#eee8da` tunic with a crimson `#9a1a2a` hem, a falcata and an oval shield.
- **Gaul:** bare-chested, in checked trousers `#5a6e3a #8a5a2e #4a5272 #7a3a2a #6a5a3a`, with a long sword.
- **Roman hastatus:** a bronze montefortino helmet with feathers, a scutum and a gladius.
- **Knight:** a great helm and a barded horse.

Weapon pose families:
- two-handed spear
- overhand spear over a shield
- sword or axe blow
- javelin throw
- sling whirl
- crossbow (shoot, lower, span)
- polearm chop
- bow
- lance

### Animation (all procedural)
**Stride**
- `phase += speed·dt·stride`; stride is 3.6 on foot, 2.4 mounted, 3 for beasts.
- `swing = sin(phase)·min(0.7, 0.25 + 0.3·speed)` when speed > 0.2.
- Legs rotate ±swing.
- Arms counter-swing: `th = ∓swing·0.8`, `bend = 0.2 + max(0,∓swing)·0.6`.
- **No vertical bob.** On the pixel grid it made men hop a pixel every step.

**Stand:** the man is perfectly still, with no breathing.

**Strike:** a pulse `sin(strikeT/0.25·π)` adds a lean of `strike·0.18`.

**Blows** are small keyframe tables with smoothstep between keys:
- **Sword (0.3 s):** keys (t, shoulder, elbow, blade) are rest → (0.4, 2.9, 0.6, 0.9) → (0.62, 1.1, 0.15, −1.9) → rest.
  - Guard rest: (0.35, 1.0, −0.6).
  - Carried low: (0.05, 0.3, −2.4).
- **Spear thrust (0.5 s):** draw back to −0.3 in the first 20%, drive to 1 by 40%, then ease back. The body lunges 0.06·FIG.
- **Crossbow:** 1.1 s. **Polearm chop:** 0.6 s.

**Stances**
- **Spear:** hip −0.3, left foot leading.
- **Archer:** side-on (hip −0.5, turn −0.8). The bow arm reaches toward the target by two-bone IK, and the string hand is anchored at the cheek.

**Rout:** arms flail (`th = 0.3 ∓ swing·1.8, bend 1.1`), lean 0.2, and no weapon or cloak is drawn.

**Death:**
- Topple over 0.35 s: roll `fall·π/2·side·0.92`.
- Lie face-down with arms out. A horse rolls onto its side.
- **Corpses stay for the whole battle.**

**Horse gait**
- Diagonal-pair legs: `amp = min(0.55, 0.18 + 0.22·speed)`, with knee and hock folding `1.3·max(0,cos ph)`.
- Gallop rise `(1−cos 3·phase)·0.016`; head nod `sin(1.5·phase)·0.1`.

**Smoothing**
- The drawn position eases toward the simulation's by `1 − exp(−16dt)`.
- Turning is capped at 7 rad/s for men; beasts turn slower.

**Cloth** (vertex shader, with a per-instance `aCloth = (wind 0..1, phase, length)`)
- **Hanging** (capes, scarves, tails):
  - `bend(s) = −flow·(0.3+0.95s) − 0.05s + (0.07+0.2·flow+0.05·gust)·s·sin(t·(2.4+3.6flow) − 4.6s + 13z + phase)`
  - Walk 6 segments down the cloth so it keeps its length, and rotate the normals with the bend.
- **Flags:** `z += (0.22+0.4w)·u·sin(t·(5+4w) − 6.5u + ph)·len·0.35`.
- Wind = speed/1.6, capped at 1.

## 6. Banners and heraldry

### The banner texture
- Each banner is a **16×26 px gonfalon** in a texture atlas, with a swallowtail notch cut into the bottom 5 rows.
- Borders:
  - the outer pixel is ramp[0], or dark gold on the captain's banner
  - the fold row is ramp[3]
  - the last 3 columns are ramp[1]
  - the captain's banner also has a gold inner border
- The **emblem** is a 7×9 pattern stamped at (4,4), in cream (gold for the captain).
- The **kind mark** (5–7 px wide) is centred at y = 15. The marks are spear, shield, bow, horseshoe and crown.
- Patterns are ASCII arrays, for example:
  `FLEUR = ['...#...','..###..','..###..','#.###.#','##.#.##','#..#..#','#######','..###..','.#...#.']`
- **Four tatter stages show men lost**, at lost/size < 0.2, < 0.6, < 1.2, and beyond:
  - the tail is eaten
  - the fly is torn
  - holes are punched beside the device, never through it
  - grime ×(.72, .68, .62)

### Pole and behaviour
- Pole `#35231a`, crossbar `#56391f`.
- Height 1.6 tiles (the captain's 1.95, beasts' +0.8). ×1.3 when selected, ×1.1 on hover.
- **It grows when zoomed out:** `grow = clamp(18/px_per_tile, 1, 2.4)`, so companies stay readable from far away.
- **It shows morale:**
  - it leans as heart drops, `lean = (0.55 − heart)/0.3`
  - it shakes when near breaking, `sin(23t)·0.08`
  - it is hidden while the squad routs
  - it unfurls when a squad is first given a banner
- Push the cloth 0.06 tiles out from the pole's plane so the pole doesn't cut through the device.

### Shields, atlas and devices
- **Shield atlas:** 12×14 px per side. A heater shape with two-tone halves (ramp[2] and ramp[1]), an edge in ramp[0], and a 5×5 device.
- **Atlas material:** toon shading, `alphaTest 0.5`, double-sided, with a per-instance `aTile` that remaps the UVs.
- **Devices:** each empire has one (fleur, tower, Tanit, eagle, raven, owl, dragon, eye of Horus, naga…), plus an alternate for when two sides share an empire.

### Graves on the road
- **Cairns:** 3 dodecahedra, in `#7d766b` and `#9a9384`.
- **Dead squads' banners** are planted askew, with their ribbons.

## 7. Marks on the field (the only "UI" in battle)

### How they are drawn
- Ground ribbons rebuilt every frame and draped over the terrain heights, lifted 0.05 tiles above land or water.
- Long segments are densified every 0.6 tiles so they follow the hills.
- **Transparency is dithering only:** discard the fragment if `alpha < bayer4(fragCoord)`.
- `depthWrite:false`, polygon offset −2/−4, renderOrder 2.
- They are drawn in the scene, so they get outlined and pixelated like everything else.
- **Every coloured line sits over a darker ink line (α .55 to .6)**, so it reads on any ground.

### Primitives
- `line`, optionally dashed [on, off] in tiles
- `head`, an arrowhead
- `ring`, starting at the screen top and going clockwise, optionally a partial arc
- `ellipse`, `disc`, `bar`

### What is drawn
| Mark | Look |
|---|---|
| Place capture ring | dashed [0.4, 0.3], width 0.07 (0.12 on hover), in the holder's light colour or neutral `#d8cfb4`; a solid arc 0.16 wide shows the capture progress |
| Selected company | an ellipse fitted to the formation: ink `#16120f` 0.26 wide at α .55 under team [3] 0.12 wide; the radius breathes ±2.5% at 5 rad/s; it blinks before the selection lapses |
| Drawing a front | ink 0.3 under cream `#f1ead6` 0.16 |
| Front preview ("ghost bars") | one bar per squad, 0.22 wide; length = files × file gap (spear and shield 3, horse 2.2, elephant 4.2); a 0.35-long nub toward the facing |
| Preview colours | blue team [3]; archers `#9fd36a`; horse in gold; the captain a gold disc r 0.3 |
| Drag route | ink 0.24 under a dashed 0.12 line, with an arrowhead of 0.6 |
| Route colour | enemy `#e0533f` with a ring r 1.9; place gold; the captain's own route gold; otherwise cream |
| Order given | lines that fade; rings that close in (pings) |
| Order refused | a red X |
| Paused | every squad's order is drawn |
| Detached company | a faint dotted line to its order flag |

## 8. Quality tiers
| Tier | Shadow map | Canvas | Night lights |
|---|---|---|---|
| high | 2048 | device pixels | 48 |
| mid | 1024 | device pixels | 24 |
| low | 512 | CSS pixels (no sub-pixel pan) | 12 |

**Picking a tier by GPU name**
- Low:
  - software renderers
  - Mali-4xx, Mali-T, G31 and G51
  - Adreno below 510
  - PowerVR SGX and Rogue
  - Vivante, VideoCore
- Mid:
  - Adreno 510–613
  - Mali G52, G57 and G71–76
  - PowerVR GM and BXM

**Other rules**
- **Memory:** 2 GB or less gets low.
- **Override:** `?tier=` forces a tier.
- **Governor:** in battle only, judge 2-second windows. If 10% or more of frames take over 40 ms, step down one tier and never step back up.

**Design choices made for speed**
- Post effects run at art resolution, not screen resolution.
- No depth buffer on the canvas.
- One instanced mesh per body part.
- Face and shield detail depend on zoom.
- Hard shadows.
- Cheap toon shading.

**Known limit:** the heavy battle was triangle-bound, at 1.5 M triangles (630 k of them in the shadow map). The next levers would be lower-detail figures far away and fewer shadow casters.

## 9. Rules of the look
- **Pixel art made from 3D.** "One small picture, scaled up with hard edges… outlines anything standing in front of what is behind it in a darker shade of itself."
- **Never shimmer.** Snap the camera and every figure to the art-pixel grid. No bob. Nothing thinner than 1 px. Faces only from zoom 28. The owner had said: "I see the units flickering at certain zoom distances."
- **See-through only by dither.** Never alpha blending.
- **No HUD; everything diegetic.** Gone: the command bar, squad cards, minimap, feed, letters over squads, fight bars, the clock. In their place:
  - banners show morale by lean and shake, and kind by their mark
  - rank shows on the men and the banner
  - words rise in the world
  - a place's flag climbs its pole as it is taken
  - roofs take the holder's colour
  - a red screen edge means the captain is hurt
  - the light is the clock
  - pause greys the world and draws every order
- **Target mood:** "a pixel-art diorama of greens and earth, the warband in blue with a cream fleur-de-lis, the enemy in red, and gold for honour and for choices." Tone: "wool, iron, earth and smoke, under light that moves with the time of day."
- **Round, not boxy.** Figures are smooth cylinders and ellipsoids under the toon ramp. Buildings stay faceted: flat-shaded prisms, one light step per slope.
- **Fog keeps the land bright.** Out of sight is dimmed to dusk; never-seen ground is dimmer but never black.
- **Each people looks like who they were:** their own skin and hair ranges, dress, and buildings.

## 10. Tooling worth rebuilding on day one
**A "units lab" page.** It shows every unit kind at the game's own pixel size and light, with:
- pose switches: stand, march, fight, rout
- side and rank switches
- zoom
- a sub-pixel drift, to catch flicker

Drive it from `window.__lab` so an agent can take screenshots and compare.
