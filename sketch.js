const MOSH_FRAMES = 180;     // transition length in frames
const RESOLVE_FRAMES = 8;    // frames at the end spent resolving back to a clean image

const MAX_PANES = 6;        // main perf lever - simultaneous decodes
// Set high enough that the warm pool plus the live panes covers most of the library, so a
// press almost always finds a decoded clip waiting. That residency is the memory cost of
// instant entry; this is the dial to back it off.
const PREWARM = 20;          // clips kept loaded ahead of the next entry
// Chrome opens about six connections per origin, so asking for twenty clips at once just
// queues fourteen of them behind multi-megabyte downloads until they time out. Only a few
// are ever in flight; the pool fills as they land.
const WARM_CONCURRENCY = 3;  // clips fetching at once
const WARM_TIMEOUT = 30;     // seconds a clip gets to become ready before it's recycled
const RETRY_COOLDOWN = 5;    // seconds before a recycled clip may be tried again
const WARM_EVERY = 15;       // frames between pool sweeps - its thresholds are all seconds
// Wide and tall clips need different caps to look the same size. Both are fitted inside a
// box this fraction of the canvas, but on a wide canvas a tall clip is bound by height and
// so fills that fraction of the screen's long axis, while a wide clip is bound by width and
// reaches only about half the height - the same number leaves it looking much smaller.
// Most of this library displays portrait, so wide clips are the minority that needs the
// looser cap. At 0.90 a landscape pane runs 1296x728 on a 1440x900 canvas against 302x540
// for a portrait one, and a full screen of panes still leaves each about a third in view.
const MAX_SIZE = 0.6;        // tall clips fit inside this fraction of the canvas
const MAX_SIZE_WIDE = 0.9;   // ...and wide clips inside this one
const BLEED = 0.0;          // fraction of a pane allowed off each edge; 0 = fully contained
const MIN_SIZE = 64;         // don't build a codec for a sliver
const MIN_OVERLAP = 0.15;    // cover a new pane wants under it to have something to deform
const PLACEMENT_TRIES = 32;  // candidate positions scored per entry; more = tidier spacing
const COVER_EPS = 0.02;      // coverage difference below which two candidates tie

const ENCODE_BITRATE = 4_000_000; // explicit, so delta strength isn't Chrome's default
const MAX_DUP = 6;           // peak decode duplication - the smear intensity knob
const SWITCH_AT = 0.2;       // progress at which the encoder input flips to the new clip
const TS_STEP = Math.round(1e6 / 30); // microseconds per encoded frame

// The two frames the mosh turns on, derived once rather than tracked per pane with flags
const SWITCH_FRAME = Math.ceil(SWITCH_AT * MOSH_FRAMES); // first frame fed by the new clip
const RESOLVE_FRAME = MOSH_FRAMES - RESOLVE_FRAMES;      // clean keyframe lands here

// A pane settles at GLITCH_BASE once it has moshed in, and pressing its sensor rubs the
// corruption out - lightly while held, and for good once the reading passes UNGLITCH_AT.
// Every pane therefore glitches at once rather than one at a time, and the JPEG round trip
// is the cost: GLITCH_SCALE and GLITCH_EVERY_IDLE are the dials if the frame rate suffers.
// Panes cleared for good drop their buffers and stop costing anything at all.
const GLITCH_BASE = 0.4;     // corruption a pane sits at untouched
// A glitched pane is only redrawn when a pass runs, so its apparent frame rate is
// 60/cadence - this is what makes the clip underneath look slow, not the clip itself.
// Shrinking the buffer is what pays for a faster cadence: at 0.6 the encoder handles a
// third of the pixels, so 2/3 frames runs smoother than 3/6 did and still costs less.
const GLITCH_EVERY = 2;      // frames between passes on the pane being touched -> 30fps
const GLITCH_EVERY_IDLE = 3; // ...and on the ones that are not -> 20fps
const GLITCH_SCALE = 0.6;    // buffer size relative to the pane; lower is cheaper, chunkier
const GLITCH_MIN = 0.02;     // below this a pane just draws clean
const GLITCH_BYTES = 140;    // bytes randomised at full corruption, before the pane's bias

