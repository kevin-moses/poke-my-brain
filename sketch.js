// ---- tuning ---------------------------------------------------------------------

const MOSH_FRAMES = 120;     // transition length in frames
const RESOLVE_FRAMES = 8;    // frames at the end spent resolving back to a clean image

const MAX_PANES = 4 ;         // main perf lever - simultaneous decodes
const PREWARM = 20;          // clips kept decoded ahead of entry - memory buys instant presses
const WARM_CONCURRENCY = 3;  // clips fetching at once; Chrome only gives ~6 sockets per origin
const WARM_TIMEOUT = 30;     // seconds a clip gets to become ready before it's recycled
const RETRY_COOLDOWN = 5;    // seconds before a recycled clip may be tried again
const WARM_EVERY = 15;       // frames between pool sweeps - its thresholds are all seconds

// Tall clips are bound by height and wide ones by width, so one cap would leave the wide
// ones looking shrunken. This library is mostly portrait, so wide clips get the looser cap.
const MAX_SIZE = 0.6;        // tall clips fit inside this fraction of the canvas
const MAX_SIZE_WIDE = 0.9;   // ...and wide clips inside this one
const BLEED = 0.0;           // fraction of a pane allowed off each edge; 0 = fully contained
const MIN_SIZE = 64;         // don't build a codec for a sliver
const MIN_OVERLAP = 0.15;    // cover a new pane wants, so the mosh has something to deform
const PLACEMENT_TRIES = 32;  // candidate positions scored per entry; more = tidier spacing
const COVER_EPS = 0.02;      // coverage difference below which two candidates tie

const ENCODE_BITRATE = 4_000_000; // explicit, so delta strength isn't Chrome's default
const MAX_DUP = 6;           // peak decode duplication - the smear intensity knob
const SWITCH_AT = 0.2;       // progress at which the encoder input flips to the new clip
const TS_STEP = Math.round(1e6 / 30); // microseconds per encoded frame

// Derived once, so no pane has to carry flags that stay in step with them
const SWITCH_FRAME = Math.ceil(SWITCH_AT * MOSH_FRAMES); // first frame fed by the new clip
const RESOLVE_FRAME = MOSH_FRAMES - RESOLVE_FRAMES;      // clean keyframe lands here

// Every pane corrupts at once, and the JPEG round trip is the cost - GLITCH_SCALE and
// GLITCH_EVERY_IDLE are the dials if the frame rate suffers. A pane is only redrawn when a
// pass runs, so its apparent frame rate is 60/cadence.
const GLITCH_BASE = 0.15 ;    // corruption a pane sits at untouched - the master intensity dial
const GLITCH_EVERY_TOUCHED = 2; // frames between passes on the pane being pressed -> 30fps
const GLITCH_EVERY_IDLE = 1 ;    // floor for the others; they roll 3-5 -> 12-20fps
const GLITCH_SCALE = 0.8;    // buffer size relative to the pane; lower is cheaper, chunkier
const GLITCH_MIN = 0.09  ;     // below this a pane just draws clean

// The metadata column. Text is typed out one character at a time and then stays put - each
// clip that enters adds its block below the last, so a section reads as a running log of what
// has played. A block writes to the very last row it can and then overflows: the remainder
// carries on at the top of the next section to the right, mid-block, and the typing runs
// straight through the seam. Past the last section it wraps back to the first, so the section
// being wiped is always the oldest one on screen. EXIF_INDENT matches the label column
// tools/build-exif.py pads to, so a wrapped value lines up under the one above it.
const EXIF_SECTIONS = 3;     // sections the window divides into, filled left to right
const EXIF_MARGIN = 16;      // px inset from the window edges and inside each section
const EXIF_SIZE = 12;        // matches the HUD
const EXIF_LEADING = 16;     // ...as does the line spacing
const EXIF_INDENT = 9;       // spaces a wrapped line is indented by
const EXIF_CPS = 2000;        // characters revealed per second

// Either half of the rig can be the board on the wire, and they narrate differently, so both
// are parsed: the sensor board sends a numeric CSV line per sample, while the HeadbandMassager
// peripheral has no sensors of its own and only echoes the BLE writes it receives, one line
// per channel ("rx ch0: 45"). Both channels pressed moshes a clip in; one alone rubs the
// corruption out of a pane, harder press meaning cleaner.
const SERIAL_BAUD = 9600;    // must match the Arduino's Serial.begin()
const FSR_MAX = 120;         // the board maps its 12-bit reads to 0..120, not 0..127
// The sensor board sends "raw0,raw1,level0,level1,flag". The raw fields are 12-bit ADC counts
// and the level fields are those mapped to 0..FSR_MAX - which is the range every threshold
// here is tuned against, so the levels are what get read. Correct these two if the column
// order changes.
const CSV_CH0 = 2;           // column holding channel 0's mapped level
const CSV_CH1 = 3;           // ...and channel 1's
const ACTIVE_THRESHOLD = 10; // above this a sensor counts as touched
const UNGLITCH_AT = 30;      // press this hard and the targeted pane is clean for good
// The channels arrive as two separate lines now rather than one snapshot, so a squeeze
// genuinely lands as two events. This window is what stops the first of them flashing a
// glitch on the way into every squeeze.
const GESTURE_SETTLE = 150;  // ms a lone sensor waits for its partner; 0 disables
const SILENCE_WARN = 4;      // seconds an open-but-silent port waits before complaining

// ---- state ----------------------------------------------------------------------

let CLIPS = [];              // filenames from assets/manifest.txt
let EXIF = {};               // filename -> metadata lines, from assets/exif.json
let exifCols = blankExifCols(); // one per section; see blankExifCols for the shape
let exifAt = 0;              // section being written to, stepping right and wrapping
let panes = [];              // draw order: oldest first, newest on top
let warmPool = [];           // clips loading or loaded, waiting to be handed to a pane
let deadClips = new Set();   // indices that genuinely failed to load - never tried again
let retryAt = new Map();     // clip index -> millis() before which it won't be re-warmed
let codecReady = false;
let pendingEntry = false;    // a press waiting for a clip to decode; a second press is a no-op
let showHud = false;         // 'd' toggles the state readout
let DEBUG_CHUNKS = false;    // flip from the console to log every chunk type

let serial = null;           // p5.WebSerial, built in setup()
let portButton = null;
let portState = 'no port';   // for the HUD
let fsr = [0, 0];            // latest reading per channel
let fsrSince = [0, 0];       // millis() each channel crossed ACTIVE_THRESHOLD
let bothWasActive = false;   // so a held squeeze is one gesture rather than sixty
let bothLatched = false;     // suppresses single-sensor glitching until both are released
let linesSeen = 0;           // readings parsed, for the HUD and the first-reading log
let badLines = 0;            // non-reading lines: boot banner, I2C scan, heartbeats, HALTED
let lastLineAt = 0;          // last parsed reading
let lastAnyAt = 0;           // last line of any kind, so a talking board still counts as alive
let silenceWarned = false;
let loggedChannel = -1;      // glitch channel last reported, so logging stays on transitions

// Logging happens on transitions, never per frame, so this can stay on. Not named log(): p5
// exports log as the natural logarithm in global mode and would silently shadow it.
let LOG = true;

