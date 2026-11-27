const paths = {
  voice: "M3 9h4l5-4v14l-5-4H3z M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  text: "M10 3 6 21m12-18-4 18M4 8h17M3 16h17",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11a7 7 0 0 0 14 0m-7 7v4m-4 0h8",
  micOff: "M3 3l18 18M9 9v3a3 3 0 0 0 5 2M10 3a3 3 0 0 1 5 2v5M5 11a7 7 0 0 0 12 5m2-5-.2 1M12 18v4m-4 0h8",
  phones: "M3 15v-3a9 9 0 0 1 18 0v3M3 13h4v7H5a2 2 0 0 1-2-2zm18 0h-4v7h2a2 2 0 0 0 2-2z",
  phonesOff: "M3 3l18 18M3 15v-3a9 9 0 0 1 2-6m4-3a9 9 0 0 1 12 9v3M3 13h4v7H5a2 2 0 0 1-2-2zm14 4v3h2",
  leave: "M3 15c4-7 14-7 18 0l-3 3-3-2v-2a13 13 0 0 0-6 0v2l-3 2z",
  people: "M12 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5",
  chat: "M21 12a8 8 0 0 1-8 8H8l-5 2 1-6a8 8 0 0 1 7-12h2a8 8 0 0 1 8 8Z",
  plus: "M12 5v14M5 12h14",
  join: "M13 4h7v16h-7m-3-13 5 5-5 5m5-5H3",
  send: "m3 3 18 9-18 9 3-9zm3 9h15",
  settings: "M3 7h4m7 0h7M3 17h10m6 0h2M13 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0m6 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  attach: "m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 1 1-7-7l10-10m-7 12 8-8",
} as const;

export default function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="channel-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