// Two FSRs on an Arduino, sending "fsr0,fsr1" a line at a time over WebSerial. Both
// squeezed moshes a new clip in; one alone corrupts a pane, harder press meaning heavier
// corruption.
const SERIAL_BAUD = 9600;    // must match the Arduino's Serial.begin()
const FSR_MAX = 120;         // the sketch maps its 12-bit reads to 0..120, not 0..127
const ACTIVE_THRESHOLD = 10; // above this a sensor counts as touched
const UNGLITCH_AT = 60;      // press this hard and the targeted pane is clean for good
// Both values ride in one line, so this is a genuine snapshot rather than two event
// streams racing - but fingers still land a moment apart, and acting on the first one
// immediately would flash a glitch on the way into every squeeze.
//
// This has to exceed one send interval, or it lapses before the line that would have
// carried the second sensor even arrives. The Arduino prints every 100ms, so anything
// under that guarantees the flash it is meant to prevent.
const SERIAL_INTERVAL = 100; // ms between lines, matching the sketch's send loop
const GESTURE_SETTLE = 150;  // ms a lone sensor waits for its partner; 0 disables

let CLIPS = [];              // filenames from assets/manifest.txt
let panes = [];              // draw order: oldest first, newest on top
let warmPool = [];           // clips loading or loaded, waiting to be handed to a pane
let deadClips = new Set();   // indices that genuinely failed to load - never tried again
let retryAt = new Map();     // clip index -> millis() before which it won't be re-warmed
let codecReady = false;
let DEBUG_CHUNKS = false;    // flip from the console to log every chunk type
let showHud = false;         // 'd' toggles the state readout

// Space is the only input, and it is shut for the length of the entrance so the bar can't
// be spammed. That is the whole lock, and it is derived rather than stored: the key is shut
// exactly while some pane is still animating in, which enteringPane() reads off the panes
// themselves. Nothing to set, nothing to clear, and no state that can outlive its pane.
//
// A press that lands before any clip has decoded latches instead of being dropped, and
// fires the moment one is ready. The latch is deliberately not part of the lock - it needs
// no timeout, because a second press while it is set is simply a no-op. The FSRs and the
// space bar both feed this one latch, so there is nothing to reconcile between them.
let pendingEntry = false;    // a press is waiting for a clip to finish decoding

let serial = null;           // p5.WebSerial, built in setup()
let portButton = null;
let portState = 'no port';   // for the HUD
let fsr = [0, 0];            // latest reading per channel
let fsrSince = [0, 0];       // millis() each channel crossed ACTIVE_THRESHOLD
let bothWasActive = false;   // so a held squeeze is one gesture rather than sixty
let bothLatched = false;     // suppresses single-sensor glitching until both are released
let linesSeen = 0;           // serial lines parsed, for the HUD and the first-line log
let badLines = 0;            // unparseable ones; only the first is reported
let lastLineAt = 0;          // last parseable reading
let lastAnyAt = 0;           // last line of any kind, including the sketch's status prints
let silenceWarned = false;
let loggedChannel = -1;      // glitch channel last reported, so logging stays on transitions

// Everything is logged on transitions, never per frame, so this can stay on. Set LOG =
// false from the console to quiet it.
//
// Not named log(): p5 exports log as the natural logarithm and binds it onto window in
// global mode, so a sketch-level function log() is silently replaced by Math.log and every
// call becomes a discarded NaN.
let LOG = true;
const SILENCE_WARN = 4;      // seconds an open-but-silent port waits before complaining

function logEvent(tag, ...args) {
    if (LOG) console.log('[' + tag + ']', ...args);
}

// p5 2.x has no preload(), but it defers draw() until an async setup() resolves
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
}


function draw() {
    background(0);

    warmClips();
    checkSerialSilence();
    applyGesture();

    if (pendingEntry) tryEnterPane();

    // Oldest first so the newest sits on top. This ordering is load-bearing: a moshing
    // pane samples the canvas after every earlier pane has drawn and before it draws
    // its own output, which is what lets it deform whatever is underneath it.
    for (const pane of panes) {
        // p5 reschedules its animation frame only after draw() returns, so an exception
        // escaping this loop stops the sketch outright, and never reaches the release
        // below. A codec closed under us throws on encode; drop that pane to clean
        // playback rather than take the sketch down with it.
        try {
            if (pane.phase === 'MOSHING') {
                runMoshFrame(pane);
            } else if (pane.glitchAmount > GLITCH_MIN) {
                runGlitchFrame(pane);
            } else {
                drawPaneClean(pane);
            }
        } catch (e) {
            // Last resort only: the codec error callbacks below already retire a pane whose
            // encoder or decoder died, so reaching here means a genuine bug rather than the
            // expected failure. Losing the whole sketch to one is the disproportionate part.
            console.error('pane frame failed - falling back to clean playback', e);
            failPaneEntrance(pane);
        }
    }

    if (showHud) drawHud();
}


