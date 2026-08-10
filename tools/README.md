# Notification generator

Turns a plain-text script into iOS notification PNGs, using the `Notifications`
component set in the [iOS Notifications 2024 Figma file][file].

[file]: https://www.figma.com/design/i0W6zBe57yLxoQlFRCNndq/iOS-Notifications-2024--Community---Copy-

## The input format

Blocks separated by blank lines. Within a block, `Title:` / `Content:` start a field and
any following bare line continues it, so copy can wrap:

```
Title: Hey...
Content: hellooo? can you see this?

Title: It must frustrate you.
Content:
```

`App:` and `Time:` are also recognised per-block, overriding the defaults for that one
notification.

## Which component each block gets

The variant is chosen from which fields are non-empty:

| Block has        | Variant                                              |
| ---------------- | ---------------------------------------------------- |
| title + content  | `Title=True, Content=True, Footer=None, Theme=Light`  |
| title only       | `Title=True, Content=False, Footer=None, Theme=Light` |
| content only     | `Title=False, Content=True, Footer=None, Theme=Light` |
| neither          | skipped                                               |

`--theme Dark` and `--footer Prompt|Grouped` swap the other two axes. The set has all 18
combinations, so any pairing works.

## Running it — the plugin (no MCP required)

Creating nodes needs the Figma Plugin API. The REST API is read-only, so the build step
cannot be a plain Node script — but it *can* be a local plugin, which has no quota.

**Install once.** In the Figma desktop app: Plugins → Development → Import plugin from
manifest… → pick `tools/plugin/manifest.json`.

**Then, any time:** open the notifications file, run Plugins → Development →
Notification Generator, paste your script into the panel, set the app name / theme /
footer, and hit Generate. It creates or refills a frame called `Generated Notifications`
— re-running replaces the previous batch rather than stacking a new one beside it — then
selects and zooms to it.

Every generated card gets PNG export settings baked on, so Figma's own
Export button produces the same files the export script does.

### The app icon

Pick a PNG/JPEG/WebP in the **App icon** field and it replaces the empty icon square on
every card in the batch. This is the operation Figma's own paste-to-replace refuses: the
plugin registers the bytes with `figma.createImage()` and sets the result as an `IMAGE`
paint on the icon layer, which the UI has no equivalent for on a layer inside an
instance.

The image is downscaled to 256px in the panel before being handed over — the icon renders
at roughly 20pt, so a 1024px source would embed ~600 KB in the Figma file to fill a
60px-wide slot at 3x.

The icon layer is found **by shape, not by name** (non-text, roughly square, 12–44px),
because the file was rate-limited before its real name could be confirmed. The panel
reports which layer it landed on — check that line on the first run. If it picks wrong,
type the correct layer name into the field beside the file picker. If it finds nothing
you get `no icon-shaped layer found` per entry and the rest of the card still builds.

Any artwork nested inside the icon layer is hidden rather than deleted, so resetting the
instance in Figma restores the original.

**Export the PNGs:**

```sh
FIGMA_TOKEN=figd_... node tools/export-notifications.mjs --scale 3
```

Writes `assets/images/notifications/*.png` plus `manifest.json`, straight through the
Figma REST API. Get a token from Figma → Settings → Security → Personal access tokens,
scope **File content: read**.

If you change `lib/parse-core.js` or `figma-build.template.js`, rebuild the plugin:

```sh
node tools/build-plugin.mjs
```

`plugin/code.js` is generated — edit the sources, not it.

## Running it — the MCP route

Equivalent, but spends Figma MCP tool calls, which the Starter plan rations tightly
enough to interrupt a batch mid-run.

```sh
node tools/parse-notifications.mjs tools/notifications.txt --app "Critical Software Update"
```

Writes `tools/generated/figma-build.js` (the same builder with the parsed entries baked
in) and `tools/generated/notifications.json`. Hand the former to the `use_figma` tool for
file key `i0W6zBe57yLxoQlFRCNndq`.

## How the pieces relate

```
lib/parse-core.js ──────────┬─→ parse-notifications.mjs ─→ generated/figma-build.js  (MCP)
                            │
figma-build.template.js ────┴─→ build-plugin.mjs ─────────→ plugin/code.js           (plugin)
```

Both routes run the same parser and the same builder; only the wrapper differs. That is
why the template is restricted to the standard Plugin API — the `use_figma`-only helpers
(`figma.createAutoLayout`, `node.query`, `node.set`) would break the plugin build.

## The font situation

The component is authored in **SF Pro Text**, which is not installed on this machine, and
a missing font makes `characters` unwritable — so the build script substitutes.

Picking the substitute is less obvious than it looks. `loadFontAsync` succeeding is not
enough: macOS ships `SF Pro` and `SF Compact` as *local* fonts, which load fine in the
desktop app but are absent from Figma's render servers, so every layer using them
**exports blank**. The build script assigns a candidate and then reads `hasMissingFont`
back — `false` means the server can actually render it — and falls back until one passes.

With nothing else installed that clears the bar, labels land on **Inter** (`--font`
changes the preference). Inter is close to SF but not identical. For exact typography,
install SF Pro Text locally and pass `--font "SF Pro Text"`; the script then keeps the
authored font untouched, since Figma's servers do have it.

## Using the output in p5

`manifest.json` carries the pixel size and the source text for each card:

```js
let notifications = [];

function preload() {
  const manifest = loadJSON('assets/images/notifications/manifest.json', () => {
    for (const n of manifest.notifications) {
      notifications.push({
        ...n,
        img: loadImage('assets/images/notifications/' + n.file),
      });
    }
  });
}

function draw() {
  // cssWidth/cssHeight are the 1x logical size; the PNG is `scale` times that.
  const n = notifications[0];
  if (n && n.img) image(n.img, 20, 20, n.cssWidth, n.cssHeight);
}
```

Heights differ by variant (86pt with content, 65pt for title-only) and grow further as
copy wraps — read the height per card rather than assuming a constant.

## Export the PNGs with the REST script, not through MCP

Both paths render the same nodes, but they do not produce the same file.

`export-notifications.mjs` (REST `/v1/images`) returns what you want: corners fully
transparent, antialiased edges, and a card body at **alpha 224/255** — the translucent
iOS material, so the video shows through it rather than sitting behind an opaque plate.

The MCP `download_assets` tool composites against Figma's dark canvas instead. Its output
is **fully opaque**, with the rounded corners filled `#1E1E1E`, and each card drags a dark
rectangle onto the video with it. Measured, not assumed — the first batch came out that
way and was re-exported.
