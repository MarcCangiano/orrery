#!/usr/bin/env python3
"""Turn the generated plates into the textures the renderer loads.

Three jobs, in order, and the first one is the one that matters:

**Delight.** The brief's one rule is that the star is the only light in the
arena. Every plate arrives with lighting baked in anyway, because that is what
image models do. Delighting divides out the low-frequency luminance: broad
gradients, vignettes and soft shadows are low frequency, while the detail that
makes a material look like a material is high frequency. Divide by a heavy blur
and the lighting goes while the grain stays.

**Tile.** Nothing arrives seamless whatever the prompt says. Rolling the image
by half puts the seams in the middle where they can be healed by blending the
untouched original over them through a feathered mask. It works well on
stochastic materials (stone, corrosion, frost) and less well on regular
structure, which is why the floor's panel grid gets a gentler treatment.

**Derive.** The normal and roughness maps are computed from the albedo rather
than authored. A real normal map would come from a height scan. This is a
gradient of the delit luminance, which is a decent approximation for scratches
and seams and an honest lie about anything else.

    /usr/bin/python3 tools/art/process.py

Writes server/src/main/resources/public/textures/.
"""

from __future__ import annotations

import pathlib

import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLATES = ROOT / "tools" / "art" / "plates"
OUT = ROOT / "server" / "src" / "main" / "resources" / "public" / "textures"


# ---------------------------------------------------------------- delighting --

def delight(im: Image.Image, radius_div: float = 8.0, keep: float = 0.15) -> Image.Image:
    """Remove baked lighting by dividing out the low-frequency luminance.

    `keep` leaves a fraction of the original variation in place. Zero is
    physically correct and looks dead; a little large-scale variation reads as
    the surface being unevenly worn rather than unevenly lit.
    """
    rgb = np.asarray(im.convert("RGB"), dtype=np.float32)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

    blur = np.asarray(
        Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8))
        .filter(ImageFilter.GaussianBlur(max(2.0, im.width / radius_div))),
        dtype=np.float32,
    )
    target = float(blur.mean())
    gain = target / np.maximum(blur, 1.0)
    gain = 1.0 + (gain - 1.0) * (1.0 - keep)

    out = np.clip(rgb * gain[..., None], 0, 255)
    return Image.fromarray(out.astype(np.uint8))


def baked_light_spread(im: Image.Image) -> float:
    """How much broad light variation is left. The number this reports before
    and after delighting is the only evidence that the step did anything."""
    g = im.convert("L")
    lo = np.asarray(g.filter(ImageFilter.GaussianBlur(g.width / 12)), dtype=np.float32)
    return float(lo.max() - lo.min())


# ------------------------------------------------------------------- tiling --