/**
 * Console-logs a tagged message, unless logging has been turned off with LOG = false.
 *
 * @param {string} tag - short category shown in brackets, e.g. 'serial'
 * @param {...*} args - values passed through to console.log
 */
function logEvent(tag, ...args) {
    if (LOG) console.log('[' + tag + ']', ...args);
}

/**
 * p5 entry point: creates the canvas, kicks off codec and serial setup, and loads the clip
 * manifest. Async because p5 2.x has no preload() but defers draw() until setup() resolves.
 *
 * @return {Promise<void>} resolves once the manifest has been read
 */
async function setup() {
    createCanvas(windowWidth, windowHeight);
    logEvent('boot', 'sketch running - space moshes a clip in, d toggles the HUD,' +
                     ' LOG = false quiets this');
    setupCodecs();   // async, but draw() handles codecReady being false
    setupSerial();

    CLIPS = (await loadStrings('assets/manifest.txt'))
        .map((s) => s.trim())
        .filter(Boolean);
    if (!CLIPS.length) console.warn('[clips] assets/manifest.txt is empty - run tools/build-manifest.sh');
    else logEvent('clips', CLIPS.length, 'in the manifest; warming up to', PREWARM);

    // Optional: a clip with no entry simply enters without a metadata block
    try {
        EXIF = await loadJSON('assets/exif.json');
        logEvent('exif', Object.keys(EXIF).length, 'clips have metadata');
    } catch (e) {
        console.warn('[exif] could not read assets/exif.json - run tools/build-exif.py');
    }
}


/**
 * p5 render loop: services the warm pool and the sensors, then draws every pane in whatever
 * state it is in - moshing, glitching, or clean.
 */
function draw() {
    background(0, 0, 129);

    // Under the panes: the video layers over the text, and a pane moshing in samples the
    // column along with everything else beneath it, so the type gets dragged by the transition
    drawExifText();

    warmClips();
    checkSerialSilence();
    applyGesture();

    if (pendingEntry) tryEnterPane();

    // Oldest first, so a moshing pane samples the canvas after everything beneath it has
    // drawn. That ordering is what lets it deform what is underneath.
    for (const pane of panes) {
        // An exception escaping here would stop the sketch outright, since p5 only
        // reschedules after draw() returns. Drop the pane to clean playback instead.
        try {
            if (pane.phase === 'MOSHING') {
                runMoshFrame(pane);
            } else if (pane.glitchAmount > GLITCH_MIN) {
                runGlitchFrame(pane);
            } else {
                drawPaneClean(pane);
            }
        } catch (e) {
            console.error('pane frame failed - falling back to clean playback', e);
            failPaneEntrance(pane);
        }
    }

    if (showHud) drawHud();
}


/**
 * Finds the pane still animating in, if there is one. At most one exists, since input is
 * shut for exactly as long as this returns non-null.
 *
 * @return {?Object} the entering pane, or null when every pane is playing
 */
function enteringPane() {
    return panes.find((p) => p.phase !== 'PLAYING') || null;
}


/**
 * Builds the HUD's one-line summary of the current gesture. Reports the resulting corruption
 * level rather than raw pressure, since the two run opposite ways.
 *
 * @return {string} human-readable gesture state
 */
function gestureLabel() {
    const g = readGesture();
    if (g.both) return 'BOTH' + (bothWasActive ? ' (held)' : '');
    if (g.channel === -1) return 'idle';

    const target = glitchTarget(g.channel);
    if (!target) return 'FSR' + g.channel + ' (no target)';
    if (target.unglitched) return 'FSR' + g.channel + ' -> already clear';

    const relief = constrain(fsr[g.channel] / FSR_MAX, 0, 1);
    return 'FSR' + g.channel + ' -> ' + nf(GLITCH_BASE * (1 - relief), 1, 2) +
           '  (' + fsr[g.channel] + '/' + UNGLITCH_AT + ' to clear)';
}


// ---- FSR gestures ---------------------------------------------------------------

/**
 * Reads the latched sensor pair as a gesture: both sensors mean mosh, one alone means glitch
 * that channel's pane. A squeeze starts and ends with a moment where only one sensor reads
 * active, and each needs its own guard - GESTURE_SETTLE holds a lone sensor on the way in to
 * see if its partner follows, and bothLatched blocks the way out until both go quiet.
 *
 * @return {{both: boolean, channel: number}} channel is 0 or 1 for a lone sensor, else -1
 */
function readGesture() {
    const active0 = fsr[0] > ACTIVE_THRESHOLD;
    const active1 = fsr[1] > ACTIVE_THRESHOLD;

    if (active0 && active1) return { both: true, channel: -1 };
    if (!active0 && !active1) return { both: false, channel: -1 };
    if (bothLatched) return { both: false, channel: -1 };

    const ch = active0 ? 0 : 1;
    const settled = millis() - fsrSince[ch] >= GESTURE_SETTLE;
    return { both: false, channel: settled ? ch : -1 };
}


/**
 * Turns the current reading into this frame's effects: a squeeze queues an entry, and a lone
 * sensor sets the glitch level on its target pane. Runs before the pane loop so every pane
 * knows its glitch strength by the time it draws.
 */
function applyGesture() {
    const gesture = readGesture();

    // Rising edge only: holding the squeeze is one gesture, not one per frame
    if (gesture.both && !bothWasActive) {
        const busy = enteringPane();
        logEvent('gesture', 'squeeze', fsr[0] + ',' + fsr[1],
            busy ? '- ignored, a clip is still moshing in' : '-> mosh');
        if (!busy) pendingEntry = true;
    }
    bothWasActive = gesture.both;

    if (gesture.both) bothLatched = true;
    else if (fsr[0] <= ACTIVE_THRESHOLD && fsr[1] <= ACTIVE_THRESHOLD) bothLatched = false;

    const target = glitchTarget(gesture.channel);

    if (gesture.channel !== loggedChannel) {
        if (gesture.channel === -1) logEvent('gesture', 'hands off - panes back to baseline');
        else if (target) logEvent('gesture', 'FSR' + gesture.channel,
                             'clearing pane', target.clipIndex);
        else logEvent('gesture', 'FSR' + gesture.channel,
                 '- no eligible pane (still moshing, or not enough panes yet)');
        loggedChannel = gesture.channel;
    }

    // Press hard enough and the pane is done with corruption for good, buffers and all
    if (target && !target.unglitched && fsr[gesture.channel] > UNGLITCH_AT) {
        target.unglitched = true;
        disposePaneGlitch(target);
        logEvent('gesture', 'FSR' + gesture.channel, 'at', fsr[gesture.channel],
                 '- cleared', CLIPS[target.clipIndex], 'for good');
    }

    // Below that, pressure only leans on the baseline while it is held
    const relief = gesture.channel === -1
        ? 0
        : constrain(fsr[gesture.channel] / FSR_MAX, 0, 1);

    for (const pane of panes) {
        if (pane.unglitched) continue; // stays at 0, set when it was cleared
        pane.glitchAmount = pane === target ? GLITCH_BASE * (1 - relief) : GLITCH_BASE;
    }
}


