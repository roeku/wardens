# Landscape, terrain generation and structures

## 1. Map model
- **Tile grid.** `BattleMap { w, h, tiles: Uint8Array, sites, deploy[2], retreat[2], river: number[], heights: Float32Array, hills, roads?, ford?, farms?, scape?, scapes? }`.
- **Tile enum.**

  | value | tile | effect |
  |---|---|---|
  | 0 | Open | normal |
  | 1 | Forest | passable at 0.7 speed |
  | 2 | Rock | impassable |
  | 3 | Water | impassable |
  | 4 | Road | a road or a ford; full speed and a cheaper path cost |

- **Sizes.** Width is one of `[48, 64, 80]`, always 16:9, so `H = round(W*9/16)` is 27, 36 or 45.
- **Width from army size.** `mapSizeFor(squads)` gives 80 for 8 or more squads, 64 for 5 to 7, and 48 otherwise. `?map=` forces a width.
- **Area factor.** `area = W*H/(48*27)`, which is 1, ~1.78 or ~2.78. Terrain and site counts scale with it.
- **Coordinates.** The simulation uses x east and y south, in tiles, and a tile centre is `(tx+0.5, ty+0.5)`. In three.js, world x = sim x, world z = sim y, and y is up.
- **Heights.**
  - Sampled every **0.5 tiles**: `(w/0.5+1) × (h/0.5+1)` samples, row-major from the north, in tiles.
  - The water surface is at `WATER_Y = -0.22` below the land's mean.
  - Read heights with bilinear interpolation.
- **Heights change the rules:**

  | effect | per tile of height | cap |
  |---|---|---|
  | archer range | +1.2 tiles | +2 |
  | melee damage | +25% | +35% |
  | sight | +1.5 tiles | +3 |
  | climbing pace | −0.4 × slope | never below 0.6 of pace |

  There is **no** downhill speed bonus. A bonus of 0.15 made a mindless charge win 85% of battles.
- **Pathfinding.**
  - 8-connected A* with no corner cutting.
  - Step cost ×1.45 in forest and ×0.85 on road.
  - Octile heuristic; ties break on tile index (for determinism).
  - The path is string-pulled with a 0.35-step line-of-walk test.

## 2. Determinism and noise
- **`Rng`:** xorshift32 (13,17,5). A zero seed becomes `0x9e3779b9`. Use it only for map generation.
- **`hash32(a,b,c)`:** a Murmur3/SplitMix finaliser built from `Math.imul`.
  ```
  h=(a^0x9e3779b9)>>>0; h=imul(h^(h>>>16),0x85ebca6b)>>>0;
  h=(h^imul(b+0x165667b1,0xc2b2ae35))>>>0; h=imul(h^(h>>>13),0xc2b2ae35)>>>0;
  h=(h^imul(c+0x27d4eb2f,0x85ebca6b))>>>0; h=imul(h^(h>>>16),0x2545f491)>>>0;
  return (h^(h>>>15))>>>0
  ```
  Divide by 2^32 to get [0,1).
- **Value noise.**
  - The lattice value is `hash32(seed, i*374761 + j*668265, salt)/2^32`.
  - Blend with smoothstep `t*t*(3-2t)` and bilinear interpolation.
  - `fbm`: 4 octaves; amplitude ×0.5 and frequency ×2.03 per octave; octave o is salted `salt + o*17`; normalised to 0..1.
- **Per-point jitter:** `jit(seed,x,y,salt) = hash32(seed, x*131 + y*7919, salt)/2^32`.
- **Retries.** Each map tries the seed `seed*7919 + attempt`, up to 80 attempts. An attempt fails if a site is unreachable or two sites' rings overlap.
- **Relief has its own stream**, `Rng((seed*92821+13)>>>0)`, so adding relief never moves the layout.

## 3. Terrain generation (the rules map)

### 3a. Assault map (a keep or a town)
1. **Keep.** Place it at `x = W-5.5`, `y = floor(H*0.26 + r*H*0.46) + 0.5`. The attacker deploys at `(4, H/2)`.
2. **Blob helper.** A tile is inside an ellipse when `((x+.5-cx)/rx)² + ((y+.5-cy)/ry)² <= 1 + (r-0.5)*0.35`. The random term makes the edges ragged.
3. **River** (probability 0.55):
   - It starts at x = `floor(W*0.42 + r*W*0.11)`.
   - Each row, with probability 0.3, it drifts ±1, clamped to `[0.375W, 0.58W]`.
   - It is **2 tiles wide**.
   - Fords: 2 if H < 30, 3 if H < 40, else 4. Ford i sits at row `floor((i+0.15+r*0.7)*H/nFords)`, and the rows ±1 around it become Road, so each ford is 3 rows deep.
4. **Rocks.** `round((3+r*3)*area)` blobs, at x `0.21W + r*0.58W` and y `2 + r*(H-4)`, with rx `1.2 + r*2.2` and ry `1 + r*2`.
5. **Forests.** `round((2+r*3)*area)` blobs, at x `0.17W + r*0.66W`, with rx `2 + r*3` and ry `1.5 + r*2.5`.
6. **Clearings.**
   - Clear columns x < 7, the deploy zone.
   - Clear rock, water and forest within radius 4 of the keep (4.6 for a town).
