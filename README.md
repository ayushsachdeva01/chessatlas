# Chess Atlas — GitHub Pages Edition

This edition is static: it does not require `server.py`.

## Publish
Upload the contents of this folder to a GitHub repository and enable GitHub Pages from the repository's Pages settings.

## Local engine
Blindfold Mode and Game Review use Stockfish 18 Lite Single-threaded in a browser Web Worker. The engine is loaded from jsDelivr on first use; no Stockfish server is required.

Stockfish.js is the browser build published as the `stockfish` npm package. See:
https://www.npmjs.com/package/stockfish

## Game Review
Game Review fetches the public Chess.com archive directly from the browser, then analyzes the PGNs locally with Stockfish. Your games are not sent to this app's server.

## Blindfold Archive
Blindfold games are stored in browser localStorage. Use Export archive / Import archive to move them between devices or browsers.

## Puzzle Lab
The original 6M+ Lichess puzzle database was intentionally NOT included. Your `puzzle_index.bin` is only useful together with the original puzzle CSV and Python random-access server, so it cannot be used by GitHub Pages by itself.

If you want Puzzle Lab on GitHub Pages later, provide the puzzle data in a browser-friendly format and it can be converted into a static dataset.

## External browser dependencies
- chess.js 0.10.3 via cdnjs
- Stockfish 18 Lite Single via jsDelivr