/**
 * Maps a sensor channel to the pane it corrupts: FSR0 takes the newest pane, FSR1 the one
 * before it. A pane still moshing in is skipped, since runMoshFrame owns its drawing and a
 * glitch layered on top would fight the transition.
 *
 * @param {number} channel - 0, 1, or -1 for no gesture
 * @return {?Object} the pane to glitch, or null if there isn't an eligible one
 */
function glitchTarget(channel) {
    if (channel === -1) return null;
    const pane = panes[panes.length - 1 - channel];
    if (!pane || pane.phase !== 'PLAYING') return null;
    return pane;
}


// ---- serial ---------------------------------------------------------------------

/**
 * Wires up p5.WebSerial and its event handlers, then looks for a port that has already been
 * authorised. Warns and returns early if the browser has no WebSerial - the space bar still
 * works without it.
 */
function setupSerial() {
    if (!navigator.serial) {
        portState = 'unsupported';
        console.warn('[serial] WebSerial needs Chrome or Edge over https/localhost' +
                     ' - space bar still works');
        return;
    }

    serial = new p5.WebSerial();
    navigator.serial.addEventListener('connect', () => {
        logEvent('serial', 'device plugged in');
        serial.getPorts(pickPort);
    });
    navigator.serial.addEventListener('disconnect', () => {
        logEvent('serial', 'device unplugged');
        serial.close();
    });

    serial.on('noport', () => {
        logEvent('serial', 'no authorised port - click "choose port"');
        portState = 'no port';
        makePortButton();
    });
    serial.on('portavailable', openPort);
    serial.on('requesterror', (err) => {
        portState = 'error';
        console.error('[serial] port request failed:', err);
    });
    // open() resolves either way, so the port is only genuinely open once this fires
    serial.on('open', () => {
        portState = 'open';
        lastLineAt = lastAnyAt = millis();
        silenceWarned = false;
        logEvent('serial', 'port open at', SERIAL_BAUD, 'baud - waiting for lines');
    });
    serial.on('openerror', (err) => {
        portState = 'error';
        console.error('[serial] could not open port:', err,
                      '\n  Something else is probably holding it - close the Arduino IDE' +
                      ' Serial Monitor (or any other tab running this sketch) and reload.');
        makePortButton();
    });
    serial.on('readerror', (err) => console.error('[serial] read failed:', err));
    serial.on('data', serialEvent);
    serial.on('close', () => {
        logEvent('serial', 'port closed');
        portState = 'closed';
        makePortButton();
    });

    logEvent('serial', 'looking for a previously authorised port...');
    serial.getPorts(pickPort);
}


const ARDUINO_VIDS = new Set([0x2341, 0x2a03, 0x1b4f, 0x239a]);

/**
 * Picks the port most likely to be the board. Taking ports[0] is how you end up silently
 * connected to Bluetooth-Incoming-Port, which opens happily and then never sends a byte, so
 * virtual ports (no USB vendor id) are ruled out and a known Arduino vendor id wins outright.
 *
 * @param {SerialPort[]} ports - the authorised ports p5.WebSerial found
 * @return {SerialPort|undefined} the chosen port, or undefined so p5 emits 'noport'
 */
function pickPort(ports) {
    for (const p of ports) logEvent('serial', '  found port:', describePort(p));

    const usb = ports.filter((p) => p.getInfo().usbVendorId !== undefined);
    const chosen = usb.find((p) => ARDUINO_VIDS.has(p.getInfo().usbVendorId)) || usb[0];

    if (!chosen) {
        logEvent('serial', 'none of these look like a board - ignoring them');
        return undefined; // p5.webserial emits "noport", which raises the button
    }
    logEvent('serial', 'selected', describePort(chosen));
    return chosen;
}


/**
 * Formats a port's vendor and product ids for logging, flagging known Arduino boards.
 *
 * @param {SerialPort} port
 * @return {string} e.g. "USB 2341:0043 (Arduino)"
 */
function describePort(port) {
    const info = port.getInfo();
    if (info.usbVendorId === undefined) return 'virtual / non-USB (e.g. Bluetooth)';
    const hex4 = (n) => (n === undefined ? '????' : n.toString(16).padStart(4, '0'));
    const vendor = ARDUINO_VIDS.has(info.usbVendorId) ? ' (Arduino)' : '';
    return `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}${vendor}`;
}


/** Opens the selected port at SERIAL_BAUD and hides the port button. */
function openPort() {
    logEvent('serial', 'opening at', SERIAL_BAUD, 'baud...');
    serial.open({ baudRate: SERIAL_BAUD }); // resolves regardless; the events report the outcome
    if (portButton) portButton.hide();
}


/** Shows the "choose port" button, creating it the first time it is needed. */
function makePortButton() {
    if (portButton) { portButton.show(); return; }
    portButton = createButton('choose port');
    portButton.position(10, 10);
    portButton.mousePressed(() => {
        logEvent('serial', 'requesting port - pick the Arduino, not Bluetooth-Incoming-Port');
        serial.requestPort();
    });
}


// One BLE write, echoed by the peripheral: "rx ch0: 45"
const RX_LINE = /^rx ch([01]):\s*(\d+)$/;

/**
 * Handles one incoming serial line, latching any reading into the fsr pair. Parsing is the
 * only per-line work, so a burst between frames costs nothing beyond the last one winning.
 */
function serialEvent() {
    let line = serial.readLine();
    if (!line) return;
    line = line.trim();
    if (!line) return;

    lastAnyAt = millis();

    const rx = line.match(RX_LINE);
    if (rx) {
        applyReading(Number(rx[1]), Number(rx[2]));
        return;
    }

    // A numeric CSV line from the sensor board. The current firmware sends five columns and
    // keeps the mapped levels in the middle; an older one sent just the two levels.
    const parts = line.split(',');
    const values = parts.map((s) => int(s));
    if (parts.length >= 2 && values.every((v) => isFinite(v))) {
        const wide = parts.length > CSV_CH1;
        applyReading(0, values[wide ? CSV_CH0 : 0]);
        applyReading(1, values[wide ? CSV_CH1 : 1]);
        return;
    }

    // Everything else is the board narrating itself - boot banner, I2C scan, heartbeats,
    // HALTED codes. Mangled characters here would mean a baud mismatch instead.
    badLines++;
    logEvent('arduino', line);
}


/**
 * Latches one channel's level and stamps the moment it crosses into being touched, which is
 * what GESTURE_SETTLE measures against.
 *
 * @param {number} ch - 0 or 1
 * @param {number} value - level as written over BLE
 */
function applyReading(ch, value) {
    if (value > ACTIVE_THRESHOLD && fsr[ch] <= ACTIVE_THRESHOLD) fsrSince[ch] = millis();
    fsr[ch] = value;

    lastLineAt = millis();
    if (linesSeen++ === 0) logEvent('serial', 'first reading parsed: ch' + ch, '=', value,
                                   '- data is flowing');
}


/**
 * Warns once when an open port isn't delivering. Nothing errors in that case - the sketch
 * simply never reacts. The board heartbeats every 2s whether or not anyone is pressing, so
 * total silence and "alive but no readings" are genuinely different faults with different
 * fixes, and are reported separately.
 */
