# Orrery — art delivery

Everything in ART-BRIEF.md, delivered. 18 files, 4.8 MB in total, in
`server/src/main/resources/public/textures/` (plus the wordmark and favicon
copied into `docs/`).

Nothing is wired into the renderer yet. `render3d.mjs` still uses flat
materials; these are the files it needs, not the change that loads them.

## What is here

| brief | files | notes |
|---|---|---|
| 1. floor, tiling | `floor-albedo.jpg` 2048², `floor-normal.jpg` 1024², `floor-roughness.jpg` 2048² | tiles exactly |
| 2. ring fragments | `fragment-albedo.jpg` 1024² | seam invisible |
| 3. player bodies | `player-norse-albedo.jpg`, `player-greek-albedo.jpg` 1024² | |
| 4. the star | `star-equirect.jpg` 1024×512 | the one texture that keeps its own light |
| 5. backdrop | `backdrop-equirect.jpg` 4096×2048 | mean luminance 7/255 |
| 6. particles | `particle-glow/spark/shockwave/debris.png` 256² | white, alpha-shaped, tint in code |
| 7. team crests | `crest-norse-raven/hammer.png`, `crest-greek-laurel/lyre.png` 512² | two per team |
| 8. wordmark | `docs/wordmark.png` + textures copy, 1600×400 | |
| 9. favicon | `docs/favicon.png` + textures copy, 512² | |

## How each one was made, and how to change it

```
tools/art/generate.py     FLUX plates for the six surfaces      ~$0.05 each
tools/art/process.py      delight, tile, grade, derive maps     free, seconds
tools/art/procedural.py   particles, wordmark, favicon          free, drawn in code
tools/art/crests.py       gpt-image-1 silhouettes, flattened    ~$0.04 each
```

Regenerating the whole pack costs about sixty cents. Source plates are kept in
`tools/art/plates/` so the processing can be re-run without paying again.

## The no-baked-lighting rule, and what was done about it

The brief's central rule is that the star is the only light in the arena. Every
image model bakes lighting in regardless of prompt, so it is measured and
removed rather than hoped away: `process.py` divides out the low-frequency
luminance, which is what a shadow or a vignette is, while leaving the
high-frequency grain that makes a material read as a material.

The numbers, as broad-luminance spread across each plate, before and after:

| plate | before | after |
|---|---|---|
| floor | 82 | 9 |
| fragment | 78 | 17 |
| player-norse | 45 | 13 |
| player-greek | 21 | 30 |

Greek goes up because that plate arrived almost flat already, and a 15% share of
the original variation is deliberately kept so surfaces read as unevenly worn
rather than unevenly lit.

## Decisions that differ from the brief, and why

**JPEG, not PNG, for the maps that carry no alpha.** The brief says PNG unless
stated, and also caps files at about 2MB. At 2048² these are 2–6 MB as PNG and
under 1 MB as quality-92 JPEG. The size cap is the constraint with a reason
behind it, so it won. Everything with real transparency is still PNG. The normal
map is saved at quality 96 because compression artefacts in a normal map read as
dents in the surface.

**The floor tiles by mirroring.** Offset-and-heal is the usual trick and it
works for the three stochastic materials, whose seams are now measurably
invisible. It fails on the floor, because a panel grid on one side of a seam
does not line up with the grid on the other: both attempts left a visible
horizontal break and doubled rivets. Mirroring makes the edges match exactly by
construction. The cost is a symmetry, which on a near-black surface revealed by
a moving point light is not something a player will find.

**Normal and roughness are derived, not authored.** They are computed from the
albedo's luminance gradient. That is a good approximation for scratches, seams
and rivets, and an honest lie about anything whose height does not correlate
with its brightness. If the floor ever needs to look genuinely embossed, that is
the file to replace first.

**The wordmark is typeset, not generated.** Optima at 150pt with 62px tracking
and a fading hairline rule. Image models misspell words often enough that every
attempt needs proofreading, and "thin, wide, engraved" is a typeface and a
tracking value rather than a prompt.

**Crests are generated then thresholded.** The model supplies the shape; the
threshold throws away its shading, outlines and soft alpha, which is what turns
an illustration into a silhouette that survives 32 pixels. Coverage at 32px:
raven 27%, hammer 28%, laurel 30%, lyre 42%.

**The equirectangular maps are approximations.** The star and backdrop are flat
plates fitted to a 2:1 sphere map, with detail squeezed toward the poles so it
pinches less, and a cross-faded horizontal wrap. A true spherical projection
would need the source generated as one, which no image model does. On the star,
which is a small bright ball, this is invisible. On the backdrop it is a dark
field of stars and one nebula, so it survives too.

