"""
sRGB <-> Oklab conversions + a perceptual mean, shared by aggregate.py and the
pick-model densification. Oklab (Bjorn Ottosson, 2020) is perceptually roughly
uniform, so averaging favorite colors there gives a sensible "mean color"
instead of the muddy brown a naive RGB average produces.

All RGB values are 0-255 ints; Oklab is (L, a, b) floats.
"""

from __future__ import annotations


def _srgb_to_linear(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(c: float) -> float:
    c = 0.0 if c < 0.0 else 1.0 if c > 1.0 else c
    v = 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
    return v


def rgb_to_oklab(rgb) -> tuple[float, float, float]:
    r, g, b = (_srgb_to_linear(x) for x in rgb)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = l ** (1 / 3), m ** (1 / 3), s ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return (L, a, bb)


def oklab_to_rgb(lab) -> tuple[int, int, int]:
    L, a, b = lab
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return tuple(round(255 * _linear_to_srgb(x)) for x in (r, g, bb))


def oklab_chroma(lab) -> float:
    """sqrt(a^2 + b^2): 0 = gray, higher = more saturated."""
    _, a, b = lab
    return (a * a + b * b) ** 0.5


def mean_oklab(labs):
    """Component-wise mean of a list of (L, a, b) tuples."""
    n = len(labs)
    if n == 0:
        raise ValueError("mean_oklab of empty list")
    sL = sa = sb = 0.0
    for L, a, b in labs:
        sL += L; sa += a; sb += b
    return (sL / n, sa / n, sb / n)


def rgb_to_hex(rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, int(round(x)))) for x in rgb))


# ---------- hue families (the bins the "most-preferred color" mode counts over) ----------
#
# People never pick the identical RGB (each survey offers a fresh random palette),
# so "the one color most people preferred" is counted over perceptual hue families,
# then rendered as the within-family mean shade (a real, specific, vivid color).
# A low-chroma color is "neutral" regardless of hue (near-gray / black / white).

FAMILIES = ("red", "orange", "yellow", "green", "cyan", "blue",
            "purple", "magenta", "neutral")

NEUTRAL_CHROMA = 0.045   # Oklab chroma below this = neutral (gray/black/white)

# upper hue-angle bound (deg, Oklab) for each chromatic family, in order
_HUE_BOUNDS = ((20, "red"), (45, "orange"), (70, "yellow"), (150, "green"),
               (200, "cyan"), (260, "blue"), (300, "purple"), (340, "magenta"),
               (360, "red"))


def hue_family(lab) -> str:
    import math
    L, a, b = lab
    if (a * a + b * b) ** 0.5 < NEUTRAL_CHROMA:
        return "neutral"
    deg = math.degrees(math.atan2(b, a)) % 360
    for lim, name in _HUE_BOUNDS:
        if deg < lim:
            return name
    return "red"


def mean_color_from_rgbs(rgbs):
    """Perceptual mean of 0-255 RGB triples -> (hex, mean_rgb, mean_lab, chroma)."""
    labs = [rgb_to_oklab(c) for c in rgbs]
    mlab = mean_oklab(labs)
    mrgb = oklab_to_rgb(mlab)
    return rgb_to_hex(mrgb), mrgb, mlab, oklab_chroma(mlab)