function checkSerialSilence() {
    if (portState !== 'open' || silenceWarned) return;

    const now = millis();
    const dead = now - lastAnyAt > SILENCE_WARN * 1000;
    const noReadings = !dead && linesSeen === 0 && now - lastLineAt > SILENCE_WARN * 1000;
    if (!dead && !noReadings) return;
    silenceWarned = true;

    if (dead) {
        console.warn(`[serial] port open but completely silent for ${SILENCE_WARN}s -` +
                     ' not even a heartbeat. Wrong port (Bluetooth-Incoming-Port?), wrong' +
                     ' baud, or the board is not running. Reload to pick a different port.');
    } else {
        console.warn(`[serial] the board is talking but no "rx ch0:" / "rx ch1:" lines have` +
                     ` arrived in ${SILENCE_WARN}s. The peripheral only prints those when a` +
                     ' BLE central writes to it, so either nothing is connected and writing,' +
                     ' or no sensor has been pressed yet - see the [arduino] lines above.' +
                     ' The space bar still moshes clips in either way.');
    }
}


// ---- input ----------------------------------------------------------------------

/**
 * p5 key handler: 'd' toggles the HUD and space queues a pane entry. Space is ignored while
 * a pane is still moshing in, which is the whole input lock.
 *
 * @return {boolean|undefined} false on space, to stop the page scrolling
 */
function keyPressed() {
    if (key === 'd' || key === 'D') {
        showHud = !showHud;
        return;
    }
    if (key !== ' ') return;
    if (!enteringPane()) pendingEntry = true;
    return false; // don't let space scroll the page
}


/**
 * Draws the debug readout toggled by 'd'. The pool counts matter most: "ready 0" with a full
 * pool means clips are loading too slowly, while a climbing "dead" count means the manifest
 * points at something the browser won't play.
 */
function drawHud() {
    const entering = enteringPane();
    const lines = [
        'fps ' + nf(frameRate(), 2, 0),
        'panes ' + panes.length + '/' + MAX_PANES +
            '  glitched ' + panes.filter((p) => !p.unglitched).length,
        'warm ' + warmPool.length + '/' + PREWARM + '  ready ' + readySlots().length,
        'clips ' + CLIPS.length + '  dead ' + deadClips.size + '  cooling ' + retryAt.size,
        'space ' + (entering ? 'SHUT' : pendingEntry ? 'PENDING' : 'open'),
        'entering ' + (entering
            ? entering.phase + ' ' + entering.timer + '/' + MOSH_FRAMES
            : '-'),
        // Raw values, not just the verdict - this is what ACTIVE_THRESHOLD is tuned against
        'fsr ' + fsr[0] + ',' + fsr[1] + '  port ' + portState,
        'rx ' + linesSeen + (badLines ? '  msg ' + badLines : '') +
            (portState === 'open' ? '  last ' + nf((millis() - lastLineAt) / 1000, 1, 1) + 's' : ''),
        'gesture ' + gestureLabel(),
    ];

    push();
    noStroke();
    fill(255);
    textFont('monospace');
    textSize(12);
    textAlign(LEFT, TOP);
    for (let i = 0; i < lines.length; i++) text(lines[i], 16, 14 + i * 16);
    pop();
}


/**
 * Draws a pane's video uncorrupted. Uses drawImage on the raw element rather than p5's
 * image(), which would re-copy the clip at full resolution every frame just to scale it down.
 *
 * @param {Object} pane
 */
function drawPaneClean(pane) {
    drawingContext.drawImage(pane.video.elt, pane.x, pane.y, pane.w, pane.h);
}


// ---- the metadata column -------------------------------------------------------

/**
 * An empty section.
 *
 * @return {{clips: string[], lines: string[], revealed: number, total: number}}
 *   clips    - the filenames stacked in this section, oldest first
 *   lines    - their blocks wrapped to the section and concatenated
 *   revealed - characters typed so far, counting one per line break; fractional between frames
 *   total    - characters in lines, so a section is done when revealed reaches it
 */
function blankExifCol() {
    return { clips: [], lines: [], revealed: 0, total: 0 };
}


/**
 * One empty section per column of the window.
 *
 * @return {Object[]} EXIF_SECTIONS sections, left to right
 */
function blankExifCols() {
    const cols = [];
    for (let i = 0; i < EXIF_SECTIONS; i++) cols.push(blankExifCol());
    return cols;
}


/**
 * Adds a clip's metadata below whatever the current section already holds, filling it to its
 * last row and spilling the remainder into the next section to the right. Called as a pane
 * enters, so the sections read as one continuous strip of text that happens to be folded into
 * columns. Stepping onto a section wipes it, which is the only thing that clears anything.
 *
 * @param {string} name - filename as it appears in the manifest and in exif.json
 */
function addExifText(name) {
    let block = wrapExif(EXIF[name] || []);
    if (!block.length) return;

    const rows = exifRows();

    // A block longer than the whole screen would otherwise chase its own tail forever, wiping
    // the section it just wrote; the guard stops it after one lap, keeping the last screenful.
    for (let lap = 0; block.length && lap <= EXIF_SECTIONS; lap++) {
        const col = exifCols[exifAt];
        const room = rows - col.lines.length;

        if (room > 0) {
            col.clips.push(name);
            col.lines = col.lines.concat(block.slice(0, room)); // no break between blocks
            col.total = col.lines.reduce((n, line) => n + line.length + 1, 0);
            // col.revealed is left alone, so typing carries on without pausing
            block = block.slice(room);
            if (!block.length) break;
        }

        exifAt = (exifAt + 1) % EXIF_SECTIONS; // full: the rest goes at the top of the next one
        exifCols[exifAt] = blankExifCol();
    }
}


/**
 * How many lines fit between the top and bottom margins.
 *
 * @return {number} rows available, at least 1
 */
function exifRows() {
    return Math.max(1, Math.floor((height - EXIF_MARGIN * 2) / EXIF_LEADING));
}


/**
 * Left edge of a section's text.
 *
 * @param {number} section - 0-based, left to right
 * @return {number} x in pixels
 */
function exifSectionX(section) {
    return section * width / EXIF_SECTIONS + EXIF_MARGIN;
}


/**
 * Re-wraps everything on screen after a resize, since the section width, the line breaks and
 * the number of rows have all moved. Replays the same accumulation from the oldest section
 * forward, so a shorter window that no longer fits them all drops the oldest blocks exactly as
 * they would have been dropped live. Everything comes back already typed rather than crawling
 * out again.
 */
function rebuildExifText() {
    const names = [];
    for (const s of exifWriteOrder()) {
        for (const name of exifCols[s].clips) {
            // A block spanning a seam is listed by both sections it touches, and replaying it
            // twice would print it twice
            if (names[names.length - 1] !== name) names.push(name);
        }
    }

    exifCols = blankExifCols();
    exifAt = 0;
    for (const name of names) addExifText(name);
    for (const col of exifCols) col.revealed = col.total;
}


/**
 * How many monospace characters fit across one section. Measured rather than assumed, since
 * the sections are a fraction of the window and the browser picks the actual monospace face.
 *
 * @return {number} characters per line, at least 8
 */
function exifColumns() {
    push();
    textFont('monospace');
    textSize(EXIF_SIZE);
    const charWidth = textWidth('M');
    pop();
    const usable = width / EXIF_SECTIONS - EXIF_MARGIN * 2; // margin each side keeps a gutter
    return Math.max(8, Math.floor(usable / charWidth));
}


