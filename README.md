# MAXINE! Studio

A desktop app that converts fonts for the Chyron MAXINE! and other iNFiNiT! series character generators.

![Comic Sans on a Sony CRT, with the MAXINE! control screen beside it](docs/maxine-crt.jpg)

## Preview a font

Choose any font installed on your computer, or drop in a TTF, OTF or TTC file. 

![Previewing a font before converting](docs/preview.png)

## Convert it

Set the size, and add a border or a border with a drop shadow. The result appears next
to the original. The edge shows in red.

To make a set of sizes, like the original MAXINE! bitmap fonts, choose how many sizes to
add above and below yours, and the amount of scanlines to increment/decrement.

![The source font next to the converted font](docs/compare.png)

## Send it to the MAXINE!

Connect to the unit over FTP to upload fonts.
Fonts are grouped by typeface, with a twirl-down to show every size. Each is marked
when it's on the unit. 

![Managing fonts on the Upload tab, connected to a local test server](docs/upload.png)

## Get the app

[Download the latest release](https://github.com/jdanna/MaxineStudio/releases/latest) for Mac,
Windows or Linux. Builds aren't signed, so your system may warn you or refuse to open
the app at first.

To build it yourself, install [Node.js](https://nodejs.org) and run one of these. The
installer lands in `dist/`.

```sh
npm install
npm run dist:mac      # or dist:win, dist:linux
```

## More

The file format and research notes are in [CLAUDE.md](CLAUDE.md), the test plan is in
[experiments/MANIFEST.md](experiments/MANIFEST.md), and the command-line tools are in
[tools/](tools/).

This is an independent preservation project, not affiliated with Chyron.