7. **Sites.**
   - **Villages:** `max(1, round(area))` pairs. One of each pair goes near the top (y `0.1H` to `0.3H`) and one near the bottom (y `0.7H` to `0.9H`), in x bands starting at `0.26W` and spanning `0.3W`. They start neutral.
   - **Shrines:** 1, or 2 when area ≥ 2, at x `0.55W` to `0.70W`.
   - **Towers:** 1, or 2 when area ≥ 1.5, at x `0.66W` to `0.80W` on the flanks.
   - Every site snaps to a tile centre with y in [2, H-3] and clears radius 2.2 around itself.
   - Reject a site that falls within 5.5 of another (6.8 of a town).
   - Shrines and towers start owned by the defender.
8. **Reachability.** Every site must be reachable from the attacker's deploy point. Then add relief (3d).

### 3b. Ford map (a river crossing to protect)
- **River.**
  - It starts at x `0.47W + r*0.06W`, clamped to `[0.42W, 0.56W]`.
  - It does not drift within ±1 row of the ford.
- **Fords.**
  - The main ford is at `fordY = 0.36H + r*0.28H`, 3 rows deep.
  - A second, 1-row narrow ford sits near the top or bottom.
- **Rocks and forests.** `(3+r*3)*area` of each, never on water or the fords.
- **Clearings.** Clear rock and forest:
  - within 2 tiles of the road (east entry → ford → west exit)
  - within 1.6 tiles of the far route
  - at x < 2
  - within 4.5 of the deploy point
  - within 5 of the entry
- **Roads.** Find the routes with A*, giving `m.roads = [route, route2]`.
- **Farms.** Up to `round(3*area)` farms, each at least 4 tiles from any route.

### 3c. Open field (a symmetric skirmish)
- Generate only the west half:
  - rocks `(1+2r)*area`
  - forests `(2+2r)*area`
  - clear x < 8
- Mirror the west half to make the east half.
- **Hills** come in mirrored pairs (r 3.4 to 5.8, h 0.8 to 1.5), plus an optional hill in the centre. After relief, average every height with its mirror.
- **Road.** A gentle curved road at `mid → mid+2 → mid+3 → mid+2 → mid`.
- **Farms** come in mirrored pairs.

### 3d. Relief (heights)
1. **Hills.**
   - Aim for `max(1, round(1.6*area))` hills, with up to 80 tries.
   - Centre: x `0.18W + r*0.62W`, y `0.14H + r*0.72H`. Radius `rad = 3.6 + r*2.8`, height `h = 0.95 + r*0.75`.
   - Reject a hill if:
     - `x - rad < 7`
     - it is within `rad + 2.5` of the main site
     - it is within `rad*0.8` of any river tile
     - it overlaps another hill
2. **Smoothed tile masks.**
   - Use a cone kernel, `max(0, 1 - d/(r+0.5))`, sampled bilinearly.
   - Radii: water 1.2, ford 1, rock 0.8, wood 1.5.
3. **Raw height:**
   ```
   h  = (fbm(seed+1, x*.06, y*.06, 1) - .5) * .5
   h += Σ hill.h * (1-t²)²   for t = dist/hill.r < 1
   if rock > .15: h += (rock - .15) * (2.3 + fbm(seed+4, x*.5, y*.5, 4) * 1.4)   // crags
   h += wood * 0.12
   h -= min(1, water*1.6) * 0.75 + ford * 0.2
   if ford > .45: h = min(h, WATER_Y - .05)
   if water < .02 && ford < .02: h = max(h, WATER_Y + .08)
   ```
4. **Level pads under sites.**
   - Pad radius: keep 3.4, town 3.6, village 2.6, other sites 2.
   - Blend from the pad to the raw height over 1.5 tiles with a smoothstep.

## 4. The land's dressing (visual only, never the rules)

### Bounds, texture and lands
- **Bounds.**
  - `BORDER = 18`: draw 18 tiles of scenery past every edge, so there is never a void.
  - `TEX = 12`: paint 12 texels per tile. A 48×27 map paints 1008×756 texels.
- **Lands (biomes).**
  - Each place on the road has its own land, and lands blend where two meet.
  - Look up the nearest land on a half-tile grid, domain-warped by `(noise(seed, x*.2, y*.2, 81|82) - .5)*7`.
  - The next-nearest different land gets `share = max(0, 0.5 - (d2-d1)/9)`.
  - Per texel, use the second land wherever the Bayer value is below `share`, so the border stipples instead of seaming.