/**
 * Wraps one clip's metadata to the column, breaking at spaces where it can and mid-token when
 * a value has none. Every line is kept, however long the block runs; whether it fits is
 * addExifText's question, not this one's.
 *
 * @param {string[]} lines - one clip's lines from exif.json
 * @return {string[]} lines that each fit the column
 */
function wrapExif(lines) {
    const cols = exifColumns();
    // Only indent continuations when there is room left to say anything after the indent
    const indent = cols > EXIF_INDENT + 8 ? ' '.repeat(EXIF_INDENT) : '';

    const out = [];
    for (const raw of lines) {
        let line = raw;
        let prefix = '';
        while (line.length > cols) {
            let cut = line.lastIndexOf(' ', cols);
            if (cut <= prefix.length) cut = cols; // one long token: break it anywhere
            out.push(line.slice(0, cut));
            prefix = indent;
            line = prefix + line.slice(cut).trimStart();
        }
        out.push(line);
    }
    return out;
}


/**
 * Sections in the order they were written to, oldest first and ending on the one being written
 * now. Empty sections are included; they simply have nothing to say.
 *
 * @return {number[]} section indices
 */
function exifWriteOrder() {
    const order = [];
    for (let i = 1; i <= EXIF_SECTIONS; i++) order.push((exifAt + i) % EXIF_SECTIONS);
    return order;
}


/**
 * Advances and draws every section. One character budget is spent per frame and poured through
 * the sections in write order, so a block split across a seam finishes the section it started
 * in and keeps typing straight into the top of the next one, at the same pace. Timed off
 * deltaTime rather than the frame count, so the reveal holds its pace while the panes are
 * chewing through frames.
 */
function drawExifText() {
    let budget = EXIF_CPS * deltaTime / 1000;
    for (const s of exifWriteOrder()) {
        if (budget <= 0) break;
        const col = exifCols[s];
        if (col.revealed >= col.total) continue;
        const typed = Math.min(budget, col.total - col.revealed);
        col.revealed += typed;
        budget -= typed;
    }

    push();
    noStroke();
    fill(255);
    textFont('monospace');
    textSize(EXIF_SIZE);
    textAlign(LEFT, TOP);

    for (let s = 0; s < exifCols.length; s++) {
        const col = exifCols[s];
        if (!col.lines.length) continue;

        const x = exifSectionX(s);
        let budget = Math.floor(col.revealed);
        for (let i = 0; i < col.lines.length && budget > 0; i++) {
            const line = col.lines[i];
            const shown = line.slice(0, budget);
            if (shown) text(shown, x, EXIF_MARGIN + i * EXIF_LEADING);
            budget -= line.length + 1; // the break costs a character, so a blank line still beats
        }
    }
    pop();
}


// ---- lazy clip loading ---------------------------------------------------------

// Only ever PREWARM + MAX_PANES video elements exist at once, however large the library
// gets. Elements are built on demand and destroyed when their pane leaves.

/**
 * Whether a clip has decoded far enough to be measured and drawn.
 *
 * @param {p5.MediaElement} v
 * @return {boolean}
 */
function clipReady(v) {
    return v.elt.videoWidth > 0 && v.elt.readyState >= 2;
}


/**
 * Lists the warmPool positions holding clips that could enter right now.
 *
 * @return {number[]} indices into warmPool
 */
function readySlots() {
    const slots = [];
    for (let i = 0; i < warmPool.length; i++) {
        if (clipReady(warmPool[i])) slots.push(i);
    }
    return slots;
}


/**
 * Removes a clip from the warm pool and frees its element - permanently if it will never
 * play, otherwise on a cooldown so a merely slow clip gets another chance later.
 *
 * @param {number} slot - index into warmPool
 * @param {boolean} permanent - true to blacklist the clip for the rest of the session
 */
function dropWarmClip(slot, permanent) {
    const v = warmPool[slot];
    if (permanent) deadClips.add(v.__clipIndex);
    else retryAt.set(v.__clipIndex, millis() + RETRY_COOLDOWN * 1000);
    discardClip(v);
    warmPool.splice(slot, 1);
}


/**
 * Sweeps the warm pool every WARM_EVERY frames: recycles broken or stalled clips and starts
 * new loads up to PREWARM, at most WARM_CONCURRENCY at a time. Entry does not go through
 * here, so a press stays instant either way.
 */
function warmClips() {
    if (frameCount % WARM_EVERY !== 0) return;

    // networkState, not elt.error, is what reports a missing file: p5 builds the element
    // with <source> children, so a 404 fires on the source and leaves elt.error null. The
    // grace period avoids reading NO_SOURCE before the source has been attached.
    //
    // The timeout only applies to a clip that is still not ready - a ready one legitimately
    // waits in the pool until someone presses, and ageing those out would drain it.
    const now = millis();
    let loading = 0;
    for (let i = warmPool.length - 1; i >= 0; i--) {
        const v = warmPool[i];
        const age = now - v.__warmedAt;
        const noSource = age > 250 && v.elt.networkState === 3; // NETWORK_NO_SOURCE
        const broken = Boolean(v.elt.error || noSource);
        const ready = clipReady(v);
        const stalled = !ready && age > WARM_TIMEOUT * 1000;

        if (broken || stalled) dropWarmClip(i, broken);
        else if (!ready) loading++;
    }

    while (warmPool.length < PREWARM && loading < WARM_CONCURRENCY) {
        const index = pickUnclaimedIndex();
        if (index === -1) return; // nothing left to warm right now

        const v = createVideo('assets/' + encodeURIComponent(CLIPS[index]));
        v.hide();               // hide the default HTML player
        v.elt.muted = true;     // an unmuted element can't autoplay without a gesture
        v.elt.preload = 'auto';
        v.__clipIndex = index;
        v.__warmedAt = now;
        warmPool.push(v);
        loading++;
    }
}


/**
 * Picks a random clip that no pane or warm slot is holding, skipping dead clips and ones
 * still cooling down. Which clips are spoken for is read off the pool and the panes rather
 * than tracked separately and kept in step by hand.
 *
 * @return {number} index into CLIPS, or -1 if nothing is available right now
 */
function pickUnclaimedIndex() {
    const now = millis();
    const taken = new Set(warmPool.map((v) => v.__clipIndex));
    for (const p of panes) taken.add(p.clipIndex);

    const free = [];
    for (let i = 0; i < CLIPS.length; i++) {
        if (taken.has(i) || deadClips.has(i)) continue;
        if (retryAt.has(i)) {
            if (now < retryAt.get(i)) continue;
            retryAt.delete(i); // lapsed, so retryAt only holds clips still waiting
        }
        free.push(i);
    }
    return free.length ? random(free) : -1;
}


/**
 * Tears a video element down: aborts any in-flight fetch, frees decoded data, and removes it
 * from the DOM rather than leaving it parked there.
 *
 * @param {p5.MediaElement} v
 */
function discardClip(v) {
    const elt = v.elt;
    try { elt.pause(); } catch (e) {}
    elt.loop = false;
    while (elt.firstChild) elt.removeChild(elt.firstChild); // drop the <source> children
    try { elt.load(); } catch (e) {}  // aborts the fetch and frees decoded data
    v.remove();
}