def make_seamless(im: Image.Image, feather: float = 0.12, structured: bool = False) -> Image.Image:
    """Roll by half, then heal the cross-shaped seam with the original.

    `structured` narrows the healing band, which keeps a panel grid from being
    smeared into mush at the cost of a slightly more visible join.
    """
    w, h = im.size
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    rolled = np.roll(np.roll(a, w // 2, axis=1), h // 2, axis=0)

    band = max(8, int(min(w, h) * (feather * (0.5 if structured else 1.0))))

    def ramp(n: int, centre: int) -> np.ndarray:
        x = np.arange(n, dtype=np.float32)
        d = np.abs(x - centre)
        m = np.clip(1.0 - d / band, 0.0, 1.0)
        return m * m * (3 - 2 * m)          # smoothstep, no hard edge to the heal

    mx = ramp(w, w // 2)[None, :]
    my = ramp(h, h // 2)[:, None]
    mask = np.clip(mx + my, 0, 1)[..., None]

    out = rolled * (1 - mask) + a * mask
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def mirror_tile(im: Image.Image) -> Image.Image:
    """Tile by reflection. Edges match exactly by construction.

    Used for the floor and nothing else. Offset-healing smears a regular panel
    grid into doubled rivets and a visible horizontal break, because the grid on
    one side of the seam does not line up with the grid on the other. Mirroring
    trades that for a symmetry which, on a near-black surface revealed by a
    moving point light, is not something a player will ever see.
    """
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape
    quarter = a[: h // 2, : w // 2]
    top = np.concatenate([quarter, quarter[:, ::-1]], axis=1)
    return Image.fromarray(np.concatenate([top, top[::-1, :]], axis=0).astype(np.uint8))


def grade(im: Image.Image, target_mean: float, tint: str | None = None,
          tint_strength: float = 0.0) -> Image.Image:
    """Push the albedo down to near-black and toward the palette.

    Delighting normalises around the plate's own average, which lands somewhere
    mid-grey. The brief wants these surfaces nearly black so that the star's
    light is what reveals them, so brightness is set here rather than left to
    whatever the generator felt like.
    """
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    current = a.mean()
    if current > 1:
        a *= target_mean / current
    if tint and tint_strength > 0:
        rgb = np.array([int(tint[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)
        hue = rgb / max(rgb.mean(), 1.0)                  # colour cast, not brightness
        a = a * (1 - tint_strength) + a * hue * tint_strength
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def seam_ratio(im: Image.Image) -> float:
    """How much worse the wrap-around join is than an ordinary neighbouring pair.

    Comparing opposite edges in absolute terms is meaningless: in a correct tile
    those two columns are simply neighbours, so on a noisy texture they differ as
    much as any other neighbours do. What matters is the RATIO. 1.0 means the
    join is indistinguishable from the middle of the texture. Above about 1.5 and
    a seam is visible.
    """
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    join = (np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0, :] - a[-1, :]).mean()) / 2
    interior = (np.abs(a[:, 1:] - a[:, :-1]).mean() + np.abs(a[1:, :] - a[:-1, :]).mean()) / 2
    return float(join / max(interior, 0.001))


# ------------------------------------------------------------ derived maps --

def normal_map(im: Image.Image, strength: float = 2.4) -> Image.Image:
    g = np.asarray(im.convert("L"), dtype=np.float32) / 255.0
    # Wrap the gradient so the normal map tiles exactly like the albedo does.
    dx = (np.roll(g, -1, axis=1) - np.roll(g, 1, axis=1)) * strength
    dy = (np.roll(g, -1, axis=0) - np.roll(g, 1, axis=0)) * strength
    nz = np.ones_like(g)
    length = np.sqrt(dx * dx + dy * dy + nz * nz)
    rgb = np.stack([(-dx / length * 0.5 + 0.5),
                    (-dy / length * 0.5 + 0.5),
                    (nz / length * 0.5 + 0.5)], axis=-1)
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))


def roughness_map(im: Image.Image, lo: float = 0.55, hi: float = 0.98) -> Image.Image:
    """Dark, pitted, dusty areas are rough; polished metal and bronze are less so.
    Luminance inverted and compressed into a sane range."""
    g = np.asarray(im.convert("L"), dtype=np.float32) / 255.0
    r = hi - (hi - lo) * np.clip(g * 1.4, 0, 1)
    return Image.fromarray((r * 255).astype(np.uint8)).convert("L")


# ------------------------------------------------------------- projections --

def to_equirect(im: Image.Image, size: tuple[int, int], pole_squash: float = 0.65) -> Image.Image:
    """Fit a flat plate to an equirectangular sphere map.

    A sphere map pinches everything at the poles, so detail is squeezed
    vertically toward the top and bottom rather than left as a spiral of
    stretched pixels. Also wraps horizontally, since the left and right edges
    become the same meridian.
    """
    w, h = size
    src = im.convert("RGB").resize((w, h), Image.LANCZOS)
    a = np.asarray(src, dtype=np.float32)

    ys = np.arange(h, dtype=np.float32)
    lat = (ys / (h - 1) - 0.5) * np.pi
    # Sample nearer the equator as latitude grows, so poles get less detail.
    src_y = (0.5 + np.sin(lat) * (0.5 * pole_squash)) * (h - 1)
    a = a[np.clip(src_y.round().astype(int), 0, h - 1), :, :]

    # Horizontal wrap: cross-fade the right edge into the left.
    blend = max(8, w // 24)
    ramp = np.linspace(0, 1, blend, dtype=np.float32)[None, :, None]
    a[:, :blend] = a[:, :blend] * ramp + a[:, -blend:][:, ::-1] * (1 - ramp)
    a[:, -blend:] = a[:, -blend:] * (1 - ramp) + a[:, :blend][:, ::-1] * ramp
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


# ------------------------------------------------------------------- driver --

def save(im: Image.Image, name: str, mode: str = "RGB", quality: int = 92) -> None:
    """PNG at these dimensions runs 2-6MB, and the brief caps files at about 2MB
    for load time. None of these maps carry alpha, so they ship as JPEG. The
    normal map gets the highest quality setting because compression artefacts in
    a normal map read as dents in the surface."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    if path.suffix == ".jpg":
        im.convert(mode if mode != "L" else "L").save(path, quality=quality,
                                                      optimize=True, subsampling=0)
    else:
        im.convert(mode).save(path, optimize=True)
    kb = path.stat().st_size // 1024
    flag = "  <-- OVER 2MB" if kb > 2048 else ""
    print(f"    {name:<28} {im.size[0]}x{im.size[1]:<5} {kb:>5} KB{flag}")


def main() -> int:
    print("floor")
    floor = Image.open(PLATES / "floor.png")
    before = baked_light_spread(floor)
    floor = delight(floor, radius_div=6.0)
    floor = mirror_tile(floor)
    floor = grade(floor, target_mean=34, tint="#0b1120", tint_strength=0.45)
    floor = floor.resize((2048, 2048), Image.LANCZOS)
    print(f"    baked light {before:.0f} -> {baked_light_spread(floor):.0f}, "
          f"seam ratio {seam_ratio(floor):.1f}")
    save(floor, "floor-albedo.jpg")
    save(normal_map(floor.resize((1024, 1024), Image.LANCZOS), 2.0), "floor-normal.jpg", quality=96)
    save(roughness_map(floor), "floor-roughness.jpg", mode="L")

    # target mean, tint, tint strength: how near-black each one sits, and how far
    # it is pushed toward its team colour before the renderer ever lights it.
    for plate, out_name, mean, tint, tint_k in [
        # Fragments pulled to neutral slate: warm brown put them close enough to
        # Greek's gold to be read as a team colour by someone glancing.
        ("fragment", "fragment", 42, "#5a6070", 0.30),
        ("player-norse", "player-norse", 46, "#7fa8e3", 0.35),
        # Greek tinted harder than Norse. 0.35 was not enough to pull the old
        # green plate warm, and a body has to read as its team from across the
        # arena before it reads as marble.
        ("player-greek", "player-greek", 44, "#e0b062", 0.50),
    ]:
        print(plate)
        im = Image.open(PLATES / f"{plate}.png")
        before = baked_light_spread(im)
        im = delight(im)
        im = make_seamless(im)
        im = grade(im, target_mean=mean, tint=tint, tint_strength=tint_k)
        im = im.resize((1024, 1024), Image.LANCZOS)
        print(f"    baked light {before:.0f} -> {baked_light_spread(im):.0f}, "
              f"seam ratio {seam_ratio(im):.1f}")
        save(im, f"{out_name}-albedo.jpg")

    print("star")
    star = Image.open(PLATES / "star.png")
    # No delighting here. This surface is supposed to look like it emits, and it
    # is the only texture in the game allowed to.
    save(to_equirect(star, (1024, 512)), "star-equirect.jpg")

    print("backdrop")
    back = Image.open(PLATES / "backdrop.png")
    save(to_equirect(back, (4096, 2048), pole_squash=0.9), "backdrop-equirect.jpg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
