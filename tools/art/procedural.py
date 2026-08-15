#!/usr/bin/env python3
"""The assets that are better drawn than generated.

Particles, the wordmark and the favicon are all shapes with exact requirements:
a perfectly symmetrical falloff, a word spelled correctly, a mark that survives
being 16 pixels wide. An image model gives you an approximation of each, with
soft alpha edges and a spelling you have to check. Code gives you the actual
thing, in a few kilobytes, and it can be adjusted by changing a number.

    /usr/bin/python3 tools/art/procedural.py

Particles go to textures/, wordmark and favicon to docs/ and textures/.
"""

from __future__ import annotations

import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
TEX = ROOT / "server" / "src" / "main" / "resources" / "public" / "textures"
DOCS = ROOT / "docs"

# Everything here is white or near-white with alpha doing the shaping, because
# the brief wants them tinted in code. A particle with colour baked in can only
# ever be one team's colour.
WHITE = (255, 255, 255)


def _radial(size: int) -> np.ndarray:
    """Distance from centre, 0 at the middle and 1 at the edge of the circle."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    c = (size - 1) / 2
    return np.sqrt((x - c) ** 2 + (y - c) ** 2) / c


def _write(alpha: np.ndarray, name: str, rgb: tuple[int, int, int] = WHITE) -> None:
    a = np.clip(alpha, 0, 1)
    h, w = a.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = rgb
    out[..., 3] = (a * 255).astype(np.uint8)
    TEX.mkdir(parents=True, exist_ok=True)
    path = TEX / name
    Image.fromarray(out, "RGBA").save(path, optimize=True)
    print(f"    {name:<28} {w}x{h:<5} {path.stat().st_size // 1024:>4} KB")


def particles(size: int = 256) -> None:
    print("particles")
    r = _radial(size)

    # Soft glow: gaussian, not a linear ramp. A linear falloff has a visible
    # edge where it reaches zero; a gaussian does not.
    _write(np.exp(-(r ** 2) * 5.5), "particle-glow.png")

    # Spark: a bright core with two crossed streaks. Kept thin so that a hundred
    # of them on screen still read as individual sparks rather than a smear.
    core = np.exp(-(r ** 2) * 40)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    c = (size - 1) / 2
    dx, dy = (x - c) / c, (y - c) / c
    streak = (np.exp(-(dy ** 2) * 900) + np.exp(-(dx ** 2) * 900)) * np.exp(-(r ** 2) * 6)
    _write(np.clip(core + streak * 0.55, 0, 1), "particle-spark.png")

    # Shockwave: a thin ring that fades inward and outward, brightest at 78% of
    # the radius so it has room to expand without touching the texture edge.
    ring = np.exp(-((r - 0.78) ** 2) / (2 * 0.045 ** 2))
    _write(ring * np.clip(1 - r ** 8, 0, 1), "particle-shockwave.png")

    # Debris: a scatter of small soft chips. Seeded so the pack regenerates
    # identically rather than being a different puff every run.
    rng = np.random.default_rng(7)
    puff = np.zeros((size, size), dtype=np.float32)
    for _ in range(34):
        px, py = rng.uniform(0.18, 0.82, 2) * size
        rad = rng.uniform(size * 0.012, size * 0.045)
        d = np.sqrt((x - px) ** 2 + (y - py) ** 2) / rad
        puff = np.maximum(puff, np.exp(-(d ** 2) * 2.2))
    _write(puff * np.clip(1 - r ** 3, 0, 1), "particle-debris.png")


def wordmark() -> None:
    """ORRERY, letterspaced.

    Deliberately typeset rather than generated. Image models spell words wrong
    often enough that every attempt has to be proofread, and the brief asks for
    thin, wide and engraved, which is a tracking value and a typeface, not a
    prompt. Optima has the engraved-on-brass quality the brief describes: humanist,
    slightly flared stems, no bracket serifs.
    """
    print("wordmark")
    W, H = 1600, 400
    text = "ORRERY"
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Optima.ttc", 150, index=0)

    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    tracking = 62                      # the wide spacing the brief asks for
    widths = [d.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = (W - total) / 2
    y = H / 2 - 96

    for ch, w in zip(text, widths):
        # Two passes: a faint wide halo so the letters sit in the dark rather
        # than on top of it, then the letter itself in the UI text colour.
        d.text((x, y), ch, font=font, fill=(120, 150, 200, 40),
               stroke_width=6, stroke_fill=(90, 120, 170, 26))
        d.text((x, y), ch, font=font, fill=(207, 214, 228, 255))
        x += w + tracking

    # A hairline rule under the word, the way a scale is engraved on an
    # instrument. Fades out at both ends so it reads as engraving, not underline.
    rule = np.zeros((H, W), dtype=np.float32)
    ry = int(H * 0.70)
    span = np.linspace(-1, 1, W, dtype=np.float32)
    rule[ry:ry + 2, :] = np.clip(1 - np.abs(span) ** 2, 0, 1) * 0.55
    ra = (rule * 255).astype(np.uint8)
    overlay = np.zeros((H, W, 4), dtype=np.uint8)
    overlay[..., 0], overlay[..., 1], overlay[..., 2] = 124, 135, 152
    overlay[..., 3] = ra
    im = Image.alpha_composite(im, Image.fromarray(overlay, "RGBA"))

    DOCS.mkdir(parents=True, exist_ok=True)
    for path in (DOCS / "wordmark.png", TEX / "wordmark.png"):
        im.save(path, optimize=True)
    print(f"    wordmark.png                 {W}x{H:<5} "
          f"{(DOCS / 'wordmark.png').stat().st_size // 1024:>4} KB  (docs/ and textures/)")


def favicon() -> None:
    """A small bright star with a ring. It has to survive 16 pixels, so it is
    two shapes and nothing else: a hot core with a glow, and one thin ellipse."""
    print("favicon")
    S = 512
    r = _radial(S)
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    c = (S - 1) / 2

    img = np.zeros((S, S, 4), dtype=np.float32)

    glow = np.exp(-(r ** 2) * 9) * 0.9
    core = np.exp(-(r ** 2) * 55)

    # Ring: an ellipse squashed to 30% height, the orrery read at a glance.
    # Sized to nearly fill the canvas and thick enough to survive being resampled
    # to 16 pixels. The first version was elegant at 128px and gone at 16.
    ex, ey = (x - c) / (S * 0.465), (y - c) / (S * 0.20)
    er = np.sqrt(ex ** 2 + ey ** 2)
    ring = np.exp(-((er - 1.0) ** 2) / (2 * 0.085 ** 2))
    ring *= np.clip((r - 0.14) * 6, 0, 1)      # let the star sit in front of it

    warm = np.array([255, 233, 176], dtype=np.float32) / 255
    hot = np.array([255, 252, 240], dtype=np.float32) / 255
    cool = np.array([127, 168, 227], dtype=np.float32) / 255

    alpha = np.clip(glow + core + ring, 0, 1)
    colour = (warm[None, None, :] * glow[..., None]
              + hot[None, None, :] * core[..., None]
              + cool[None, None, :] * ring[..., None])
    colour = colour / np.maximum(alpha[..., None], 1e-6)

    img[..., :3] = np.clip(colour, 0, 1) * 255
    img[..., 3] = alpha * 255
    out = Image.fromarray(img.astype(np.uint8), "RGBA")
    for path in (DOCS / "favicon.png", TEX / "favicon.png"):
        out.save(path, optimize=True)

    # Prove it survives the size it will actually be used at.
    small = out.resize((16, 16), Image.LANCZOS)
    filled = float((np.asarray(small)[..., 3] > 24).mean())
    print(f"    favicon.png                  {S}x{S:<5} "
          f"{(DOCS / 'favicon.png').stat().st_size // 1024:>4} KB   "
          f"at 16px: {filled:.0%} of pixels carry the mark")


def main() -> int:
    particles()
    wordmark()
    favicon()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