// ---- pane entry ----------------------------------------------------------------

/**
 * Tries to turn a pending press into a new pane: takes a ready clip from the warm pool,
 * sizes and places it, evicts the oldest pane if the screen is full, and starts its mosh.
 * Returns without clearing pendingEntry if nothing has decoded yet, so the next frame tries
 * again and input stays locked in the meantime.
 */
function tryEnterPane() {
    // Random rather than warmPool[0], which would serve a 20-deep pool in warm order
    const ready = readySlots();
    if (!ready.length) return;

    const slot = random(ready);
    const video = warmPool[slot];
    // Size first: it depends only on the clip, so an unusable one is caught before anything
    // has been evicted on its behalf
    const dims = paneDims(video);
    if (!dims) {
        dropWarmClip(slot, true);
        return; // still pending: the retry picks another clip
    }
    warmPool.splice(slot, 1);

    // Evict before placing, so the departing pane's area reads as free space. It also has to
    // happen before the pane loop, or the incoming mosh deforms pixels about to vanish.
    if (panes.length >= MAX_PANES) {
        logEvent('pane', 'at max, evicting oldest:', CLIPS[panes[0].clipIndex]);
        disposePane(panes[0]);
        panes.shift();
    }

    const rect = placeRect(dims.w, dims.h);

    video.elt.loop = true; // nothing leaves on its own; clips loop until evicted
    video.play();

    const pane = {
        video,
        clipIndex: video.__clipIndex,
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        phase: 'PLAYING',
        timer: 0,            // frames into the entrance; a pane only ever has one
        frameQueue: [],
        encoder: null, decoder: null, encodeCanvas: null,
        latestFrame: null, disposed: false,
        glitch: null, glitchBuffer: null,
        glitchAmount: GLITCH_BASE,          // corrupts as soon as the mosh hands over
        unglitched: false,                  // latched clean by a hard press; never re-arms
        glitchOffset: panes.length,         // stagger passes across panes
        glitchStyle: rollGlitchStyle(),     // this clip's own flavour of corruption
        displaceAt: rollDisplaceAt(),       // depth of the shear; re-rolled as it runs
    };

    // Without WebCodecs there is nothing to mosh with, so the pane just appears
    if (codecReady) {
        initPaneCodec(pane);
        pane.phase = 'MOSHING';
    }

    panes.push(pane);
    pendingEntry = false; // from here the pane's own phase holds the key shut
    addExifText(CLIPS[pane.clipIndex]);

    const style = pane.glitchStyle;
    logEvent('pane', 'entered', CLIPS[pane.clipIndex],
        `${rect.w}x${rect.h} at ${rect.x},${rect.y}`,
        'cover ' + nf(rect.cover, 1, 2),
        pane.phase === 'MOSHING' ? '- moshing in' : '- no codec, appearing clean',
        `(${panes.length}/${MAX_PANES} panes)`,
        `| glitch q${nf(style.quality, 1, 2)} start${nf(style.start, 1, 2)}` +
        ` ${Math.round(style.bytes)}b ${style.solid === undefined ? 'static' : 'band' + style.solid}` +
        ` every ${style.cadence}`);
}


/**
 * Fits a clip inside a box sized for its orientation, so wide and tall clips read at
 * comparable scale. Uses display dimensions, not the ones in the file: this library was shot
 * portrait and stored 1920x1080 with a rotation flag the browser has already applied by the
 * time videoWidth reads non-zero.
 *
 * @param {p5.MediaElement} video
 * @return {?{w: number, h: number}} even pane dimensions, or null if the clip is unusable
 */
function paneDims(video) {
    const elt = video.elt;
    const vw = elt.videoWidth, vh = elt.videoHeight;
    if (!vw || !vh) return null;

    const max = vw >= vh ? MAX_SIZE_WIDE : MAX_SIZE;
    const s = Math.min(max * width / vw, max * height / vh);
    const w = evenFloor(vw * s);
    const h = evenFloor(vh * s);
    if (w < MIN_SIZE || h < MIN_SIZE) return null;
    return { w, h };
}


/**
 * Chooses where a new pane lands by sampling PLACEMENT_TRIES positions and scoring them.
 * The winner is the emptiest candidate that still covers at least MIN_OVERLAP, since a mosh
 * needs something under it to deform - bare canvas just tears up flat background. When the
 * screen is near empty and nothing qualifies, the emptiest candidate overall wins instead;
 * that is what the first pane of a session gets.
 *
 * @param {number} w - pane width in pixels
 * @param {number} h - pane height in pixels
 * @return {{x: number, y: number, w: number, h: number, cover: number, spread: number}}
 */
function placeRect(w, h) {
    const bx = w * BLEED, by = h * BLEED;
    let best = null;      // emptiest overall
    let bestMosh = null;  // emptiest of those with enough cover to mosh

    for (let i = 0; i < PLACEMENT_TRIES; i++) {
        const rect = {
            x: Math.round(random(-bx, width - w + bx)),
            y: Math.round(random(-by, height - h + by)),
            w, h,
        };
        rect.cover = overlapFraction(rect);
        rect.spread = nearestPaneDistance(rect);

        if (!best || emptier(rect, best)) best = rect;
        if (rect.cover >= MIN_OVERLAP && (!bestMosh || emptier(rect, bestMosh))) bestMosh = rect;
    }

    return bestMosh || best;
}


/**
 * Compares two placement candidates: less covered wins, and within COVER_EPS they count as
 * equally empty so the one further from its nearest neighbour wins instead. Coverage alone
 * is degenerate for wide rects, where whole bands of positions score identically.
 *
 * @param {Object} a - candidate with cover and spread
 * @param {Object} b - candidate to compare against
 * @return {boolean} true if a is the better placement
 */
function emptier(a, b) {
    if (Math.abs(a.cover - b.cover) > COVER_EPS) return a.cover < b.cover;
    return a.spread > b.spread;
}


/**
 * Distance from a candidate's centre to the centre of the closest existing pane.
 *
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @return {number} pixels, or Infinity when there are no panes yet
 */
function nearestPaneDistance(rect) {
    if (!panes.length) return Infinity;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    let nearest = Infinity;
    for (const p of panes) {
        nearest = Math.min(nearest, dist(cx, cy, p.x + p.w / 2, p.y + p.h / 2));
    }
    return nearest;
}


/**
 * Rounds down to an even number, since VP8 requires even dimensions.
 *
 * @param {number} v
 * @return {number} an even value of at least 2
 */
function evenFloor(v) {
    return Math.max(2, Math.floor(v / 2) * 2);
}


/**
 * How much of a candidate rect is already covered by existing panes. Overlapping panes
 * double-count, hence the clamp - this only feeds a threshold test.
 *
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @return {number} covered fraction, 0..1
 */
function overlapFraction(rect) {
    let covered = 0;
    for (const p of panes) {
        const ox = Math.max(0, Math.min(rect.x + rect.w, p.x + p.w) - Math.max(rect.x, p.x));
        const oy = Math.max(0, Math.min(rect.y + rect.h, p.y + p.h) - Math.max(rect.y, p.y));
        covered += ox * oy;
    }
    return Math.min(1, covered / (rect.w * rect.h));
}


// ---- the localized mosh --------------------------------------------------------

