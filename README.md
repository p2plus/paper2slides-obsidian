# Paper2Slides for Obsidian (WIP)

An Obsidian desktop plugin that lets you run [Paper2Slides](https://github.com/HKUDS/Paper2Slides) against a PDF or Markdown note and pull the newest outputs back into your vault.

This is still work in progress. It is already useful for testing, but not something I would call polished yet.

This is a thin integration layer, not a reimplementation. All of the actual paper-to-slides work is done by the original `HKUDS/Paper2Slides` project.

![Paper2Slides Obsidian pipeline](assets/pipeline-diagram.svg)

## Credit

Huge credit to the original Paper2Slides authors and maintainers.

- Original project: [HKUDS/Paper2Slides](https://github.com/HKUDS/Paper2Slides)
- This plugin exists to make that workflow feel less clunky inside Obsidian

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

## Dev notes

- No hardcoded personal Python path
- No assumption that your vault sits inside the Paper2Slides repo
- If your Python lives in a venv, you can still point the plugin directly at it

## Current rough edges

- This is desktop-only because it shells out to a local Python process
- The plugin assumes the upstream Paper2Slides output layout stays stable
- Community-plugin release plumbing is started here, but publishing still means packaging releases and testing on a clean vault