// The pane still animating in, if any. At most one exists: the key is shut for exactly as
// long as this returns non-null, so a second entrance cannot start on top of the first.
function enteringPane() {
    return panes.find((p) => p.phase !== 'PLAYING') || null;
}


// Reports the resulting corruption level, not the raw pressure, since the two run opposite
// ways - and how far the press is from latching the pane clean for good.
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

// Both sensors -> mosh. One alone -> glitch. A squeeze is bracketed by two moments where
// only one sensor reads active - going in, and coming out - and each needs its own guard:
//
//   - Going in, GESTURE_SETTLE holds a lone sensor briefly to see if its partner follows.
//   - Coming out, that window is useless, because the finger still down has been active for
//     however long the squeeze lasted and so counts as long settled. bothLatched covers
//     that half: once both have been seen together, no single-sensor glitch fires until
//     both have gone quiet again.
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


// Turn the current reading into this frame's effects. Runs before the pane loop so every
// pane knows its glitch strength by the time it draws.
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

    // Press hard enough and the pane is done with corruption for the rest of its life. It
    // drops its buffers on the way out, so a cleared pane stops costing a JPEG round trip
    // as well as looking clean.
    if (target && !target.unglitched && fsr[gesture.channel] > UNGLITCH_AT) {
        target.unglitched = true;
        disposePaneGlitch(target);
        logEvent('gesture', 'FSR' + gesture.channel, 'at', fsr[gesture.channel],
                 '- cleared', CLIPS[target.clipIndex], 'for good');
    }

    // Below that, pressure only leans on the baseline while it is held: untouched sits at
    // GLITCH_BASE, harder pressure approaches clean.
    const relief = gesture.channel === -1
        ? 0
        : constrain(fsr[gesture.channel] / FSR_MAX, 0, 1);

    for (const pane of panes) {
        if (pane.unglitched) continue; // stays at 0, set when it was cleared
        pane.glitchAmount = pane === target ? GLITCH_BASE * (1 - relief) : GLITCH_BASE;
    }
}


// FSR0 takes the newest pane, FSR1 the one before it. A pane still moshing in is left
// alone: runMoshFrame owns its drawing and feeds the encoder from the canvas every frame,
// so a glitch layered on top would fight the transition.
function glitchTarget(channel) {
    if (channel === -1) return null;
    const pane = panes[panes.length - 1 - channel];
    if (!pane || pane.phase !== 'PLAYING') return null;
    return pane;
}


// ---- serial ---------------------------------------------------------------------

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
    // open() resolves either way - it swallows the failure and reports it here - so the
    // port is only genuinely open once this fires
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


// Auto-selecting ports[0] is how you end up silently connected to Bluetooth-Incoming-Port,
// which opens happily and then never sends a byte - indistinguishable from dead hardware.
// Virtual ports carry no USB vendor id, so requiring one rules them out; a known Arduino
// vendor id wins outright.
const ARDUINO_VIDS = new Set([0x2341, 0x2a03, 0x1b4f, 0x239a]);

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


function describePort(port) {
    const info = port.getInfo();
    if (info.usbVendorId === undefined) return 'virtual / non-USB (e.g. Bluetooth)';
    const hex4 = (n) => (n === undefined ? '????' : n.toString(16).padStart(4, '0'));
    const vendor = ARDUINO_VIDS.has(info.usbVendorId) ? ' (Arduino)' : '';
    return `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}${vendor}`;
}


function openPort() {
    logEvent('serial', 'opening at', SERIAL_BAUD, 'baud...');
    serial.open({ baudRate: SERIAL_BAUD }); // resolves regardless; the events report the outcome
    if (portButton) portButton.hide();
}


