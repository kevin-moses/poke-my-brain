#!/bin/sh
# Regenerate the clip list the sketch reads. Run after changing the contents of assets/.
# A browser cannot list a directory, so sketch.js gets its filenames from this file.
cd "$(dirname "$0")/.." || exit 1
ls assets | grep -Ei '\.(mov|mp4|m4v|webm)$' | sort > assets/manifest.txt
wc -l < assets/manifest.txt
