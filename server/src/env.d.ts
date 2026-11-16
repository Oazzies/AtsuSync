// WebTorrent ships no type declarations; torrent.ts types the few members it uses.
declare module 'webtorrent' {
  const WebTorrent: unknown;
  export default WebTorrent;
}