/**
 * Advances one frame of a pane's entrance: feeds the encoder (the canvas underneath at
 * first, the new clip after SWITCH_FRAME), duplicates the resulting chunks to smear it, and
 * draws the decoded result. Every switch is a pure function of the frame counter, so the
 * pane carries no flags to keep in step. Hands the pane to PLAYING on the last frame.
 *
 * @param {Object} pane
 */
function runMoshFrame(pane) {
    pane.timer++;
    const progress = pane.timer / MOSH_FRAMES;
    const resolving = pane.timer > RESOLVE_FRAME;
    const useB = pane.timer >= SWITCH_FRAME;

    // Duplication must stay at 1 until the switch, or the underlying region's own deltas
    // corrupt the reference frame before the new clip has anything to deform
    const dup = (!useB || resolving)
        ? 1
        : 1 + Math.round(triWave(progress) * (MAX_DUP - 1));

    // The first chunk from the new clip is a keyframe in all but name - it carries the whole
    // scene change as residual, so decoding it would land on the clean clip and there would
    // be no mosh. Dropping it leaves the decoder holding the pixels underneath.
    const isBridge = pane.timer === SWITCH_FRAME;

    // Frame one seeds the decoder with the pixels under the rect; the second keyframe lands
    // the clean image early enough to be on screen before the pane draws its clip directly
    const keyFrame = pane.timer === 1 || pane.timer === RESOLVE_FRAME;

    const ctx = pane.encodeCanvas.drawingContext;

    if (!useB) {
        // The main canvas backing store is pixelDensity-scaled, so the source rect has to
        // be too. A bleeding pane reads partly off-canvas, hence the prefill.
        const d = pixelDensity();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pane.w, pane.h);
        ctx.drawImage(drawingContext.canvas,
                      pane.x * d, pane.y * d, pane.w * d, pane.h * d,
                      0, 0, pane.w, pane.h);
    } else {
        ctx.drawImage(pane.video.elt, 0, 0, pane.w, pane.h);
    }

    const frame = new VideoFrame(pane.encodeCanvas.elt,
                                 { timestamp: (pane.timer - 1) * TS_STEP });
    pane.frameQueue.push({ dup, bridge: isBridge });
    pane.encoder.encode(frame, { keyFrame });
    frame.close(); // must close or the frame pool starves

    // Fall back to the clip itself until the decoder has produced something
    if (pane.latestFrame) {
        drawingContext.drawImage(pane.latestFrame, pane.x, pane.y, pane.w, pane.h);
    } else {
        drawPaneClean(pane);
    }

    if (pane.timer >= MOSH_FRAMES) {
        disposePaneCodec(pane);
        pane.phase = 'PLAYING';
        logEvent('pane', 'mosh resolved:', CLIPS[pane.clipIndex], '- input open again');
    }
}


// ---- the pressure glitch --------------------------------------------------------

/**
 * Rolls one pane's flavour of corruption, so the same clip never comes back looking the same
 * way twice and no two panes on screen corrupt alike.
 *
 * @return {{quality: number, start: number, bytes: number, solid: (number|undefined),
 *           cadence: number, displaceEvery: number}}
 *   quality - JPEG quality, so damage lands in fat blocks or fine grain
 *   start   - how deep into the file corruption may reach at full strength; low numbers sit
 *             near the header and take the whole frame's colour and structure with them
 *   bytes   - this pane's own byte budget at full corruption, scaled down by its level
 *   solid   - the replacement byte; a fixed value is steady banding, undefined re-rolls each
 *             pass and flickers (p5.glitch reuses one value for every byte in a pass)
 *   cadence - how frantic the churn is when the pane is left alone
 *   displaceEvery - frames the shear holds its depth before jumping to a new one
 */
function rollGlitchStyle() {
    return {
        quality: random(0.6, 0.95),
        start: random(0.15, 0.40),
        bytes: random(70, 250),
        solid: random() < 0.2 ? Math.floor(random(256)) : undefined,
        cadence: Math.floor(random(GLITCH_EVERY_IDLE, GLITCH_EVERY_IDLE + 3)),
        displaceEvery: Math.floor(random(40, 100)),
    };
}


/**
 * Picks how deep into the JPEG the shear byte lands, as a fraction of the file. Kept inside
 * the scan data: below this a hit can land in the quantisation or Huffman tables, which makes
 * the frame undecodable rather than displaced, and the pane just falls back to clean.
 *
 * @return {number} 0..1 position in the file
 */
function rollDisplaceAt() {
    return random(0.15, 0.95);
}


/**
 * Lazily builds a pane's Glitch encoder and scratch buffer and keeps them for its life.
 * Pressure swings through zero constantly, so tearing these down on every release would
 * rebuild an encoder and a full-size buffer each time.
 *
 * @param {Object} pane
 */
function ensureGlitch(pane) {
    if (pane.glitch) return;

    pane.glitch = new Glitch();
    pane.glitch.loadType('jpg');
    // Corrupt bytes routinely yield a file the decoder rejects, which is the technique
    // working, not a fault - p5.glitch would log a line for each one
    pane.glitch.errors(false);
    // Must be set before any loadImage, since it is what the re-encode uses. Low quality
    // means fat DCT blocks, so damage spreads in slabs rather than specks.
    pane.glitch.loadQuality(pane.glitchStyle.quality);
    // A p5.Image, not a p5.Graphics: p5.glitch gates on hasOwnProperty('width'), which a
    // p5 2.x Graphics fails because width sits on the prototype
    pane.glitchBuffer = createImage(Math.max(2, Math.round(pane.w * GLITCH_SCALE)),
                                    Math.max(2, Math.round(pane.h * GLITCH_SCALE)));
}


/**
 * Draws one glitched frame of a pane by corrupting the clip's own JPEG bytes, as far as the
 * pane's current level asks for. Two kinds of damage land per pass: a single shear byte that
 * displaces the frame, and the speckle band. Only re-corrupts on the pane's cadence, so the
 * pane being touched refreshes fastest and per-pane offsets keep passes from landing together.
 *
 * @param {Object} pane
 */
function runGlitchFrame(pane) {
    ensureGlitch(pane);

    const style = pane.glitchStyle;

    // Holding the depth steady is the whole effect. Corrupting one byte desyncs the entropy
    // decode from that point down, so the same depth every pass shifts the frame the same way
    // and reads as displacement - a fresh depth each pass would just read as noise.
    if (frameCount % style.displaceEvery === 0) pane.displaceAt = rollDisplaceAt();

    const cadence = pane.glitchAmount < GLITCH_BASE ? GLITCH_EVERY_TOUCHED : style.cadence;
    if ((frameCount + pane.glitchOffset) % cadence === 0) {
        const buf = pane.glitchBuffer;
        buf.drawingContext.drawImage(pane.video.elt, 0, 0, buf.width, buf.height);
        pane.glitch.loadImage(buf);
        pane.glitch.resetBytes();

        // randomByte takes an absolute position and ignores the limits set below, so this is
        // the only damage that can land above the speckle band - which is what lets the shear
        // sit anywhere in the frame while the speckle stays pinned to the bottom.
        const len = pane.glitch.bytesGlitched.length;
        if (len) pane.glitch.randomByte(Math.floor(pane.displaceAt * len));

        // Must come before randomBytes - it defines the range that draws from. Corrupting
        // earlier in the file is more destructive, so more corruption lowers the start.
        pane.glitch.limitBytes(map(pane.glitchAmount, 0, 1, 1.0, style.start));
        const bytes = Math.floor(pane.glitchAmount * style.bytes);
        pane.glitch.randomBytes(bytes, style.solid);
        pane.glitch.buildImage(); // async; pane.glitch.image lands a frame or two later
    }

    const g = pane.glitch.image;
    if (g && g.width > 1) {
        image(g, pane.x, pane.y, pane.w, pane.h);
    } else {
        drawPaneClean(pane); // nothing decoded yet, or the last pass was rejected
    }
}