### Outside the map
- **River:** it continues past the north and south edges, wandering ±2.
- **Lakes:** where `fbm(seed+12, x/10, y/10) > beyond.lake`, more than 3 tiles out.
- **Pools:** where `fbm(seed+13, x/3.5, y/3.5) > beyond.pools`, more than 2.5 tiles out.
- **Forest:** where `fbm(seed+3, x/7, y/7) > beyond.wood - min(.12, out*.01)`.
- **Rock:** where `fbm(seed+9, x/5, y/5) > beyond.rock`.
- **Heights:**
  - a base of `(fbm(seed+1, ·0.06) - .5)*.9`
  - plus rising ground: `min(cap, out*rise) * side * (0.6 + fbm(seed+2, ·0.1)*.8)`, where `side` is a per-edge N/E/S/W weight
  - plus peaks: `peak * ridge² * min(1, out/9) * side`, with `ridge = 1 - |2*noise(seed, ·0.16) - 1|`
- **The seam:** inside the map, use the rules' heights exactly. Blend to the outside heights over 2 tiles with a smoothstep.

### Roads
- If the map supplies roads, densify them to 0.5-tile steps.
- Otherwise build them:
  1. A main road runs from the west edge at the deploy row, through the sites in order of x, to the keep.
  2. The other sites get spurs to the nearest node on the main road.
  3. A last road runs from the keep off the east edge.
- Smooth each road by 6 passes toward its neighbour midpoints (factor 0.5), never onto water or rock.

### Fields
- **Where:** around villages, towns and `m.farms`, plus a jittered grid every 7 tiles weighted by the land's `farmland`.
- **Count:** `round(7*scape.farm)` tries per farmed point.
- **Each field:**
  - angle at random; distance `2.8 (+1.6 for a town) + r*3.5`
  - size `1.6 to 3.8 × 1.4 to 3.4` tiles
  - crop: wheat, barley, ploughed or meadow, with rows along x or y
- **Rules:**
  - on Open tiles only
  - at least 0.9 from a road and 1.7 from a site
  - no overlapping another field within 0.4
- Place 14 more fields beyond the map.

### Ground painting (per texel)
- **Classes:** Grass, Forest, Rock, Water, Ford, Road, Field, Yard.
- **Edge warp:** look tiles up through a domain warp of `(noise(seed, 1.7x, 1.7y) - .5)*.7`, so edges wander about ⅓ of a tile.
- **Yard:** within `yardR` of a site, ±0.3 noise wobble. `yardR` is keep 2.6, town 3, village 1.9, other 1.2.
- **Road:** where the distance to the road's centre line is less than `.44 ± .08` noise.
- **Precompute noise grids** at quarter-tile resolution and sample them bilinearly:
  - patch `fbm(seed+5, .18)`
  - dry `fbm(seed+6, .09)`
  - meadow `fbm(seed+11, .22)`
  - snow, bare and bog only if some land in the map needs them
- **Choosing a colour:** pick it from a ramp by ordered dithering between two steps, with the Bayer 4×4 matrix `[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5]` used as `(v+.5)/16`.

**Grass**
- Ramp position `f = (patch - .28)*2.1 + (fine - .5)*.2`, plus 0.14 near a road.
- Use the `dry` ramp where `dryN > dryAt`, and bare earth where `bareN > bareAt`.
- Worn verges use `dirt[2]`.
- Tufts sit on a 3×3-texel cell grid, using `grass[4]` and `grass[0]`.
- Wildflowers sit on a 2×2 cell grid, with density `(meadow > .56 ? .05 + (meadow-.56)*.9 : .012) * scape.flowers`. A 4×4-tile patch keeps one flower colour, with a 25% chance of its neighbour's.
- Bog uses its own ramp, with puddles and reed pixels.
- Pebble shores appear near water, scree on steep slopes, and snow by height, noise and slope.

**Other classes**

| class | ramp | details |
|---|---|---|
| Forest floor | moss | |
| Rock | rock | a turf cap ramp on flat tops; crack lines where `\|noise(3.5x)-.5\| < .03` (×0.45); lichen speckles |
| Water bed | bed | |
| Ford | pebble | |
| Road | dirt | two darker ruts at 0.12 ± 0.04 from the centre, paler edges beyond 0.24 |
| Field | crop ramp | stripes alternating light 0.65 / dark 0.3 every 1/3.2 tile across the rows; a darker furrow at the edge |

### Scatter
- **Forest tiles:** `(2 inside / 3 outside) * thick` trees per tile.
  - Each tree is jittered within 0.1 to 0.9 of its tile, at scale `0.8 + r*0.5`.
  - The species comes from `woods[0]` where `fbm(seed+7, x/8, y/8) > .55`, else `woods[1]`.
- **Rock tiles:** 40% get a boulder, at scale 0.25 to 0.55.
- **Open grass:**
  - a lone tree with probability `lone[0]` (never at x < 7, never within 3 of a site)
  - otherwise a bush, at scale 0.2 to 0.4
  - otherwise a small stone, at scale 0.12 to 0.24
- **Field edges:** each side of a field gets a fence with probability 0.45. A side without a fence gets a hedge with probability 0.5: bushes every 0.45 tiles, or poplars every 0.8.
- **Haystacks:** 1 or 2 in each grain field.