// The only work done per line is parsing. Everything downstream reads the latched pair, so
// a burst of lines between frames costs nothing beyond the last one winning.
function serialEvent() {
    let line = serial.readLine();
    if (!line) return;
    line = line.trim();
    if (!line) return;

    lastAnyAt = millis();

    const parts = line.split(',');
    const values = parts.map((s) => int(s));
    if (parts.length !== 2 || values.some((v) => !isFinite(v))) {
        // Not garbage, usually: the sketch narrates its BLE state on the same wire
        // ("scanning...", "connected and ready!"), and it only starts printing readings
        // once it has a peripheral. Passing those through is the fastest way to see why
        // no data is arriving. Mangled characters here would mean a baud mismatch instead.
        badLines++;
        logEvent('arduino', line);
        return;
    }

    lastLineAt = millis();
    if (linesSeen++ === 0) logEvent('serial', 'first line parsed:', line, '- data is flowing');

    for (let ch = 0; ch < 2; ch++) {
        // Stamp the moment a channel wakes up, so GESTURE_SETTLE has something to measure
        if (values[ch] > ACTIVE_THRESHOLD && fsr[ch] <= ACTIVE_THRESHOLD) fsrSince[ch] = millis();
        fsr[ch] = values[ch];
    }
}


// An open port that delivers no readings is invisible otherwise - nothing errors, the
// sketch simply never reacts. The two causes need different fixes, and which one it is
// shows in whether anything at all is coming down the wire.
function checkSerialSilence() {
    if (portState !== 'open' || silenceWarned) return;
    if (millis() - lastLineAt < SILENCE_WARN * 1000) return;
    silenceWarned = true;

    if (linesSeen === 0 && badLines === 0) {
        console.warn(`[serial] port open but completely silent for ${SILENCE_WARN}s.` +
                     ' Wrong port (Bluetooth-Incoming-Port?), wrong baud, or the board is' +
                     ' not running. Reload to pick a different port.');
    } else {
        console.warn(`[serial] the board is talking but has sent no readings for` +
                     ` ${SILENCE_WARN}s. It only prints "fsr0,fsr1" once it has connected` +
                     ' to the HeadbandMassager peripheral - see the [arduino] lines above.' +
                     ' Until then the space bar still moshes clips in.');
    }
}


function makePortButton() {
    if (portButton) { portButton.show(); return; }
    portButton = createButton('choose port');
    portButton.position(10, 10);
    portButton.mousePressed(() => {
        logEvent('serial', 'requesting port - pick the Arduino, not Bluetooth-Incoming-Port');
        serial.requestPort();
    });
}


function openPort() {
    serial.open({ baudRate: SERIAL_BAUD }).then(() => { portState = 'open'; });
    if (portButton) portButton.hide();
}


function keyPressed() {
    if (key === 'd' || key === 'D') {
        showHud = !showHud;
        return;
    }
    if (key !== ' ') return;
    if (!enteringPane()) pendingEntry = true;
    return false; // don't let space scroll the page
}


// Press 'd'. The pool counts are the ones that matter: "ready 0" with a full pool means
// clips are loading too slowly, while a climbing "dead" count means they are failing
// outright and the manifest is pointing at something the browser won't play.
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
        'lines ' + linesSeen + (badLines ? '  bad ' + badLines : '') +
            (portState === 'open' ? '  last ' + nf((millis() - lastLineAt) / 1000, 1, 1) + 's' : ''),
        'gesture ' + gestureLabel(),
    ];

    push();
    noStroke();
    fill(0, 200);
    rect(8, 8, 230, lines.length * 16 + 12);
    fill(255);
    textFont('monospace');
    textSize(12);
    textAlign(LEFT, TOP);
    for (let i = 0; i < lines.length; i++) text(lines[i], 16, 14 + i * 16);
    pop();
}


// drawImage on the raw element rather than p5's image(): p5 routes a MediaElement through
// an internal full-resolution canvas that it re-copies every frame, which is a wasted
// 1920x1080 blit per pane per frame just to draw it scaled down.
function drawPaneClean(pane) {
    drawingContext.drawImage(pane.video.elt, pane.x, pane.y, pane.w, pane.h);
}


// ---- lazy clip loading ---------------------------------------------------------

