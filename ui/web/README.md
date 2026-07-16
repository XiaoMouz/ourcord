# OurCord Website

The public landing page for [ourcord.mou.best](https://ourcord.mou.best). It contains a single responsive hero and links to the current Windows public beta.

## Development

Requires Node.js 24.

```bash
npm install
npm run dev
npm test
```

The site is built with vinext and deployed through Sites. Runtime storage is intentionally disabled in `.openai/hosting.json`; authentication and application data remain in the separate control and service Workers.
