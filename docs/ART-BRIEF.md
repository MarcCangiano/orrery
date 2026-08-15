# Orrery — art brief

Hand this to whoever or whatever is making the artwork. It says what the game
is, what it already looks like, and exactly which files are wanted.

---

## The game, in one paragraph

Orrery is a real-time multiplayer physics arena. Two teams of young gods, Norse
against Greek, fight over a captured star in the wreckage of a dead solar
system and try to feed it to a serpent's jaws at either end of a cage. There is
no floor and no gravity: you thrust, you never stop, you throw a tether at a
ring fragment to swing, and you shove, which pushes you backward exactly as hard
as it pushes them. It is played from above at a slight angle, in 3D, in a very
dark room.

## The one rule everything else follows

**The star is the only light in the arena.** It is a small sun the players are
fighting over, it casts every shadow in the scene, and the far end of the arena
goes dark when the star is at the near end. Possession of the star literally
controls what everyone can see.

That means: **no baked lighting in any texture.** No painted highlights, no
drop shadows, no ambient occlusion burned into the colour map, no light coming
from a direction the scene does not have. Everything is lit at runtime by a
moving point light. A texture with its own sun in it will look wrong from the
first frame.

## What it looks like now

Everything is currently untextured geometry: spheres for players and the star,
spheres for the ring fragments, a flat plane for the floor, low boxes for the
cage walls, glowing bars for the jaws. It reads well and it is plain. The art is
what turns it from a diagram into a place.

Palette in use, keep to it:

- background / void `#05070d`
- floor `#0b1120`
- cage walls `#1c2740`, lit edge `#3a5580`
- Norse `#7fa8e3` (cold blue, frost and iron)
- Greek `#e0b062` (warm gold, marble and bronze)
- the star `#ffe9b0` core, `#ffc46a` light
- UI text `#cfd6e4`, dim text `#7c8798`, warnings `#e8b04b`

The look is closer to a dark planetarium than to a space shooter. Restrained,
cold, mostly black, with one warm light source. Not neon, not cyberpunk, no
lens flares, no chromatic aberration.

## Assets wanted

Sizes are powers of two because they become WebGL textures. PNG unless stated.
Anything with transparency needs a real alpha channel, not a black background.

**1. Floor, tiling** — 2048×2048, seamless. Dark metal or stone plating of a
long-abandoned structure, panel seams, rivets, scoring, dust. Nearly black; the
star's light is what will reveal it. Also wanted: a matching normal map, and a
roughness map if it is easy.

**2. Ring fragments** — 1024×1024, seamless. The orrery this arena was built
from, broken up: dark stone or oxidised bronze, machined grooves, chipped
edges, faint engraved orbital markings. These are spheres, so the texture wants
to work without obvious poles.

**3. Player bodies, two of them** — 1024×1024 each, one per pantheon. Norse:
pitted iron, frost, hammered metal, cold blue. Greek: veined marble and bronze,
laurel or meander motifs, warm gold. Both are spheres roughly a metre across, so
detail must read at about 60 pixels on screen. Bold shapes, not fine filigree.

**4. The star** — 1024×512 equirectangular. A small sun: churning plasma,
granulation, a few darker patches. Bright and warm. This is the one texture that
is allowed to look like it emits light, because it does.

**5. Backdrop** — 4096×2048 equirectangular, or six 1024×1024 cube faces. The
dead solar system this arena sits inside: broken orrery rings receding into the
dark, a dust lane, sparse cold stars, one very distant nebula. It must stay
dark. It sits behind everything and must never compete with the star.

**6. Particle sprites** — 256×256, transparent, white or very pale so they can
be tinted in code: a soft round glow, a spark, a thin shockwave ring, a small
puff of debris.

**7. Team crests** — 512×512, transparent, flat single-colour silhouettes that
read at 32 pixels. Norse: a raven, a knot, a hammer. Greek: a laurel, a meander
key pattern, a lyre. One each is enough; two options each is better.

**8. Wordmark** — "ORRERY", transparent, roughly 1600×400. Wide letter spacing,
thin, engraved or astronomical-instrument feeling rather than sci-fi. There is a
CSS version in the lobby now that it needs to beat.

**9. Favicon** — 512×512, works at 16 pixels. Simplest possible reading of a
small bright star with a ring around it.

## Hard constraints

- No baked lighting or shadows, for the reason above.
- No text baked into any texture except the wordmark and the crests.
- Tiling textures must actually tile. Check the seam before delivering.
- Everything must read on a near-black background. Mid-grey art will vanish.
- Sphere textures should avoid heavy detail at the poles, where it pinches.
- Keep each file under about 2MB so the whole game still loads quickly.

## Where they go

`server/src/main/resources/public/textures/` for anything the renderer loads,
`docs/` for the wordmark and anything used in the README. The renderer that will
consume them is `server/src/main/resources/public/render3d.mjs`, which currently
uses flat materials and is where the maps get wired in.
