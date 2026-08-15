#!/usr/bin/env python3
"""Team crests: generated, then flattened into real silhouettes.

The brief asks for flat single-colour silhouettes that read at 32 pixels. A
generator will not give you that. It gives you an illustration with shading,
outlines and soft alpha, which at 32 pixels turns to mush.

So the model is used only for the shape. gpt-image-1 draws each emblem as solid
black on transparent, then everything here throws away its opinion about
colour and edges: alpha is thresholded to hard on or off, the shape is trimmed
and centred, and the colour is replaced with the team's. What survives is the
silhouette, which is the only part worth having.

    /usr/bin/python3 tools/art/crests.py

gpt-image-1 rather than FLUX because it emits a real alpha channel. About $0.04
each.
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]
TEX = ROOT / "server" / "src" / "main" / "resources" / "public" / "textures"
PLATES = ROOT / "tools" / "art" / "plates"
ENV = pathlib.Path.home() / ".openclaw" / "master.env"

NORSE = (127, 168, 227)     # #7fa8e3
GREEK = (224, 176, 98)      # #e0b062

SHAPE = (
    "Solid pure black silhouette pictogram, completely filled in, one single flat shape, "
    "no outline, no stroke, no shading, no gradient, no highlights, no texture, no detail "
    "inside the shape, no text, no letters, no border, no frame, no circle around it. "
    "Bold simple heraldic emblem, thick strong forms that stay readable when very small, "
    "centred with even margins, on a fully transparent background."
)

CRESTS = {
    "crest-norse-raven": (f"A raven in profile with folded wings, facing left. {SHAPE}", NORSE),
    # First attempt read as a plain blocky T. Mjolnir needs the tapered head and
    # the pommel to be recognisable as a hammer rather than a mallet.
    "crest-norse-hammer": (f"Mjolnir, the Norse god Thor's hammer, hanging with the handle pointing "
                           f"straight down. A wide heavy head at the top that tapers slightly inward "
                           f"toward the handle, a short thick handle below it, and a small round "
                           f"pommel at the bottom of the handle. Symmetrical, seen straight on, the "
                           f"classic Viking hammer amulet shape. {SHAPE}", NORSE),
    "crest-greek-laurel": (f"A laurel wreath, two curved branches meeting at the bottom, open at "
                           f"the top, simple bold leaves. {SHAPE}", GREEK),
    "crest-greek-lyre": (f"A lyre, two curved arms rising from a rounded body with a crossbar and "
                         f"straight strings. {SHAPE}", GREEK),
}


def load_key() -> str | None:
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY="):
                return line.partition("=")[2].strip()
    return None


def generate(name: str, prompt: str, key: str) -> Image.Image:
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=json.dumps({"model": "gpt-image-1", "prompt": prompt, "size": "1024x1024",
                         "background": "transparent", "quality": "medium", "n": 1}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    r = json.load(urllib.request.urlopen(req, timeout=240))
    raw = base64.b64decode(r["data"][0]["b64_json"])
    PLATES.mkdir(parents=True, exist_ok=True)
    (PLATES / f"{name}-raw.png").write_bytes(raw)
    return Image.open(PLATES / f"{name}-raw.png").convert("RGBA")


def flatten(im: Image.Image, colour: tuple[int, int, int], size: int = 512) -> Image.Image:
    """Threshold to a hard silhouette, trim, centre, recolour.

    The threshold is what makes this a silhouette rather than a picture: every
    pixel is either the shape or it is not. Anti-aliasing is added back
    afterwards at the working size, so edges stay clean instead of carrying the
    generator's soft halo.
    """
    a = np.asarray(im)
    # Anything the model drew: opaque pixels that are not near-white.
    opaque = a[..., 3] > 128
    dark = a[..., :3].mean(axis=-1) < 160
    mask = opaque & dark

    if not mask.any():
        raise ValueError("nothing survived thresholding: the model drew an outline, not a fill")

    ys, xs = np.where(mask)
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    # Fit into the canvas with a margin, keeping the aspect ratio.
    h, w = crop.shape
    inner = int(size * 0.84)
    scale = inner / max(h, w)
    shape = Image.fromarray((crop * 255).astype(np.uint8)).resize(
        (max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    canvas = Image.new("L", (size, size), 0)
    canvas.paste(shape, ((size - shape.width) // 2, (size - shape.height) // 2))
    canvas = canvas.filter(ImageFilter.GaussianBlur(0.6))       # clean anti-aliasing

    out = np.zeros((size, size, 4), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = colour
    out[..., 3] = np.asarray(canvas)
    return Image.fromarray(out)


def readable_at_32(im: Image.Image) -> float:
    """Fraction of a 32px render that carries the mark. Under about 12% and the
    emblem is too thin and delicate to survive at UI size."""
    small = im.resize((32, 32), Image.LANCZOS)
    return float((np.asarray(small)[..., 3] > 40).mean())


def main() -> int:
    key = load_key()
    if not key:
        print("no OPENAI_API_KEY in ~/.openclaw/master.env", file=sys.stderr)
        return 1

    wanted = sys.argv[1:] or list(CRESTS)
    TEX.mkdir(parents=True, exist_ok=True)
    failed = []
    for name in wanted:
        prompt, colour = CRESTS[name]
        try:
            flat = flatten(generate(name, prompt, key), colour)
            path = TEX / f"{name}.png"
            flat.save(path, optimize=True)
            print(f"    {name:<22} {path.stat().st_size // 1024:>3} KB   "
                  f"at 32px: {readable_at_32(flat):.0%} coverage")
        except Exception as e:
            failed.append(name)
            print(f"    FAIL {name:<18} {type(e).__name__}: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