// Only ever PREWARM + MAX_PANES video elements exist at once, however large the library
// gets. Elements are built on demand and destroyed when their pane leaves.

// Decoded far enough to be measured and drawn
function clipReady(v) {
    return v.elt.videoWidth > 0 && v.elt.readyState >= 2;
}


// Positions in warmPool of the clips that could enter right now
function readySlots() {
    const slots = [];
    for (let i = 0; i < warmPool.length; i++) {
        if (clipReady(warmPool[i])) slots.push(i);
    }
    return slots;
}


// Take a clip out of the warm pool. Permanently if it will never play, otherwise on a
// cooldown, so a clip that was merely slow gets another chance later.
function dropWarmClip(slot, permanent) {
    const v = warmPool[slot];
    if (permanent) deadClips.add(v.__clipIndex);
    else retryAt.set(v.__clipIndex, millis() + RETRY_COOLDOWN * 1000);
    discardClip(v);
    warmPool.splice(slot, 1);
}


// Every threshold here is measured in seconds, so running this every frame buys nothing -
// it just rescans the pool sixty times a second to notice something that changes once in a
// while. Entry does not go through here, so pressing space stays instant either way.
function warmClips() {
    if (frameCount % WARM_EVERY !== 0) return;

    // Only a genuine load failure is permanent. Note it is networkState, not elt.error,
    // that reports a missing file: p5 builds the element with <source> children, so a 404
    // fires on the source and leaves elt.error null. The grace period avoids reading
    // NO_SOURCE before the source has been attached.
    //
    // A clip that is merely slow is a different case, and the timeout only ever applies to
    // one that is still not ready: entry is now driven by the space bar, so a ready clip
    // legitimately waits in the pool for as long as it takes the viewer to press it. Ageing
    // those out - and worse, writing them off for good - drains the pool to nothing and the
    // key goes dead. A slow clip is recycled on a cooldown and tried again later instead.
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
        v.hide();               // Hide the default HTML player
        v.elt.muted = true;     // an unmuted element can't autoplay without a gesture
        v.elt.preload = 'auto';
        v.__clipIndex = index;
        v.__warmedAt = now;
        warmPool.push(v);
        loading++;
    }
}


// Which clips are spoken for is not tracked separately - it is exactly what the warm pool
// and the live panes are holding, so it is read off them rather than maintained alongside
// them and kept in step by hand.
function pickUnclaimedIndex() {
    const now = millis();
    const taken = new Set(warmPool.map((v) => v.__clipIndex));
    for (const p of panes) taken.add(p.clipIndex);

    const free = [];
    for (let i = 0; i < CLIPS.length; i++) {
        if (taken.has(i) || deadClips.has(i)) continue;
        // Cooldowns are cleared as they lapse, so retryAt only ever holds clips still waiting
        if (retryAt.has(i)) {
            if (now < retryAt.get(i)) continue;
            retryAt.delete(i);
        }
        free.push(i);
    }
    return free.length ? random(free) : -1;
}


// Detach the element and drop its buffers, rather than leaving it parked in the DOM
function discardClip(v) {
    const elt = v.elt;
    try { elt.pause(); } catch (e) {}
    elt.loop = false;
    while (elt.firstChild) elt.removeChild(elt.firstChild); // drop the <source> children
    try { elt.load(); } catch (e) {}  // aborts any in-flight fetch and frees decoded data
    v.remove();
}


// ---- pane entry ----------------------------------------------------------------

