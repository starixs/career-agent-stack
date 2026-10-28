#!/usr/bin/env python3
"""从志莽行书（Zhi Mang Xing，SIL OFL 1.1）里抽出内置语句用到的字形轮廓，生成 renderer 用的 glyphs.json。

手写语句的字形就是这款书法手迹字体；运笔顺序另由 strokes.json（楷体笔顺中轴）在运行时反推。
用法：python3 scripts/build-handwriting-glyphs.py [@fontsource/zhi-mang-xing 解包后的 package 目录]
不给目录时 npm pack 固定版本到临时目录再读。需要 fontTools（pip install fonttools）。改了 quotes.json 后重跑一次。
"""
import glob
import json
import os
import subprocess
import sys
import tarfile
import tempfile

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

# 钉死版本：字形换版本会改字迹，要有意识地升级。
FONTSOURCE_PACKAGE = '@fontsource/zhi-mang-xing@5.3.0'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DIR = os.path.join(ROOT, 'src/renderer/components/career/handwriting')


def fetch_package():
    work = tempfile.mkdtemp(prefix='zhi-mang-xing-')
    name = subprocess.run(['npm', 'pack', FONTSOURCE_PACKAGE, '--silent'], cwd=work, check=True, capture_output=True, text=True).stdout.strip()
    with tarfile.open(os.path.join(work, name)) as tar:
        tar.extractall(work, filter='data')
    return os.path.join(work, 'package')


def outline(font, glyph_name):
    pen = SVGPathPen(font.getGlyphSet(), ntos=lambda v: str(round(v)))
    font.getGlyphSet()[glyph_name].draw(pen)
    return pen.getCommands()


def main():
    package = sys.argv[1] if len(sys.argv) > 1 else fetch_package()
    quotes = json.load(open(os.path.join(DIR, 'quotes.json'), encoding='utf-8'))
    chars = sorted({ch for q in quotes for ch in q['text']})
    glyphs, meta = {}, None
    # Fontsource 把字体按 unicode 分片成多个 woff，逐片找需要的字。
    for path in sorted(glob.glob(os.path.join(package, 'files', '*-400-normal.woff'))):
        font = TTFont(path)
        cmap = font.getBestCmap()
        meta = meta or {'upm': font['head'].unitsPerEm, 'ascent': font['hhea'].ascent}
        for ch in chars:
            if ch not in glyphs and ord(ch) in cmap:
                name = cmap[ord(ch)]
                glyphs[ch] = {'d': outline(font, name), 'adv': font['hmtx'][name][0]}
    missing = [ch for ch in chars if ch not in glyphs]
    if missing or meta is None:
        raise SystemExit(f'[handwriting] Zhi Mang Xing is missing glyphs for: {"".join(missing)} (package {package})')
    with open(os.path.join(DIR, 'glyphs.json'), 'w', encoding='utf-8') as f:
        json.dump({**meta, 'glyphs': glyphs}, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    with open(os.path.join(package, 'LICENSE'), encoding='utf-8') as src, open(os.path.join(DIR, 'OFL-ZhiMangXing.txt'), 'w', encoding='utf-8') as dst:
        dst.write(src.read())
    print(f'[handwriting] wrote {len(glyphs)} glyphs from {FONTSOURCE_PACKAGE}')


if __name__ == '__main__':
    main()
