# OurCord Website

The public landing page for [ourcord.mou.best](https://ourcord.mou.best). It contains a single responsive hero and links to the current Windows public beta.

## Development

Requires Node.js 24.

```bash
npm install
npm run dev
npm test
```

The site is built with vinext and versioned through Sites. The production apex
is deployed with `npm run deploy:apex`. The command downloads the current
Windows installer from the authenticated private GitHub release into the static
assets, renames it to the stable public filename, and then binds the validated
build to `ourcord.mou.best` through Cloudflare Workers. The Desktop public beta
workflow performs the same deployment directly from its freshly built Actions
artifact and verifies the public SHA-256 before succeeding. Installer binaries
are not committed to Git. Runtime storage is intentionally disabled;
authentication and application data remain in the separate control and service
Workers.