## 5. Geometry and rendering
- **Terrain mesh.**
  - A `PlaneGeometry(W, H, hw-1, hh-1)` rotated −90° about X, with y set from the height samples and its UV on the painted texture.
  - Normals from `computeVertexNormals`.
  - A toon material, with the painted ground as its `map` (NearestFilter).
  - A "scar" overlay at 4 texels per tile, for trampled ground in the land's `trample` RGB and for blood.
- **Lights.** A `DirectionalLight` (2.3) and a `HemisphereLight` (0xffffff / 0x444444, 1.4). They follow the daylight table.
- **Water:** one flat quad per cell within 2 tiles of water, at `y = WATER_Y`, with a custom shader.
  - **Depth:** `WATER_Y − ground`, read from a half-float height texture. Discard where it is below −0.02.
  - **Colours:**
    - `shallow` = the land's water RGB
    - `mid = shallow*(.57,.65,.81)`
    - `deep = mid*mix((.59,.59,.68), (.86,.88,.92), deepParam)`
  - **Depth bands**, with dithered edges:

    | depth | colour |
    |---|---|
    | < 0.1 | `mix(bed, shallow, .72)` |
    | < 0.28 | shallow |
    | < 0.5 | mid |
    | deeper | deep |

  - **Foam:** (0.74, 0.83, 0.84) where depth < 0.022.
  - **Glints:** hashed 1/6-tile cells drifting with time, in (0.85, 0.93, 0.97).
- **Trees:** three instanced shapes. Trunk `Box(0.11,1,0.11)`; blob `Icosahedron(1,0)`; tier `Cone(1,1,7)`.

  | Kind | Build |
  |---|---|
  | oak | 5 blobs (two low, one broad middle, two small on top), crown r 0.36s, trunk 0.5s |
  | pine | 4 cone tiers, r 0.38s(1−0.2k), h 0.55s, step 0.3s, trunk 0.25s |
  | fir | 5 tiers, r 0.31s(1−0.17k), trunk 0.18s |
  | larch | 4 tiers, gold `0xa88a2c 0xc0a038 0xd6b848` |
  | olive | 3 flat blobs, thick trunk ×1.7, `0x56664a…0x8e9e78` |
  | cypress | 3 tall slim blobs, `0x1c3a26 0x244632 0x2c5238` |
  | umbrella pine | flat crown, trunk 0.62s |
  | poplar | 3 tall blobs |
  | birch | 3 small blobs, pale trunk `0xe6e2d6` |
  | palm | 6 frond slabs, trunk 0.86s |
  | willow | 4 broad blobs |

  - Trunk colours: oak and conifers `0x56391f`, olive `0x6d5f4c`, birch `0xe6e2d6`, cypress `0x3a2a1c`, palm `0x80603a`.
  - Foliage has a world-space speckle. Where the land has snow, conifer tiers get it on their upper part (`vTier > .44`, mixed .92 toward (0.9, 0.94, 1.0)).
- **Stones.** `Dodecahedron(1,0)` scaled (s, .7s, .9s), randomly rotated. Faces pointing up get the land's coat colour (moss, snow or dust) blended in by `smoothstep(.5,.85,up)*.85`.
- **Bushes.** `Icosahedron` scaled (1.2s, s, 1.2s).
- **Wooden fence.** Posts `Box(.05,.27,.05)` in `0x6a4a2e` every ~0.36 tiles, and two rails `Box(len,.028,.025)` in `0x86603a` at heights 0.11 and 0.21, following the slope.
- **Dry-stone wall.** `Box(len*1.05, .2*(0.8 to 1.3), .13)`, cycling `0x7a756a 0x8a8478 0x6c675d 0x9a9486`.
- **Haystack.** `Cone(.24,.34,7)` in `0xc9a24a`.

## 6. Lands (biome tables)
MEADOW is the base land; every other land overrides parts of it.

**MEADOW ramps, dark → light:**

| ramp | colours |
|---|---|
| grass | `#3b5e26 #4b742c #5d8a33 #71a03b #88b347` |
| dry | `#667a30 #7f923a #9aa845 #b5ba55` |
| bare/dirt | `#6a4f30 #86663f #a07f50 #b99863` |
| moss/cap | `#294a22 #335a27 #3f6a2c #4c7a30` |
| rock | `#3c3834 #524c46 #6b645b #878073 #a39b8c` |
| bed | `#3d4a3e #4d5a48 #5f6a52` |
| pebble | `#6e6a5c #8b8574 #a7a08b` |
| yard | `#6a5a42 #7f6d50 #948262 #a89674` |
| wheat | `#8d7432 #b39540 #cfb055 #e0c66e` |
| barley | `#7c8a3c #98a64a #b3bd5c` |
| plough | `#4f3a27 #654a31 #7b5c3d` |
| meadow | `#4f7a35 #618f3d #78a64a` |
| snow | `#9eb0cc #b8c6dc #d2dcea #e8eef6 #fafcff` |
| scree | `#4a4c52 … #92959a` |
| bog | `#34502a … #5c8640` |
| puddle | `#2f4a46 #3d5c56 #4f7066` |
| flowers | `#ead35a #f1ece0 #6f93db #e2a2bc #d65a46` |
| lichen | `#8e9a5a` |

