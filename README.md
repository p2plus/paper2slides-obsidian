# Paper2Slides for Obsidian (WIP)

An Obsidian desktop plugin for kicking off [Paper2Slides](https://github.com/HKUDS/Paper2Slides) from inside your vault and pulling the newest outputs back in.

This is still WIP. It already works well enough for testing, but it is not polished yet.

The plugin does not generate slides by itself. It just hands the selected file to a local `Paper2Slides` checkout and lets the upstream pipeline do the real work.

![Paper2Slides Obsidian pipeline](assets/pipeline-diagram.svg)

## Use it in 30 seconds

1. Get the original `Paper2Slides` repo running on your machine
2. Make sure its Python deps, API keys, and CLI are working
3. Open this plugin's settings in Obsidian
4. Set `Python command`, usually `python3`
5. Set `Paper2Slides repo path` to your local checkout
6. Right-click a PDF or Markdown file in the vault
7. Run `Generate Slides/Poster (Paper2Slides)`
8. Open `Paper2Slides/<source-file-name>/` in your vault

If the upstream `Paper2Slides` setup is broken, this plugin will not produce anything either.

## What happens under the hood

- PDF files run in `paper` mode
- Markdown files run in `general` mode
- The plugin starts `python3 -m paper2slides`
- `Paper2Slides` handles parsing, summary, planning, and generation
- The plugin imports the newest summary, PDFs, and PNGs back into the vault

Example:
Right-click `paper.pdf` or `notes.md`, run `Generate Slides/Poster (Paper2Slides)`, then check `Paper2Slides/paper/` or `Paper2Slides/notes/`.

## Setup

1. Clone the original `Paper2Slides` repo
2. Install its dependencies and configure its `.env`
3. Run `npm install`
4. Run `npm run build`
5. Copy `manifest.json`, `main.js`, and `versions.json` into `.obsidian/plugins/paper2slides-obsidian/`
6. Enable the plugin in Obsidian

## Current state

- Desktop-only, because it shells out to local Python
- No hardcoded personal Python path
- Assumes the upstream `Paper2Slides` output layout stays roughly stable
- Good for testing, not ready to call finished

## Credit

This repo only covers the Obsidian side of the workflow.

- Original project: [HKUDS/Paper2Slides](https://github.com/HKUDS/Paper2Slides)
- The actual slide generation pipeline lives there