/**
 * Drops a pane's glitch encoder and buffer and pins it clean. A p5.Image has no remove(), so
 * releasing the reference is the whole teardown.
 *
 * @param {Object} pane
 */
function disposePaneGlitch(pane) {
    pane.glitch = null;
    pane.glitchBuffer = null;
    pane.glitchAmount = 0; // so a torn-down pane draws clean rather than re-arming itself
}


// ---- codecs --------------------------------------------------------------------

/**
 * Checks whether WebCodecs can encode VP8 here and sets codecReady. Without it panes still
 * enter, they just appear instead of moshing in.
 *
 * @return {Promise<void>}
 */
async function setupCodecs() {
    if (typeof VideoEncoder === 'undefined') {
        console.warn('WebCodecs unavailable - panes will appear without moshing');
        return;
    }
    const support = await VideoEncoder.isConfigSupported({
        codec: 'vp8', width: 640, height: 360,
        latencyMode: 'realtime', bitrate: ENCODE_BITRATE,
    });
    if (!support.supported) {
        console.warn('vp8 encode unsupported - panes will appear without moshing');
        return;
    }
    codecReady = true;
    logEvent('codec', 'vp8 encode available - panes will mosh in');
}


/**
 * Builds a pane's own encoder, decoder, and scratch canvas, sized to its rect. Each pane
 * needs its own because VideoEncoder dimensions are fixed at configure time.
 *
 * @param {Object} pane
 */
function initPaneCodec(pane) {
    pane.encodeCanvas = createGraphics(pane.w, pane.h);
    // Required: createGraphics inherits the sketch's density (2 on retina), which would hand
    // the encoder a double-size frame. Chrome does not throw - it encodes blank frames.
    pane.encodeCanvas.pixelDensity(1);

    // A dead codec is retired here, where the failure is reported, rather than left for the
    // next encode() to throw on and the draw loop to catch a frame later
    pane.decoder = new VideoDecoder({
        output: (frame) => handleDecodedFrame(pane, frame),
        error: (e) => { console.error('Decoder error:', e); failPaneEntrance(pane); },
    });
    pane.decoder.configure({ codec: 'vp8' });

    pane.encoder = new VideoEncoder({
        output: (chunk) => handleEncodedChunk(pane, chunk),
        error: (e) => { console.error('Encoder error:', e); failPaneEntrance(pane); },
    });
    pane.encoder.configure({
        codec: 'vp8', width: pane.w, height: pane.h,
        latencyMode: 'realtime', // discourages automatic keyframes at the scene change
        bitrate: ENCODE_BITRATE,
    });
}


/**
 * Feeds an encoded chunk to the pane's decoder, repeating delta chunks meta.dup times.
 * Re-applying a delta's motion vectors to the decoder's running reference frame is the
 * entire datamosh. The bridge chunk is dropped rather than decoded.
 *
 * @param {Object} pane
 * @param {EncodedVideoChunk} chunk
 */
function handleEncodedChunk(pane, chunk) {
    if (pane.disposed) return; // chunks can still arrive after teardown

    // Chunks come out in encode order, so a FIFO keeps each matched to its own frame
    const meta = pane.frameQueue.shift() || { dup: 1, bridge: false };
    if (DEBUG_CHUNKS) {
        console.log('pane', pane.clipIndex, chunk.type, chunk.byteLength,
                    'dup', meta.dup, meta.bridge ? 'BRIDGE(dropped)' : '', 'f', pane.timer);
    }

    if (chunk.type === 'key') {
        pane.decoder.decode(chunk);
    } else if (!meta.bridge) {
        for (let i = 0; i < meta.dup; i++) pane.decoder.decode(chunk);
    }
}


/**
 * Keeps only the newest decoded frame and closes the one it replaces, since leaked frames
 * stall the decoder. The smear accumulates inside the decoder's reference frame, so the last
 * decode of a duplicated chunk is the most deformed one.
 *
 * @param {Object} pane
 * @param {VideoFrame} frame
 */
function handleDecodedFrame(pane, frame) {
    if (pane.disposed) { frame.close(); return; }
    if (pane.latestFrame) pane.latestFrame.close();
    pane.latestFrame = frame;
}


/**
 * Closes a pane's encoder, decoder, scratch canvas, and last decoded frame. Idempotent, and
 * safe on a pane that never had a codec.
 *
 * @param {Object} pane
 */
function disposePaneCodec(pane) {
    pane.disposed = true;
    try { if (pane.encoder && pane.encoder.state !== 'closed') pane.encoder.close(); } catch (e) {}
    try { if (pane.decoder && pane.decoder.state !== 'closed') pane.decoder.close(); } catch (e) {}
    pane.encoder = pane.decoder = null;
    if (pane.encodeCanvas) {
        pane.encodeCanvas.remove();
        pane.encodeCanvas = null;
    }
    // Holding this would pin a VideoFrame for the rest of the pane's life
    if (pane.latestFrame) {
        pane.latestFrame.close();
        pane.latestFrame = null;
    }
    pane.frameQueue = [];
}


/**
 * Abandons a pane's entrance and lets it play clean. Dropping to PLAYING is also what
 * releases the input lock, since the lock is nothing more than the pane's phase.
 *
 * @param {Object} pane
 */
function failPaneEntrance(pane) {
    disposePaneCodec(pane);
    disposePaneGlitch(pane);
    pane.phase = 'PLAYING';
}


/**
 * Releases everything an evicted pane holds. Its clip is free to be warmed again afterwards.
 *
 * @param {Object} pane
 */
function disposePane(pane) {
    disposePaneCodec(pane);
    disposePaneGlitch(pane);
    discardClip(pane.video);
}


/**
 * Triangle wave: 0 -> 1 -> 0, peaking mid-transition.
 *
 * @param {number} p - progress, 0..1
 * @return {number} 0..1
 */
function triWave(p) {
    return p < 0.5 ? p * 2 : (1 - p) * 2;
}


/**
 * p5 resize handler: resizes the canvas and nudges panes back on screen. Panes keep their
 * size, since a live encoder's dimensions are fixed, so a shrunk window could otherwise
 * leave one entirely off screen.
 */
function windowResized() {
    resizeCanvas(windowWidth, windowHeight);

    // The column is sized off the window, so both its line breaks and the rows it has to
    // fill in have moved
    rebuildExifText();

    for (const pane of panes) {
        pane.x = constrain(pane.x, -pane.w * BLEED, width - pane.w * (1 - BLEED));
        pane.y = constrain(pane.y, -pane.h * BLEED, height - pane.h * (1 - BLEED));
    }
}