**MEADOW parameters:**
- **Ground:** dryAt .6, bareAt 9 (never), flowers 1, tufts .16. No snow; scree and bog are off (9).
- **Farming:** farm 1, farmland 0.
- **Woods:**
  - woods `[[pine .8, oak .2], [pine .15, oak .85]]`, thick 1
  - lone trees: [.018, .05] of oak
- **Foliage:** leaf `0x2f5e24 0x3a6e28 0x46802e 0x548f34 0x63a03a`; needle `0x1f4428 0x25502c 0x2c5a32`.
- **Other:** coat `0x5c8038`; trample RGB [96,80,52]; water [.30,.52,.58], deep 0.
- **Beyond the map:** `{wood .6, rock .8, lake 9, pools 9, rise .14, cap 3.2, sides [1,1,1,1], peak 0}`.
- **Fences and buildings:** fence wood, hedge bush, buildings medieval.

**The other lands** (the folk and fort columns say which culture builds the villages and the forts):

| Land | Look | Key numbers | Folk / fort |
|---|---|---|---|
| moor | tawny grass `#5a5a38…#b2ab5f`, heather dry `#54445a…#997f8c` | dryAt .56, farm .35, pine/birch/oak, thick .5, water [.4,.44,.38] deep .5, beyond rise .2 cap 4.4 | stone walls; medieval |
| birch | light grass `#547a30…#acd061`, bluebells | flowers 1.8, birch .7/.55 | medieval |
| autumn | leaves `0x7a2f18 0x9a4318 0xb85a1c 0xd27c22 0xe4a636`, russet dry | dryAt .52, farmland .35 | medieval |
| marsh | bog .5, tufts .3, willows | farm .3, water [.42,.5,.38] deep .6 | medieval |
| iberia | ochre grass `#8e7236…#d8be7a`, red earth, olive/umbrella/cypress | bareAt .66, thick .6, coat `0xc8b07e`, water [.5,.54,.42] | stone walls; iberian |
| pyrenees | cold grass, grey rock | snow line 1.8 cover .25, scree .55, pine/fir/oak, beyond peaks 2 | iberian |
| rhone | lush `#3e6a2c…#8ac858`, poplar/willow | bog .5, farm 1.2, water [.46,.6,.52] | poplar hedges; gallic |
| alps | snow caps, scree | snow line .6 cover .52, fir/pine/larch, coat `0xe6edf6`, water [.56,.78,.8], beyond rise .55 cap 10 peak 4 | gallic |
| po | bright green `#4a7a30…#9cd860` | farm 1.6, farmland .9, flat | poplar hedges; gallic / roman |
| etruria | cypress/umbrella/olive | water [.42,.66,.70], lake beyond | roman |
| apulia | golden `#9c7e38…#e0c876` | farm 1.3, farmland .85 | stone walls; roman |
| hellas | thyme-gold `#8a7c3c…#d4c676`, limestone | olive/cypress, water [.22,.56,.72], peaks | greek |
| wei | loess `#7c8040…#c4bc6c` | pine/poplar/willow, water [.58,.56,.38] | qin |
| nile | Black Land green `#6a7e34…`, sand `#c0a068…` | palms, dryAt .34, water [.50,.52,.36] | egyptian |

**Choosing lands along the road:**
- **First campaign:** pick from `[meadow, moor, birch, autumn, marsh]` per stretch of the road. Never repeat the previous land, and never use one a third time. Home is meadow.
- **Hannibal:** follows geography: iberia → pyrenees/rhone → alps → po → etruria/apulia.

## 7. Structures

### Construction
- **Primitives:** `box`, `turned`, `roof(w,d,h,x,y,z,along)` (a gabled prism), `hip`, `pyramid`, `cone`, `cyl`, `frustum`, `ring` (a wall polygon around a circle with an optional gate gap), `column` (square foot, round shaft, capital) and `braced`.
- **One mesh per building.** Paint each piece's colour into its vertices, then merge all the pieces into one mesh drawn with a toon vertex-colour material.
- **The owned mesh.** The parts that show who holds a place (roofs, caps, cloth) are painted **white** into a separate mesh. Its material colour is set to the holder's colour:
  - player `0x1f5a80`
  - enemy `0x86281f`
  - nobody: the culture's neutral colour

  That mesh uses a "shingled" shader: sloped faces get ×0.8 bands where `fract(worldY*8) < .28`.
- **Palettes:**

  | name | colours |
  |---|---|
  | STONE | `0x4b443b 0x6c6356 0x8e8477 0xb0a693 0xd0c7b2` |
  | THATCH | `0x6f5829 0x977b3c 0xbf9e55` |
  | WOOD | `0x35231a 0x56391f 0x7a5634` |

- **Site kinds:** village, shrine, tower, keep, weir, camp, town, wagons, hall.
- **Which culture builds what.**
  - Keeps and towers use the land's `fort` culture.
  - Villages, towns, shrines and halls use the land's `folk` culture.
  - Camps and wagons are always medieval.
