#!/usr/bin/env python3
"""Regenerate assets/exif.json, the metadata the sketch types out beside each clip.

A browser can read a .mov's bytes but not its atoms - the QuickTime metadata iPhones write
lives in `moov/meta` and in per-track boxes that no web API exposes, so it is extracted here
and shipped as JSON. Run after changing the contents of assets/, alongside build-manifest.sh.

    python3 tools/build-exif.py

Both readers are used, because neither sees everything:

  exiftool  names the QuickTime atoms - lens, aperture, the four independent timestamps,
            the raw transform matrix, handler descriptions, the Apple maker notes
  ffprobe   decodes the streams - codec profile, colour, Dolby Vision, per-stream bitrates,
            frame counts, and the raw ISO 6709 location string

The output is keyed by filename and holds pre-formatted "KEY  value" lines, so the sketch
only has to wrap and reveal them. Anything a given clip does not carry is simply left out,
which is why the blocks differ in length - two of these clips have no GPS at all.
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
OUT = os.path.join(ASSETS, 'exif.json')
VIDEO_EXT = ('.mov', '.mp4', '.m4v', '.webm')

# The label column the sketch's monospace text aligns on. EXIF_INDENT in sketch.js matches
# it, so a value too long for the column wraps back under itself rather than under its label.
# Labels are kept to LABEL_WIDTH - 1, since one column has to stay as the gap.
LABEL_WIDTH = 9

# "+40.6788-073.8924+018.065/" - lat, lon, and an optional altitude, each signed
ISO6709 = re.compile(r'([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?')

# Keys: atoms already spoken for by a labelled row below. Whatever is left over gets dumped
# verbatim at the end, so a clip carrying something this script has never seen still shows it.
CLAIMED_KEYS = {
    'Keys:CreationDate', 'Keys:Make', 'Keys:Model', 'Keys:Software', 'Keys:GPSCoordinates',
    'Keys:LocationAccuracyHorizontal', 'Keys:FullFrameRatePlaybackIntent',
}


def run(args):
    """Runs a reader and returns its stdout, or '' if it failed or is not installed."""
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ''


def exif_all(paths):
    """Reads every clip in one exiftool pass, since startup dominates its runtime.

    @return {dict} absolute path -> {"Group:Tag": value}, both formatted and numeric. The
        numeric pass is merged in under a "#" suffix, the same convention exiftool uses.
    """
    out = {}
    for numeric in (False, True):
        args = ['exiftool', '-json', '-a', '-G1', '-q']
        if numeric:
            args.append('-n')
        try:
            entries = json.loads(run(args + list(paths)) or '[]')
        except json.JSONDecodeError:
            entries = []
        for entry in entries:
            path = os.path.abspath(entry.get('SourceFile', ''))
            tags = out.setdefault(path, {})
            for key, value in entry.items():
                tags[key + '#' if numeric else key] = value
    return out


def probe(path):
    """Runs ffprobe and returns its parsed JSON, or {} if the file is unreadable."""
    try:
        return json.loads(run(['ffprobe', '-v', 'quiet', '-print_format', 'json',
                               '-show_format', '-show_streams', path]) or '{}')
    except json.JSONDecodeError:
        return {}


def rate(value):
    """Turns ffprobe's "30000/1001" fraction into a float, or None."""
    try:
        num, den = value.split('/')
        return float(num) / float(den) if float(den) else None
    except (AttributeError, ValueError):
        return None


def track_of(tags, kind):
    """Finds the exiftool TrackN group whose handler is of the given kind.

    Track numbering is positional, so the video is usually Track1 - but one clip in this
    library leads with its audio, and reading Track1 blindly would mislabel it.

    @param {dict} tags - one clip's exiftool tags
    @param {str} kind - 'Video Track' or 'Audio Track'
    @return {str} the group prefix, e.g. 'Track1:', or '' when there is no such track
    """
    for key, value in tags.items():
        if key.endswith(':HandlerType') and value == kind:
            return key.split(':')[0] + ':'
    return ''


