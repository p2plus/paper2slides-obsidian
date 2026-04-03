# Paper2Slides for Obsidian

An Obsidian desktop plugin that lets you run [Paper2Slides](https://github.com/HKUDS/Paper2Slides) against a PDF or Markdown note and pull the newest outputs back into your vault.

This is a thin integration layer, not a reimplementation. The actual paper-to-slides pipeline comes from the original `HKUDS/Paper2Slides` project.

## Credit

Huge credit to the original Paper2Slides authors and maintainers.

- Original project: [HKUDS/Paper2Slides](https://github.com/HKUDS/Paper2Slides)
- This repo focuses on the Obsidian-side glue so the workflow feels natural inside a vault

## What it does right now

- Adds a context-menu action for `.pdf` and `.md` files
- Adds a command-palette command for the current file
- Runs `python3 -m paper2slides` from your configured checkout
- Treats PDFs as `paper` content and Markdown files as `general` content
- Imports the newest generated summary, PDFs, and PNGs into `Paper2Slides/<source-file-name>/` inside your vault

## Setup

1. Clone and set up the original Paper2Slides repo
2. Install its Python dependencies and API keys
3. Run `npm install`
4. Run `npm run build`
5. Copy `manifest.json`, `main.js`, and `versions.json` into your vault under `.obsidian/plugins/paper2slides-obsidian/`
6. In Obsidian settings, set:
   - `Python command`: usually `python3`
   - `Paper2Slides repo path`: absolute path to your local Paper2Slides checkout

## Notes

- No hardcoded personal Python path
- Desktop-only, because it shells out to a local Python process
- The import step assumes the upstream Paper2Slides output layout stays broadly stable