- **The place's flag.**
  - Pole `Box(.035, h, .035)` in WOOD[0]; flag `Box(.34,.2,.025)` in neutral or team [2].
  - **The flag climbs the pole as the place is held**, to `0.25 + 0.75*(0.35 + 0.65*|hold|)` of the pole's height.
  - It sways with `rotation.y = sin(t*2.2 + x)*.35 - .6`.
- **Flames.** An unlit box (`MeshBasicMaterial`) whose y-scale flickers as `0.8 + 0.4|sin(9t + y)|`.
  - Its colour shows the holder: enemy `0xff7a4a`, player `0x9fe3ff`, neutral `0xffc860`.
  - Camp, hall and wagon fires are always `0xffa040`.

### Medieval set (first campaign)
- **Half-timbered house.**
  - Plaster `0xe2d5b2` or `0xd8c7a0`, alternating.
  - Beams `0x3a2618`, 0.035 thick, at y = 0, 0.48h and the top, with posts at −½, 0 and +½ of the width.
  - **Only the two walls the camera sees (south and west) get timbers**, with diagonal braces in their lower panels.
  - Windows 0.12×0.11 in `0x2a2018`; door 0.16×0.3; an optional stone chimney.
  - Roof `roof(w+.18, d+.18, .52)`, owned. Walls are `0.58 + r*0.15` high.
- **Village.** Three houses around a green, at `[-0.8,-0.45, 0.9×0.7]`, `[0.55,-0.7, 0.7×0.9, rotated]` and `[0.35,0.75, 1.0×0.65]`.
  - Barrels, a crate, a well (a stone cylinder, two posts and a beam), and a haystack.
  - The neutral roof is thatch.
- **Keep.**
  - Curtain walls round a 3×3 yard (R 1.5), 0.9 high and 0.28 thick, with merlons.
  - 4 corner towers `cyl(.36, 1.35, 8)` under owned cones `(.46, .6)`.
  - A central hall `box(1.3,1.9,1.1)` under an owned roof, and a gate in the south wall.
  - Neutral `0x6b5a48`.
- **Tower.**
  - A plinth .95×.2 and a shaft .7×2.0×.7.
  - Corbel courses, a crenellated parapet, 4 corner piers.
  - An owned pyramid roof `(1.2, .55)` overhanging the parapet.
- **Shrine.** Two stepped slabs, a pillar .26×1.2 with a cap, four corner posts, and a flame on top.
- **Town (the village under the torch).**
  - A chapel .95×.62×.66.
  - A bell tower .42×1.55 with a 4-post belfry, a bell `0x8a6a2a` and a spire.
  - A well.
  - **Five separate houses**, each with its own walls mesh, roof mesh and a hidden ruin of three charred beams (`0x1c1612` / `0x241c16`). They stand at (−1.75,−1.0, .95×.7), (0.95,−1.8, .75×.95), (2.0,0.35, .7×1.0), (0.2,1.85, 1.05×.7) and (−1.9,1.1, .8×.75).