// Runs only while a press is pending, and returns without clearing it if nothing is ready
// yet - the next frame tries again, and the key stays locked in the meantime.
function tryEnterPane() {
    // Any clip that has decoded far enough to be measured and drawn is fair game; pick
    // one at random rather than taking warmPool[0], which with a 20-deep pool would just
    // serve them in the order they happened to warm.
    const ready = readySlots();
    if (!ready.length) return;

    const slot = random(ready);
    const video = warmPool[slot];
    // Sizing first: it depends only on the clip, so an unusable one is discovered before
    // anything has been evicted on its behalf
    const dims = paneDims(video);
    if (!dims) { // unusable dimensions - don't let it block the pool
        dropWarmClip(slot, true);
        return; // still pending: the retry picks another clip
    }
    warmPool.splice(slot, 1);

    // Evict before placing, so the departing pane's area reads as free space and the
    // newcomer can take it. It also has to happen before the pane loop runs, so the
    // incoming mosh samples the canvas after the departure rather than deforming pixels
    // that are about to vanish.
    if (panes.length >= MAX_PANES) {
        logEvent('pane', 'at max, evicting oldest:', CLIPS[panes[0].clipIndex]);
        disposePane(panes[0]);
        panes.shift();
    }

    const rect = placeRect(dims.w, dims.h);

    // Nothing leaves on its own any more - every clip loops until it is evicted
    video.elt.loop = true;
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
        glitchOffset: panes.length % GLITCH_EVERY_IDLE, // stagger passes across panes
        glitchStyle: rollGlitchStyle(),     // this clip's own flavour of corruption
    };

    // Every pane moshes in. Without WebCodecs there is nothing to mosh with, so the pane
    // just appears - the same graceful degradation setupCodecs() warns about.
    if (codecReady) {
        initPaneCodec(pane);
        pane.phase = 'MOSHING';
    }

    panes.push(pane);
    pendingEntry = false; // from here the pane's own phase holds the key shut

    const style = pane.glitchStyle;
    logEvent('pane', 'entered', CLIPS[pane.clipIndex],
        `${rect.w}x${rect.h} at ${rect.x},${rect.y}`,
        'cover ' + nf(rect.cover, 1, 2),
        pane.phase === 'MOSHING' ? '- moshing in' : '- no codec, appearing clean',
        `(${panes.length}/${MAX_PANES} panes)`,
        `| glitch q${nf(style.quality, 1, 2)} start${nf(style.start, 1, 2)}` +
        ` x${nf(style.bytes, 1, 2)} ${style.solid === undefined ? 'static' : 'band' + style.solid}` +
        ` every ${style.cadence}`);
}


// Fit the clip inside a box sized for its orientation, so wide and tall clips read at
// comparable scale rather than the wide ones looking shrunken.
//
// These are display dimensions, not the ones in the file: most of this library was shot
// portrait and stored 1920x1080 with a rotation flag, and the browser has already applied
// that by the time videoWidth reads non-zero. Trust it over what the file says.
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


// A flat random x/y lets a pane land almost exactly on the one before it. Instead, sample
// a handful of positions and take the emptiest, scored by how much of the candidate is
// already covered.
//
// Whitespace is not the whole goal though: a mosh deforms what is under the rect, and a
// candidate sitting on bare canvas has only flat background to tear up, which reads as a
// near-empty rectangle for the whole transition. The rule is therefore the emptiest
// candidate that still has something to chew on - the least-covered position clearing
// MIN_OVERLAP, falling back to the least-covered overall when the canvas is near empty and
// nothing qualifies. That fallback is what the very first pane of a session gets.
//
// Coverage alone is degenerate for the wide rects, where whole bands of positions score
// identically, so distance to the nearest pane centre breaks near-ties and spreads them out.
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


// Less covered wins; within COVER_EPS the two are treated as equally empty and the one
// further from its nearest neighbour wins instead.
function emptier(a, b) {
    if (Math.abs(a.cover - b.cover) > COVER_EPS) return a.cover < b.cover;
    return a.spread > b.spread;
}


function nearestPaneDistance(rect) {
    if (!panes.length) return Infinity;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    let nearest = Infinity;
    for (const p of panes) {
        nearest = Math.min(nearest, dist(cx, cy, p.x + p.w / 2, p.y + p.h / 2));
    }
    return nearest;
}


// VP8 requires even dimensions.
function evenFloor(v) {
    return Math.max(2, Math.floor(v / 2) * 2);
}


// How much of rect is already covered by existing panes. Overlapping panes double-count,
// hence the clamp - this only feeds a threshold test.
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