## Checks that were run

- **Tiling**, as the ratio of the wrap-around join to an ordinary neighbouring
  pair. 1.0 is a perfect tile. Floor 0.0 (mirrored), fragment 1.1, norse 1.1,
  greek 1.2. Also rendered 2×2 and looked at.
- **Baked lighting**, measured before and after delighting, table above.
- **Darkness.** Every surface graded to a target mean and tinted toward its
  palette colour, because delighting normalises toward mid-grey and the brief
  wants nearly black.
- **Small sizes.** Crests rendered at 64 and 32 pixels, favicon at 128, 48 and
  16, and looked at rather than assumed. The favicon was redrawn once because
  the first version was elegant at 128 and invisible at 16.
- **Alpha.** Every transparent asset confirmed to carry a real alpha channel
  with a full 0–255 range, not a black background.

## What to look at first when wiring it up

The floor is graded very dark on purpose (mean 34/255). If it reads as too dim
once the star is lighting it, raise `target_mean` in `process.py` rather than
brightening the texture in the material, so the albedo stays the source of
truth.


---

## Changes made when wiring it up (2026-08-15)

**The Greek body was regenerated.** The plate came back green-dominant, average
rgb(42,50,36), against a team colour of #e0b062 where red leads by a distance.
The delivery reasoned that white marble blows out under a warm light, which is
true, and answered it with verdigris, which put a Greek player closer in hue to
a ring fragment than to their own jaws. In a contact game you identify a
teammate by hue while everything is moving, so team identity beats material
realism. The prompt now asks for dark warm charcoal marble with gold and bronze
veining and rules out green, verdigris, teal, malachite and olive by name, and
the grade tints Greek at 0.50 rather than 0.35 because 0.35 could not pull the
old plate warm. Now rgb(53,45,30): red leads, blue trails, matching the team.

**The fragments were cooled.** They were tinted #6b5535 and read as warm gold,
close enough to Greek's colour to be mistaken for a team surface at a glance.
Now tinted #5a6070 and measured neutral at rgb(41,41,40).

**Known regression, accepted:** the new Greek plate delights to a broad-luminance
spread of 48 against the old plate's 30. Its vein network is genuinely
large-scale, and the delighting pass cannot tell a bright vein from a bright
patch of lighting. On a sphere the size of a player it does not read as a light
direction. If it ever does, the fix is a smaller radius_div for that plate
alone rather than a flatter prompt.

**Textures are wired into `render3d.mjs`.** Floor with its normal and roughness
maps, fragments, both bodies, the star as both colour and emissive map, the
backdrop as the scene background, and the shockwave and glow sprites. The
wordmark is on the title screen and the favicon is in the tab.

Two renderer changes were needed on top of the files themselves:

- **Shadow bias.** A point light two units above a large plane made the floor
  shadow itself, which showed up as a hard dark rectangle beside the star. Fixed
  with `shadow.bias` and a fairly large `normalBias`.
- **The room got brighter, not the textures.** The floor albedo is graded very
  dark by design, so the material multiplies it up rather than the file being
  changed. The albedo stays the source of truth.


## Second pass, after looking at it in the game (2026-08-15)

Boss's read: the background looked bad, the character textures were not visible,
the star was right. Two of those were true and neither was the artwork's fault.

**The bodies were fine and the exposure was wrong.** Rendered close up they are
exactly what was asked for: cracked frost-blue iron and charcoal marble with
molten gold veining (`docs/bodies-closeup.png`). At the distance the game is
played from a player is about twenty pixels, and multiplying a texture averaging
rgb(50,45,30) by a saturated team colour left twenty pixels of near-black.

Bodies are now multiplied by a near-white, given a small self-illumination in
their team colour so one on the dark side of the arena is dim rather than
absent, and wrapped in an unlit rim shell in the team colour. Identity comes
from the rim, which survives any distance and any lighting. The texture is then
free to be a material rather than a label, which is what it is good at.

**The floor was the problem, not the sky.** It extended forty units past the
cage, so it lit up as a pale slab spreading out underneath and the arena looked
like a board on a table. The floor is now exactly the cage, the backdrop is
turned down to 0.3, and the deck carries the orrery it was built from: four
concentric orbit rings, graduation ticks around the outer one, and a halfway
line. A featureless plane also gives the eye nothing to judge speed against,
which matters in a game about momentum.

The floor material is brighter and slightly metallic now as well, because the
panel seams and rivets in that texture were completely invisible at the previous
exposure, and a texture nobody can see is a texture nobody needed.