def stamp(value):
    """Normalises exiftool's "2026:02:03 16:23:30" into an ISO-looking date."""
    if not isinstance(value, str):
        return ''
    return re.sub(r'^(\d{4}):(\d{2}):(\d{2})', r'\1-\2-\3', value).strip()


def dms(value, positive, negative):
    """Formats a signed decimal degree as degrees/minutes/seconds with a hemisphere letter."""
    hemisphere = positive if value >= 0 else negative
    value = abs(value)
    degrees = int(value)
    minutes = int((value - degrees) * 60)
    seconds = (value - degrees - minutes / 60) * 3600
    return '%d°%02d\'%04.1f" %s' % (degrees, minutes, seconds, hemisphere)


def side_data(stream, kind):
    """Pulls one of a stream's side-data blocks by type, or {} when it has none."""
    for side in stream.get('side_data_list', []):
        if side.get('side_data_type') == kind:
            return side
    return {}


def describe(path, name, tags):
    """Builds one clip's display lines from both readers.

    @param {str} path - absolute path to the clip
    @param {str} name - filename, which heads the block on screen
    @param {dict} tags - this clip's exiftool tags
    @return {list} lines, or [] when neither reader could read the file
    """
    data = probe(path)
    fmt = data.get('format', {})
    container = fmt.get('tags', {})
    streams = data.get('streams', [])
    video = next((s for s in streams if s.get('codec_type') == 'video'), {})
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), {})
    if not data and not tags:
        return []

    vtrack = track_of(tags, 'Video Track')
    atrack = track_of(tags, 'Audio Track')
    rows = []

    def row(label, value):
        """Adds a labelled row, dropping it when the clip has nothing to say for it."""
        if value in (None, '', [], {}):
            return
        if isinstance(value, list):  # CompatibleBrands and friends come back as lists
            value = ' '.join(str(v).strip() for v in value)
        rows.append(label[:LABEL_WIDTH - 1].ljust(LABEL_WIDTH) + str(value).strip())

    def num(key, fallback=None):
        """Reads a numeric exiftool value, preferring the -n pass."""
        value = tags.get(key + '#', tags.get(key, fallback))
        try:
            return float(value)
        except (TypeError, ValueError):
            return fallback

    # --- when and where -----------------------------------------------------------
    row('DATE', stamp(tags.get('Keys:CreationDate')) or stamp(tags.get('QuickTime:CreateDate')))
    # The four QuickTime timestamps are independent, and a modify date later than its create
    # date is the fingerprint of a trim or a re-encode
    row('CREATED', stamp(tags.get('QuickTime:CreateDate')) + ' UTC'
        if tags.get('QuickTime:CreateDate') else '')
    if tags.get('QuickTime:ModifyDate') != tags.get('QuickTime:CreateDate'):
        row('MODIFIED', stamp(tags.get('QuickTime:ModifyDate')) + ' UTC'
            if tags.get('QuickTime:ModifyDate') else '')
    row('TRK CREA', stamp(tags.get(vtrack + 'TrackCreateDate')))
    if tags.get(vtrack + 'TrackModifyDate') != tags.get(vtrack + 'TrackCreateDate'):
        row('TRK MOD', stamp(tags.get(vtrack + 'TrackModifyDate')))
    row('ON DISK', stamp(tags.get('System:FileModifyDate')))

    place = None
    iso = container.get('com.apple.quicktime.location.ISO6709', '')
    match = ISO6709.match(iso)
    if match:
        lat, lon, alt = match.groups()
        place = (float(lat), float(lon), float(alt) if alt else None)
    if place:
        row('LAT', '%.5f  %s' % (place[0], dms(place[0], 'N', 'S')))
        row('LON', '%.5f  %s' % (place[1], dms(place[1], 'E', 'W')))
        if place[2] is not None:
            row('ALT', '%.2f m' % place[2])
    accuracy = num('Keys:LocationAccuracyHorizontal')
    if accuracy is not None:
        row('GPS ACC', '%.2f m horizontal' % accuracy)
    row('ISO6709', iso)

    # --- what shot it -------------------------------------------------------------
    row('DEVICE', ' '.join(p for p in (tags.get('Keys:Make'), tags.get('Keys:Model')) if p))
    row('OS', tags.get('Keys:Software'))
    row('LENS', tags.get('VideoKeys:LensModel'))
    focal = num('VideoKeys:FocalLengthIn35mmFormat')
    if focal is not None:
        row('FOCAL35', '%g mm' % focal)
    row('IRIS', tags.get('VideoKeys:CameraLensIrisfnumber'))
    # Undocumented Apple atoms. Kept because they are per-clip and genuinely vary, even
    # though what they mean is anyone's guess.
    for key in sorted(k for k in tags
                      if k.startswith('VideoKeys:Apple-maker-note') and not k.endswith('#')):
        row('MAKER' + key.rsplit('note', 1)[-1], tags[key])

    # --- the picture --------------------------------------------------------------
    # Display dimensions, not the ones in the file: this library was shot portrait and
    # stored landscape with a rotation flag the browser applies before the sketch measures it
    w, h = video.get('width'), video.get('height')
    spin = side_data(video, 'Display Matrix').get('rotation')
    if w and h:
        turned = spin in (90, -90, 270, -270)
        row('SIZE', '%d x %d%s' % (h if turned else w, w if turned else h,
                                   '  (stored %d x %d)' % (w, h) if turned else ''))
    if spin:
        row('ROTATION', '%g deg' % spin)
    row('MATRIX', tags.get(vtrack + 'MatrixStructure'))
    row('CODEC', ' '.join(p for p in (video.get('codec_name'), video.get('profile')) if p))
    row('FOURCC', ' / '.join(p for p in (tags.get(vtrack + 'CompressorID'),
                                         tags.get(vtrack + 'CompressorName')) if p))
    row('PIXFMT', video.get('pix_fmt'))
    row('DEPTH', tags.get(vtrack + 'BitDepth') and str(tags[vtrack + 'BitDepth']) + ' bit')
    fps = rate(video.get('avg_frame_rate') or '') or rate(video.get('r_frame_rate') or '')
    if fps:
        row('FPS', '%.3f' % fps)
    row('FRAMES', video.get('nb_frames'))
    if video.get('bit_rate'):
        row('BITRATE', '%.2f Mb/s' % (float(video['bit_rate']) / 1e6))
    colour = [video.get('color_primaries'), video.get('color_transfer'),
              video.get('color_space')]
    row('COLOR', ' / '.join(c for c in colour if c))
    row('RANGE', video.get('color_range'))
    dovi = side_data(video, 'DOVI configuration record')
    if dovi:
        row('DOLBY', 'vision profile %s level %s' % (dovi.get('dv_profile'),
                                                     dovi.get('dv_level')))
    ambient = side_data(video, 'Ambient viewing environment')
    if ambient.get('ambient_illuminance'):
        row('AMBIENT', '%.1f lux at capture' % rate(ambient['ambient_illuminance']))
    row('VHANDLER', tags.get(vtrack + 'HandlerDescription'))

    # --- the sound ----------------------------------------------------------------
    if audio or atrack:
        row('AUDIO', ' '.join(p for p in (audio.get('codec_name'), audio.get('profile')) if p))
        row('AFORMAT', tags.get(atrack + 'AudioFormat'))
        layout = audio.get('channel_layout')
        channels = audio.get('channels')
        row('CHANNELS', '%s%s' % (layout or '', ' (%d)' % channels if channels else ''))
        if audio.get('sample_rate'):
            row('RATE', '%s Hz' % audio['sample_rate'])
        row('ABITS', tags.get(atrack + 'AudioBitsPerSample') and
            str(tags[atrack + 'AudioBitsPerSample']) + ' bit')
        if audio.get('bit_rate'):
            row('ABITRATE', '%.1f kb/s' % (float(audio['bit_rate']) / 1e3))

    # --- how the file is put together ---------------------------------------------
    if fmt.get('duration'):
        row('DURATION', '%.3f s' % float(fmt['duration']))
    # Raw ticks alongside the timescale: a duration that is not a whole number of frames is
    # what a trimmed clip looks like from here
    if video.get('duration_ts') and tags.get(vtrack + 'MediaTimeScale'):
        row('TICKS', '%s / %s' % (video['duration_ts'], tags[vtrack + 'MediaTimeScale']))
    row('TSCALE', tags.get('QuickTime:TimeScale'))
    row('POSTER', tags.get('QuickTime:PosterTime'))
    brands = []
    for key in ('QuickTime:MajorBrand', 'QuickTime:CompatibleBrands'):
        value = tags.get(key)
        if isinstance(value, list):  # CompatibleBrands is a list even when it holds one brand
            value = ' '.join(str(v).strip() for v in value)
        if value:
            brands.append(str(value).strip())
    row('BRAND', ' / '.join(brands))
    row('TRACKS', fmt.get('nb_streams') and '%d (%s)' % (
        fmt['nb_streams'],
        ', '.join(filter(None, [
            '%d video' % sum(1 for s in streams if s.get('codec_type') == 'video'),
            '%d audio' % sum(1 for s in streams if s.get('codec_type') == 'audio'),
            '%d metadata' % sum(1 for s in streams if s.get('codec_type') == 'data')
            if any(s.get('codec_type') == 'data' for s in streams) else '',
        ]))))
    if fmt.get('bit_rate'):
        row('OVERALL', '%.2f Mb/s' % (float(fmt['bit_rate']) / 1e6))
    if tags.get('QuickTime:MediaDataSize'):
        row('MDAT', '%s bytes at offset %s' % (tags['QuickTime:MediaDataSize'],
                                               tags.get('QuickTime:MediaDataOffset')))
    if fmt.get('size'):
        row('FILESIZE', '%.2f MB' % (float(fmt['size']) / 1e6))
    row('MIME', tags.get('File:MIMEType'))

    # Anything in the movie-level Keys atom this script has no row for. Rare, but it is the
    # difference between "as much as I thought to ask for" and "everything that is in there".
    extra = sorted(k for k in tags
                   if k.startswith('Keys:') and not k.endswith('#') and k not in CLAIMED_KEYS)
    if extra:
        for key in extra:
            row(key.split(':', 1)[1][:LABEL_WIDTH - 1].upper(), tags[key])

    return [name] + rows


def main():
    names = sorted(n for n in os.listdir(ASSETS) if n.lower().endswith(VIDEO_EXT))
    if not names:
        sys.exit('no clips in assets/')

    paths = [os.path.join(ASSETS, n) for n in names]
    print('reading %d clips...' % len(names), file=sys.stderr)
    tags = exif_all(paths)
    if not tags:
        print('  exiftool unavailable - falling back to ffprobe alone (brew install exiftool)',
              file=sys.stderr)

    out = {}
    for i, (name, path) in enumerate(zip(names, paths), 1):
        lines = describe(path, name, tags.get(os.path.abspath(path), {}))
        if lines:
            out[name] = lines
        else:
            print('  skipped (unreadable): ' + name, file=sys.stderr)
        print('\r%d/%d' % (i, len(names)), end='', file=sys.stderr, flush=True)

    with open(OUT, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=True, ensure_ascii=False)
    rows = sum(len(v) for v in out.values())
    print('\nwrote %s - %d of %d clips, %d lines (%d avg)' % (
        os.path.relpath(OUT, ROOT), len(out), len(names), rows, rows / max(1, len(out))),
        file=sys.stderr)


if __name__ == '__main__':
    main()