// Every switch in here is a pure function of the frame counter, so the pane carries no
// flags to keep in step with it.
function runMoshFrame(pane) {
    pane.timer++;
    const progress = pane.timer / MOSH_FRAMES;
    const resolving = pane.timer > RESOLVE_FRAME;
    const useB = pane.timer >= SWITCH_FRAME;

    // Duplication must stay at 1 until the switch. Duplicating the underlying region's
    // own deltas corrupts the reference frame before the new clip arrives, so the
    // bridge-drop below has nothing coherent left to deform.
    const dup = (!useB || resolving)
        ? 1
        : 1 + Math.round(triWave(progress) * (MAX_DUP - 1));

    // The very first chunk encoded from the new clip is a keyframe in all but name: it
    // carries the whole scene change as residual (25-110KB vs 1-12KB for a normal
    // delta). Decoding it lands us on the clean clip and there is no mosh. Dropping it
    // leaves the decoder holding the underlying pixels for the clip's motion to tear up.
    const isBridge = pane.timer === SWITCH_FRAME;

    // Frame one seeds the decoder with the pixels already under the rect. The second
    // keyframe lands the clean image early enough to be decoded and on screen before the
    // pane hands back to drawing the clip directly.
    const keyFrame = pane.timer === 1 || pane.timer === RESOLVE_FRAME;

    const ctx = pane.encodeCanvas.drawingContext;

    if (!useB) {
        // Sample what is already on canvas inside this rect. The main canvas backing
        // store IS pixelDensity-scaled, so the source rect has to be scaled to match.
        // A bleeding pane reads partly off-canvas, so prefill with the background colour
        // rather than leaving those pixels transparent.
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

// Rolled once per pane, so the same clip never comes back looking the same way twice and
// no two panes on screen corrupt alike. The axes are chosen to be visibly different from
// each other rather than four variations of the same speckle:
//
//   quality  - JPEG quality, so damage lands in fat blocks or fine grain
//   start    - how deep into the file corruption may reach at full strength. Low numbers
//              are near the header, where damage takes the colour and structure of the
//              whole frame with it; high numbers only disturb the tail of the image.
//   bytes    - how much damage, against the shared GLITCH_BYTES budget
//   solid    - the replacement byte. p5.glitch reuses one value for every byte in a pass
//              (it reassigns replaceVal inside its own loop), so a fixed value here is
//              steady banding while leaving it undefined re-rolls each pass and flickers
//   cadence  - how frantic the churn is when the pane is left alone
function rollGlitchStyle() {
    return {
        quality: random(0.35, 0.95),
        start: random(0.04, 0.30),
        bytes: random(0.5, 1.8),
        solid: random() < 0.35 ? Math.floor(random(256)) : undefined,
        cadence: Math.floor(random(GLITCH_EVERY_IDLE, GLITCH_EVERY_IDLE + 3)),
    };
}


// Built once a pane first needs to corrupt and kept for its life. Pressure now swings
// through zero and back constantly, and tearing these down every time a sensor bottoms out
// would rebuild an encoder and a full-size buffer on every release.
function ensureGlitch(pane) {
    if (pane.glitch) return;

    pane.glitch = new Glitch();
    pane.glitch.loadType('jpg');
    // Corrupting JPEG bytes routinely yields a file the decoder rejects outright, which
    // is the technique working, not a fault. p5.glitch logs a line for each one.
    pane.glitch.errors(false);
    // Quality has to be set before any loadImage, since it is what the re-encode uses.
    // Low quality means fat DCT blocks, so damage spreads in slabs rather than specks.
    pane.glitch.loadQuality(pane.glitchStyle.quality);
    // A p5.Image and not a p5.Graphics: p5.glitch gates on hasOwnProperty('width'), which
    // a p5 2.x Graphics fails because width sits on the prototype. Working around that cost
    // a whole-frame copy per pass. A p5.Image owns width and exposes drawingContext, so it
    // is drawn into directly and handed over as-is.
    pane.glitchBuffer = createImage(Math.max(2, Math.round(pane.w * GLITCH_SCALE)),
                                    Math.max(2, Math.round(pane.h * GLITCH_SCALE)));
}


// Corrupts the clip's own bytes, as far as the pane's current level asks for.
function runGlitchFrame(pane) {
    ensureGlitch(pane);

    // Every pane is corrupting now, not one at a time, so the passes are spread out two
    // ways: the pane being touched refreshes fastest because it is the one being watched,
    // and the per-pane offset keeps them all from landing on the same frame.
    const style = pane.glitchStyle;
    const cadence = pane.glitchAmount < GLITCH_BASE ? GLITCH_EVERY : style.cadence;
    if ((frameCount + pane.glitchOffset) % cadence === 0) {
        const buf = pane.glitchBuffer;
        buf.drawingContext.drawImage(pane.video.elt, 0, 0, buf.width, buf.height);
        pane.glitch.loadImage(buf);
        pane.glitch.resetBytes();
        // limits must be set before randomBytes - they define the range it draws from.
        // Corrupting earlier in the file is more destructive, so more corruption lowers
        // the start, and each pane has its own floor for how deep it is willing to go.
        pane.glitch.limitBytes(map(pane.glitchAmount, 0, 1, 1.0, style.start));
        const bytes = Math.floor(pane.glitchAmount * GLITCH_BYTES * style.bytes);
        // undefined here lets p5.glitch pick the value, which it re-rolls each pass
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


// A p5.Image has no remove() - dropping the reference is the whole teardown
function disposePaneGlitch(pane) {
    pane.glitch = null;
    pane.glitchBuffer = null;
    pane.glitchAmount = 0; // so a torn-down pane draws clean rather than re-arming itself
}


// ---- codecs --------------------------------------------------------------------

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


// Each pane gets its own encoder/decoder sized to its rect, since every pane is a
// different size and VideoEncoder dimensions are fixed at configure time.
function initPaneCodec(pane) {
    pane.encodeCanvas = createGraphics(pane.w, pane.h);
    // Required: createGraphics inherits the sketch's density (2 on retina), which would
    // hand the encoder a frame twice the size it was configured for. Chrome does not
    // throw - it silently encodes blank frames.
    pane.encodeCanvas.pixelDensity(1);

    // A dead codec is retired here, where the failure is reported, rather than being left
    // for the next encode() to throw on and the draw loop to catch a frame later
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


// Decoding the same delta chunk repeatedly re-applies its motion vectors to the
// decoder's running reference frame. That is the entire datamosh.
function handleEncodedChunk(pane, chunk) {
    if (pane.disposed) return; // chunks can still arrive after teardown

    // Chunks come out in encode order, so a FIFO keeps each one matched to the frame
    // it came from rather than to whatever the pane happens to hold now
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


// Only the newest frame is kept: the smear accumulates inside the decoder's reference
// frame, so the last decode of a duplicated chunk is the most deformed one.
function handleDecodedFrame(pane, frame) {
    if (pane.disposed) { frame.close(); return; }
    if (pane.latestFrame) pane.latestFrame.close(); // leaks stall the decoder
    pane.latestFrame = frame;
}


function disposePaneCodec(pane) {
    pane.disposed = true;
    try { if (pane.encoder && pane.encoder.state !== 'closed') pane.encoder.close(); } catch (e) {}
    try { if (pane.decoder && pane.decoder.state !== 'closed') pane.decoder.close(); } catch (e) {}
    pane.encoder = pane.decoder = null;
    if (pane.encodeCanvas) {
        pane.encodeCanvas.remove();
        pane.encodeCanvas = null;
    }
    // Once the mosh is over the pane draws its clip directly, so holding the last
    // decoded frame would pin a VideoFrame for the rest of the pane's life
    if (pane.latestFrame) {
        pane.latestFrame.close();
        pane.latestFrame = null;
    }
    pane.frameQueue = [];
}


// Abandon the entrance and let the pane play clean. Both teardowns are idempotent and safe
// on a pane that never held that resource, and dropping to PLAYING is also what releases
// the key, since the key is shut on nothing more than the pane's phase.
function failPaneEntrance(pane) {
    disposePaneCodec(pane);
    disposePaneGlitch(pane);
    pane.phase = 'PLAYING';
}


function disposePane(pane) {
    disposePaneCodec(pane);
    disposePaneGlitch(pane);
    discardClip(pane.video); // the clip is free to be warmed again later
}


// 0 -> 1 -> 0, peaking mid-transition
function triWave(p) {
    return p < 0.5 ? p * 2 : (1 - p) * 2;
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    // Panes keep their size (a live encoder's dimensions are fixed), but a shrunk window
    // could leave them entirely off screen. Keep at least the bleed margin on canvas.
    for (const pane of panes) {
        pane.x = constrain(pane.x, -pane.w * BLEED, width - pane.w * (1 - BLEED));
        pane.y = constrain(pane.y, -pane.h * BLEED, height - pane.h * (1 - BLEED));
    }
}