- **Wagons (the ford's refugees).**
  - Two covered wagons: bed .9×.16×.42 on 4 wheels of r .13, under canvas `0xe2d5b2`, turned ±0.3 to 0.4 rad.
  - A ring of 6 stones round a fire, and crates.
- **Camp.**
  - Four ridge tents `roof(.78,.62,.55)` in canvas `0xe2d5b2` / `0xcdbb91`, with poles.
  - A ring of 7 stones, crossed sticks, a cart, and a fire in the centre.
- **Hall of Banners.**
  - A long timbered house 2.5×1.05 with walls 0.8 high, under an owned roof `(2.75,1.3,.95)`.
  - A stone brazier with a fire, and door posts.

### Burning and falling
- **The burn.** Burn fraction = `(now − fired)/24 s`.
  - The roof lerps from its thatch colour to `0x2a221c` at `burnt*1.2`.
  - The walls tint by `(1−.35b, 1−.4b, 1−.42b)`.
- **When the house is lost:**
  - hide the roof and show the ruin beams
  - turn the walls `0x3a332e`
  - play `house_fall`
- **Fire VFX.**
  - **Flames:** 8 boxes `0.17 × 0.5*fl` over the roof, cycling `0xd84a1c 0xf07a22 0xffb23a 0xffe07a`, each flickering by `fl = (0.5 + 0.7|sin(t(6+0.7i) + 1.3i)|)*k`. k ramps up over 6 s.
  - **Smoke:** a particle every 0.1 s.
    - grey 0.26 to 0.46
    - rising at 0.42 to 0.77
    - life 3.4 to 5.2 s
    - 2 to 4 art pixels in size
    - drifting with a wind of `{x:.28, z:−.12}`
  - **Embers** rise too.
  - **Light:** the fire is a night light with reach `1.5 + 2.5k`.
- **Afterwards.** A fallen house smoulders for `24 + 50` s; a doused house smokes for 12 s.

### Other cultures (same primitives, different palettes)
- **Iberian** `{stone 0xb59a6c, dark 0x8f7650, light 0xcdb284, lime 0xe2d6b6, clay 0x9a7a54, beam 0x4a3322, door 0x2e2218, pot 0xa05a38}`:
  - Houses: stone or whitewashed, with a dark footing course and beam ends under the eaves. Flat, owned slab roofs with a lip, and a set-back upper storey on some.
  - Village: a stone pen, a threshing floor, jars.
  - Tower: two stepped stages with a beacon.
  - Keep: an oppidum. Low walls, terraced houses climbing to the north, a 3-storey palace with a canopy, and banners in the holder's colour.
  - Shrine: steles and a fire bowl.
- **Gallic** (daub `0xcdb98e`, straw `0xa88a44`):
  - Roundhouse: a stone footing, a 10-segment daub cylinder, 8 posts, a wattle band, and an owned thatch cone of pitch `0.52 + 0.22r`.
  - Village: a granary on stilts and a staked pen.
  - Town: a chief's great roundhouse and a carved painted post.
  - Tower: a timber tower on braced legs.
  - Keep: a hillfort. An earth ring and a 22-segment rampart with 46 stakes, a lintel gate, 4 watch platforms with pennants, and a great hall with painted shields.
  - Shrine: 6 standing stones round an altar fire.
- **Roman** `{plaster 0xe8dfc8, tile 0xb4623e, column 0xf0e8d4, brick 0xa8553a}`:
  - Houses: white plaster, a brick band, shutters, and a shallow tile roof (0.34).
  - Village: a villa with a 5-column portico.
  - Town: a temple on a podium.
  - Tower: an open gallery under a tile pyramid.
  - Keep: a castrum. A two-towered gate, an HQ and barracks.
  - Shrine: a small temple and altar.
- **Norse:**
  - Plank longhouses with bowed "hull" roofs of turf or shingle, and dragon heads on the halls.
  - Tower: a stave tower with a spire.
  - Keep: an octagonal palisade of pointed logs, with a boat in the yard.
  - Shrine: a ship setting of stones and a rune stone.
- **Greek:**
  - Whitewashed cubes with blue `0x2b68a3` doors, pantile or flat roofs, around a walled courtyard.
  - Town: a Doric temple and a stoa.
  - Tower: round, of limestone.
  - Keep: an acropolis on a two-tier crag.
  - Shrine: a tholos.
- **Qin:**
  - Layered rammed-earth houses with red `0x7a2c24` posts, under swept-corner grey-tile roofs `0x8b9096`.
  - Village: a granary on stilts and a well sweep.
  - Town: a two-tier pavilion and *que* gate pillars.
  - Keep: a walled Han town with a gate tower.
  - Shrine: a stepped altar with a *ding*.
- **Egyptian:**
  - Leaning mudbrick houses, limewashed `0xeee4cb` or bare `0xb98f5e`, with flat roofs.
  - Village: palms, a beehive granary and a shaduf.
  - Town: a temple with a pylon and an obelisk.
  - Keep: a migdol fortress.
  - Shrine: a pylon gate.
- **Khmer:**
  - Houses: timber on stilts, with bamboo walls and steep palm thatch `0xa9924f` with crossed ridge ends.
  - Town: a laterite `0xa8603c` prasat and a lotus pond.
  - Keep: a temple-mountain of three terraces with 5 prasats.
- **The rule for keeps:** in every culture, a keep shows its holder through **cloth** (banners, canopies, shields), not coloured caps. Neutral cloth is linen `0xcfc6ae`.

### Campaign props (things that remember)
- **Cairns.**
  - One per 3 fallen men, 2.5 to 5.5 tiles from the place they fell.
  - Each is 3 stacked dodecahedra (scale 0.13 − 0.03k) in `0x7d766b`, with a `0x9a9384` top.
- **Planted banners.**
  - One per company destroyed, in rows of 6 (0.9 apart, 1.1 between rows).
  - A pole 1.3 tall carries a 0.44×0.72 banner cloth and up to 6 honour ribbons, leaning ±0.15 rad.
- **Banners at the Hall.**
  - Planted in rows of 6, 0.8 apart, either side of the hall.
  - The fallen commanders' banners stand on one side, the enemy colours taken on the other.
  - At most 24 fallen and 12 enemy colours.

## 8. Fog of war
- **State:** one byte per tile per team: 0 never seen, 1 seen before, 2 in sight.
- **Every 8 ticks:**
  1. Demote every 2 to 1.
  2. Stamp circles of sight:
     - each squad: `(6.5 + hillSight) * (0.6 at night) + min(spread, 3)`
     - owned sites: towers 9, others 4, plus hillSight
     - burning houses: radius 4
     - with `hillSight = min(3, height*1.5)`
  3. At night, enemy squads are also visible within `spread + 0.8` because of their torches.
- **Drawing.**
  - A fog texture of one texel per tile, linearly filtered: 255 in sight, 128 seen, 0 never.
  - Every material reads it through a shader patch, with three dithered levels (see the look spec).
  - Enemies and corpses in tiles not in sight are not drawn.
- **The land is always known:** never-seen ground is dimmed, never black.

## 9. The road between battles, and the chart

### The road
- **Size.** `W = 2*8 + 23 (muster ground) + 13*6 (steps) + 2 = 119`, and `H = 40`.
- **Nodes.**
  - The Hall sits at (5.5, 20.5).
  - Places sit at `x = 8 + 3 + 23 + step*13 ± 1.5`, `y = H*(0.2 + 0.3*lane) ± 2`.
- **Links.** From the hall to every place in row 0. From each place to the next row's places within ±1 lane. Every place in the last row links to the keep.
- **Tiles.**
  - **River:** at `x = floor(W*.47 + (fbm(seed+5, y*.08) − .5)*10)`, 2 wide. It turns to a ford wherever a link crosses it.
  - **Kept open:** tiles within 4 of a place, within 1.8 of a link, or on the muster ground.
  - **Elsewhere:** blend the per-land `road` parameters with weight `exp(−d/2.5)`, then:
    - pond where `fbm > pools`
    - forest where `fbm(seed+1, x*.11, y*.11) > wood`
    - rock where `fbm(seed+2, x*.16, y*.16) > rock`
- **Site at each place, by kind:** start → hall, camp → camp, rich → village, village → town (burning), ford → wagons, keep → keep, battle → tower.
- **One view for everything.** The road is drawn by the same view as a battle, as a peaceful battle.

### The chart (Hannibal's campaign: a pixel map of the western Mediterranean)
- **Data.**
  - Hand-simplified `lon,lat` coast rings: Europe, Africa, Sicily, Sardinia, Corsica, the Balearics, Malta, Elba.
  - 6 lakes.
  - 23 mountain ranges `{height, reach°, peaks, crest}`; the Alps are 1.0.
  - 18 rivers.
  - Equirectangular projection at the standard parallel 41°, over lon −10.5..21 and lat 34.5..47.5.
- **Painting** (generated in time slices of 8 rows):
  - **Coasts:** roughen by hashed midpoint displacement down to segments under 3.4 px (displacement ≤ `min(0.3·len, 5)`), then fill with even-odd scanlines.
  - **Sea:** 7 bands by chamfer distance from the coast, dithered: `#cfe4df #8cc3c9 #62a6c0 #4a8bb3 #3a76a5 #2f6496 #285787`, with edges at [0.8, 2.6, 5, 8.5, 14, 24] px.
  - **Height:**
    - each range is a Gaussian ridge `height*exp(−d²)`, multiplied by ridged noise `(.62 + .62·crag)`
    - plus rolling hills `0.03 + 0.14·fbm`
  - **Land colour:**
    - snow above `smooth(.84,1,h)`
    - rock above `smooth(.43,.7,h)`
    - otherwise a SAND / WHEAT / DRY / GRASS ramp chosen by a wetness value
    - woods where wet > .6
  - **Shading:** the NW slope ×17.
  - **Rivers:** `#4d93c4`, with every 5th pixel `#9bd0e8`.
  - **Coast outline:** 0.42 × the land colour, mixed 25% with ink `#1c1612`.
  - **Peak sprites:** a lit left face, a shaded right face, and a snow cap if h > .62, every 9 or 17 px along the crests.
- **Roads between places.**
  - A* on a 3-px grid with cost `1 + 24·wet² + 3.4·max(0, high − .3) + 0.5 per river`.
  - Then simplified, Chaikin-smoothed and rasterised.
- **Paper.**
  - Paper colours `#d9caa2 #d1c196 #c8b68a #bda57a`, dithered.
  - Darker toward the edges, with a ruled border and a crease overlay.
  - A 31-px compass rose.
- **Landmarks.**
  - Pixel grids:

    | landmark | size (px) |
    |---|---|
    | tower | 13×16 |
    | village | 19×14 |
    | ford | 17×19 |
    | camp | 13×12 |
    | keep | 21×19 |
    | city | 21×17 |
    | ship | 19×14 |

  - Each is auto-outlined in `#1c1612`.
  - Roof colours: player `#3f86c8/#1f5a8e`, enemy `#cf4c36/#8a2a20`, none `#c4a259/#977b3c`.
  - A burning village has animated flames and 5 smoke puffs. A burnt-out village loses its roofs and turns grey.
- **The chart's motion.**
  1. Pull back (0.4 s).
  2. Unroll from the centre (0.7 s).
  3. Trace the route so far in blue `#78c5e6`.
  4. Draw the next leg in gold `#e8c34a` (1.1 s).
  5. Hold (0.55 s).
  6. Roll up (0.42 s).

  The field dims to 0.62 behind the chart. Zooming out past the farthest step opens it at will.

## 10. Build land off the main thread from day one
- **Why:** building the land took 1.4 to 2.3 s on an old phone's main thread.
- **How:**
  - A module worker runs the same `makeLand` and builds the terrain mesh arrays and the instanced tree matrices.
  - It **transfers** the typed-array buffers back instead of copying them.
  - Lands are keyed by content (seed, size, hashes of the tiles and heights). Keep up to 4 ready lands.
  - Request the next land ahead of time: when the army sets out for a place, or while a result screen is shown.
  - If the land isn't ready, make it inline. The result is bit-identical either way.
