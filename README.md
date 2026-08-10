# iphonemosh

Two FSRs on an Arduino drive the piece over WebSerial, sending `fsr0,fsr1` a line at a time:

- **squeeze both** — mosh a random clip from `assets/` onto the canvas. A handful play at
  once (`MAX_PANES`); past that, each squeeze retires the oldest to make room. Further
  squeezes are ignored while a clip is still moshing in.
- **press one** — corrupt an existing pane, as hard as you press. FSR0 takes the newest
  pane, FSR1 the one before it.

**Space** still moshes a clip in, so the piece runs without the hardware attached. Press
**d** for a state readout, including the raw FSR values — that's what `ACTIVE_THRESHOLD` and
`GESTURE_SETTLE` are tuned against.

Needs **Chrome or Edge** (Safari has no WebSerial) over `localhost` or https. Click *choose
port* on first load and pick the Arduino.

## Getting Started

Open `index.html` in your web browser and start editing `sketch.js`.

## Clip manifest

A browser can't list a directory, so the sketch reads its filenames from
`assets/manifest.txt`. Regenerate it whenever you add or remove clips:

```bash
sh tools/build-manifest.sh
```

## Running Locally

For projects with media files, use a local server:

```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx http-server

# Using VS Code Live Server extension
# Right-click index.html -> "Open with Live Server"
```

## Resources

- [p5.js 2.0](https://beta.p5js.org/)
- [p5.js Reference](https://p5js.org/reference/)
# poke-my-brain
# poke-my-brain
